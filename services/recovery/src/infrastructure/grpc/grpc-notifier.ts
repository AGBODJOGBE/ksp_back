import { notificationV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type DebtorChannel, type DebtorMessage, type Notifier } from '../../application/ports';
import { RecoveryErrors } from '../../application/shared/errors';
import { callDependency } from './dependency';

/**
 * Modèles directs au débiteur chez notification. notification limite chaque appelant à ses propres
 * modèles : recovery n'envoie que des `recovery.*` (NOTIFICATION_CALLER_FORBIDDEN sinon). Le code
 * d'accès est un modèle secret, envoyé par le modèle d'authentification WhatsApp.
 */
export const DEBTOR_TEMPLATES: Readonly<Record<DebtorMessage, string>> = {
  access_code: 'recovery.debtor_access_code',
  mandate_notice: 'recovery.debtor_mandate_notice',
  reminder: 'recovery.debtor_reminder',
  installment_reminder: 'recovery.debtor_installment_reminder',
  payment_link: 'recovery.debtor_payment_link',
  plan_confirmed: 'recovery.debtor_plan_confirmed',
  formal_notice: 'recovery.debtor_formal_notice',
  settlement_certificate: 'recovery.debtor_settlement_certificate',
  dispute_received: 'recovery.debtor_dispute_received',
};

/**
 * Préfixe des clés d'idempotence : les clés de SendNotification sont communes à tous les appelants
 * et le rejeu se fait sur la clé seule. Sans préfixe, une collision rendrait la réponse d'un autre
 * envoi sans rien envoyer.
 */
export const IDEMPOTENCY_PREFIX = 'recovery:';

export function notificationKey(key: string): string {
  return key.startsWith(IDEMPOTENCY_PREFIX) ? key : `${IDEMPOTENCY_PREFIX}${key}`;
}

const CHANNELS: Record<DebtorChannel, notificationV1.Channel> = {
  whatsapp: notificationV1.Channel.CHANNEL_WHATSAPP,
  email: notificationV1.Channel.CHANNEL_EMAIL,
};

/**
 * Messages directs au débiteur par notification (SendNotification, ADR-061). Le canal est un
 * paramètre (WhatsApp au téléphone, ou e-mail) ; l'autre canal sert de repli si sa coordonnée est
 * connue. Les coordonnées ne passent que dans cet appel, jamais dans un événement ni un journal.
 * Idempotent par clé chez notification (clé toujours préfixée par « recovery: »).
 */
export class GrpcNotifier implements Notifier {
  constructor(
    private readonly client: notificationV1.NotificationServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async sendToDebtor(input: Parameters<Notifier['sendToDebtor']>[0]): Promise<{
    notificationId: string;
    status: string;
  }> {
    const template = DEBTOR_TEMPLATES[input.message];
    if (!template) throw RecoveryErrors.invalid('message', 'Modèle de message inconnu.');
    const coordinates: Record<DebtorChannel, string | null> = { whatsapp: input.phone, email: input.email };
    if (!coordinates[input.channel]) {
      throw RecoveryErrors.invalid('channel', 'Aucune coordonnée du débiteur pour ce canal.');
    }
    const fallback = (Object.keys(CHANNELS) as DebtorChannel[]).filter(
      (channel) => channel !== input.channel && coordinates[channel],
    );
    const res = await callDependency<notificationV1.SendNotificationResponse>(
      'notification',
      this.caller,
      'sendNotification',
      (metadata) =>
        this.client.sendNotification(
          {
            templateCode: template,
            channel: CHANNELS[input.channel],
            fallbackChannels: fallback.map((channel) => CHANNELS[channel]),
            recipient: { userId: '', phoneE164: input.phone ?? '', email: input.email ?? '' },
            variables: input.variables,
            priority: notificationV1.Priority.PRIORITY_NORMAL,
            idempotencyKey: notificationKey(input.idempotencyKey),
            locale: 'fr',
            ttlSeconds: 0,
          },
          metadata,
        ),
      { idempotent: true },
    );
    return { notificationId: res.notificationId, status: String(res.status) };
  }
}
