import { notificationV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { agentErrors } from '../../application/agents/agent-errors';
import { type InvitationSender, InvitationSendFailedError } from '../../application/agents/agent.ports';

/** Seul modèle que notification accepte de cleaning en appel direct. */
export const INVITATION_TEMPLATE = 'cleaning.agent_invitation';

/** Pannes de notification : injoignable, coupe-circuit ouvert, échéance dépassée. */
const OUTAGE_KINDS = ['UNAVAILABLE', 'DEADLINE_EXCEEDED'];

const DAY = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Africa/Porto-Novo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** Lien d'inscription : adresse de l'application agent, puis l'identifiant de l'invitation. */
export function invitationLink(agentAppUrl: string, invitationId: string): string {
  return `${agentAppUrl.replace(/\/+$/, '')}/invitations/${invitationId}`;
}

/**
 * Clé d'idempotence de l'envoi chez notification : préfixée (les clés y sont communes à tous les
 * appelants), une par tentative d'une invitation.
 */
export function invitationSendKey(invitationId: string, attempt: number): string {
  return `cleaning:agent_invitation:${invitationId}:${attempt}`;
}

/**
 * Invitation d'un agent envoyée par notification (SendNotification, R-AG-02) : WhatsApp, puis SMS.
 * La personne invitée n'a pas encore de compte : son numéro ne passe que dans cet appel, jamais dans
 * un événement ni un journal. Par le GrpcCaller du kit : jeton de service, échéance, coupe-circuit,
 * et une nouvelle tentative (l'appel est idempotent par sa clé).
 *
 * notification injoignable, ou envoi déjà en cours avec cette clé : NOTIFICATION_UNAVAILABLE, à
 * rejouer avec la même tentative. Tous les canaux en échec (NOTIFICATION_CHANNELS_EXHAUSTED, ou
 * réponse « échec ») : InvitationSendFailedError, à rejouer avec la tentative suivante. Les autres
 * refus de notification passent tels quels.
 */
export class NotificationInvitationSender implements InvitationSender {
  constructor(
    private readonly client: notificationV1.NotificationServiceClient,
    private readonly caller: GrpcCaller,
    private readonly agentAppUrl: string,
  ) {}

  async send(input: {
    invitationId: string;
    attempt: number;
    phone: string;
    expiresAt: Date;
  }): Promise<void> {
    let response: notificationV1.SendNotificationResponse;
    try {
      response = await this.caller.call(
        'sendNotification',
        (metadata) =>
          this.client.sendNotification(
            {
              templateCode: INVITATION_TEMPLATE,
              channel: notificationV1.Channel.CHANNEL_WHATSAPP,
              fallbackChannels: [notificationV1.Channel.CHANNEL_SMS],
              recipient: { userId: '', phoneE164: input.phone, email: '' },
              variables: {
                link: invitationLink(this.agentAppUrl, input.invitationId),
                expires_on: DAY.format(input.expiresAt),
              },
              priority: notificationV1.Priority.PRIORITY_NORMAL,
              idempotencyKey: invitationSendKey(input.invitationId, input.attempt),
              locale: 'fr',
              ttlSeconds: 0,
            },
            metadata,
          ),
        { idempotent: true },
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === 'NOTIFICATION_CHANNELS_EXHAUSTED') throw new InvitationSendFailedError();
      if (OUTAGE_KINDS.includes(error.kind) || error.code === 'NOTIFICATION_ALREADY_IN_PROGRESS') {
        throw agentErrors.dependencyUnavailable('notification');
      }
      throw error;
    }
    if (response.status === notificationV1.DeliveryStatus.DELIVERY_STATUS_FAILED) {
      throw new InvitationSendFailedError();
    }
  }
}
