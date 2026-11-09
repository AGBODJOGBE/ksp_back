import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DOCUMENT_USE_CASES, type DocumentUseCases } from '../../application/use-cases';

/**
 * Abonnement aux comptes anonymisés (`identity.user.deleted`, file
 * `document.identity.user.deleted`, ADR-036, ADR-044) : documents gardés et détachés du compte,
 * demandes en attente qui lui sont adressées annulées. Idempotent (inbox) ; un échec renvoie le
 * message en file de reprise. Seuls les compteurs sont journalisés, jamais l'identifiant du compte.
 */
@Injectable()
export class AccountErasureConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountErasureConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(DOCUMENT_USE_CASES) private readonly useCases: DocumentUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('identity.user.deleted', async (envelope) => {
      const outcome = await this.useCases.eraseAccount.execute({
        eventId: envelope.eventId,
        userId: envelope.payload.userId,
      });
      if (outcome.status === 'processed') {
        this.logger.log(
          `Compte anonymisé : ${outcome.detachedDocuments} document(s) détaché(s), ` +
            `${outcome.cancelledRequests} demande(s) de signature annulée(s)`,
        );
      }
    });
  }
}
