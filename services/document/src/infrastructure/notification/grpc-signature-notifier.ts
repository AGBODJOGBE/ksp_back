import { notificationV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { DocumentErrors } from '../../application/errors';
import { type Contact, type SignatureNotifier } from '../../application/ports';
import { type CodeChannel } from '../../domain/signature';
import { callDependency } from '../dependencies';

const { Channel, Priority } = notificationV1;

/** Modèles de notification du service document (notification.proto). Modèles secrets. */
export const SIGNATURE_CODE_TEMPLATE = 'document.signature_code';
export const SIGNATURE_REQUEST_TEMPLATE = 'document.signature_requested';

/** WhatsApp si un numéro est connu, l'e-mail (adresse vérifiée) en repli ; e-mail seul sinon. */
function plan(contact: Contact): { channel: notificationV1.Channel; fallbacks: notificationV1.Channel[] } {
  if (contact.phoneE164) {
    return { channel: Channel.CHANNEL_WHATSAPP, fallbacks: contact.email ? [Channel.CHANNEL_EMAIL] : [] };
  }
  if (contact.email) return { channel: Channel.CHANNEL_EMAIL, fallbacks: [] };
  throw DocumentErrors.signerUnreachable();
}

function channelName(channel: notificationV1.Channel): CodeChannel {
  if (channel === Channel.CHANNEL_EMAIL) return 'email';
  if (channel === Channel.CHANNEL_SMS) return 'sms';
  return 'whatsapp';
}

/**
 * Envoi des messages de signature par appel direct à notification (SendNotification, jeton de
 * service ; document est un appelant autorisé). Le code et le lien sont des secrets : modèles
 * secrets côté notification, jamais journalisés ici. Clé d'idempotence : le code, ou la demande.
 */
export class GrpcSignatureNotifier implements SignatureNotifier {
  constructor(
    private readonly client: notificationV1.NotificationServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async sendCode(input: {
    codeId: string;
    contact: Contact;
    code: string;
    expiresInMinutes: number;
    documentTitle: string;
    ttlSeconds: number;
  }): Promise<{ channel: CodeChannel }> {
    return this.send({
      templateCode: SIGNATURE_CODE_TEMPLATE,
      contact: input.contact,
      variables: {
        code: input.code,
        expires_in_minutes: String(input.expiresInMinutes),
        document_title: input.documentTitle,
      },
      idempotencyKey: `document.code:${input.codeId}`,
      ttlSeconds: input.ttlSeconds,
      priority: Priority.PRIORITY_HIGH,
    });
  }

  async sendInvitation(input: {
    requestId: string;
    contact: Contact;
    firstName: string;
    documentTitle: string;
    link: string;
    expiresOn: string;
  }): Promise<{ channel: CodeChannel }> {
    return this.send({
      templateCode: SIGNATURE_REQUEST_TEMPLATE,
      contact: input.contact,
      variables: {
        ...(input.firstName ? { first_name: input.firstName } : {}),
        document_title: input.documentTitle,
        link: input.link,
        expires_on: input.expiresOn,
      },
      idempotencyKey: `document.invitation:${input.requestId}`,
      ttlSeconds: 0,
      priority: Priority.PRIORITY_NORMAL,
    });
  }

  private async send(input: {
    templateCode: string;
    contact: Contact;
    variables: Record<string, string>;
    idempotencyKey: string;
    ttlSeconds: number;
    priority: notificationV1.Priority;
  }): Promise<{ channel: CodeChannel }> {
    const route = plan(input.contact);
    const request: notificationV1.SendNotificationRequest = {
      templateCode: input.templateCode,
      channel: route.channel,
      fallbackChannels: route.fallbacks,
      recipient: {
        userId: input.contact.userId ?? '',
        // Seules les coordonnées des canaux prévus sont transmises.
        phoneE164: route.channel === Channel.CHANNEL_WHATSAPP ? (input.contact.phoneE164 ?? '') : '',
        email:
          route.channel === Channel.CHANNEL_EMAIL || route.fallbacks.includes(Channel.CHANNEL_EMAIL)
            ? (input.contact.email ?? '')
            : '',
      },
      variables: input.variables,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
      locale: 'fr',
      ttlSeconds: input.ttlSeconds,
    };
    try {
      const response = await callDependency(
        this.caller,
        'notification',
        'sendNotification',
        (metadata) => this.client.sendNotification(request, metadata),
        { deadlineMs: 5000, passThrough: ['NOTIFICATION_RECIPIENT_INVALID'] },
      );
      return { channel: channelName(response.channelUsed) };
    } catch (error) {
      if ((error as { code?: string }).code === 'NOTIFICATION_RECIPIENT_INVALID') {
        throw DocumentErrors.signerUnreachable();
      }
      throw error;
    }
  }
}
