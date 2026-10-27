import { notificationV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { emailErrors } from '../../application/email/email-errors';
import { type EmailCodeSender } from '../../application/email/email.ports';
import { type EmailAddress } from '../../domain/user/email-address';

/**
 * Envoie le code de confirmation de l'e-mail par appel gRPC direct à notification (même mécanisme
 * que les codes par téléphone, ADR-014), e-mail seul : modèle `identity.email_verification` pour
 * l'e-mail du profil, `identity.organization_email_verification` pour l'e-mail de facturation
 * d'une organisation (raison sociale citée dans le message).
 * L'appel n'est jamais rejoué automatiquement : la clé d'idempotence (identifiant de la demande)
 * garantit un seul envoi.
 */
export class NotificationEmailCodeSender implements EmailCodeSender {
  constructor(
    private readonly client: notificationV1.NotificationServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async send(input: {
    verificationId: string;
    userId: string;
    email: EmailAddress;
    code: string;
    ttlSeconds: number;
    organizationName?: string;
  }): Promise<void> {
    const variables: Record<string, string> = {
      code: input.code,
      expires_in_minutes: String(Math.ceil(input.ttlSeconds / 60)),
    };
    if (input.organizationName !== undefined) variables['organization_name'] = input.organizationName;
    const request: notificationV1.SendNotificationRequest = {
      templateCode:
        input.organizationName === undefined
          ? 'identity.email_verification'
          : 'identity.organization_email_verification',
      channel: notificationV1.Channel.CHANNEL_EMAIL,
      fallbackChannels: [],
      recipient: { userId: input.userId, phoneE164: '', email: input.email.value },
      variables,
      priority: notificationV1.Priority.PRIORITY_HIGH,
      idempotencyKey: input.verificationId,
      locale: 'fr',
      ttlSeconds: input.ttlSeconds,
    };

    let response: notificationV1.SendNotificationResponse;
    try {
      response = await this.caller.call('sendNotification', (metadata) =>
        this.client.sendNotification(request, metadata),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOTIFICATION_RECIPIENT_INVALID') {
        throw emailErrors.undeliverable();
      }
      throw emailErrors.sendFailed();
    }
    if (response.status === notificationV1.DeliveryStatus.DELIVERY_STATUS_FAILED) {
      throw emailErrors.sendFailed();
    }
  }
}
