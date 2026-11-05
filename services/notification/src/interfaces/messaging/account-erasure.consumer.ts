import { RabbitMqConsumer } from '@ksp/platform';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { EraseUserNotificationsUseCase } from '../../application/privacy/erase-user-notifications.use-case';

/**
 * Abonnement aux comptes anonymisés (`identity.user.deleted`, file
 * `notification.identity.user.deleted`, ADR-036) : notifications de l'espace KSP effacées et
 * historique des envois détaché du compte. Un échec renvoie le message en file de reprise ; le
 * traitement est idempotent (inbox). Seuls les compteurs sont journalisés, jamais l'identifiant.
 */
@Injectable()
export class AccountErasureConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountErasureConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    private readonly eraseUserNotifications: EraseUserNotificationsUseCase,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('identity.user.deleted', async (envelope) => {
      const outcome = await this.eraseUserNotifications.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        userId: envelope.payload.userId,
      });
      if (outcome.status === 'processed') {
        this.logger.log(
          `Compte anonymisé : ${outcome.inApp} notification(s) de l'espace effacée(s), ` +
            `${outcome.deliveries} envoi(s) détaché(s)`,
        );
      }
    });
  }
}
