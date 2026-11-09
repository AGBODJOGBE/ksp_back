import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { FILE_USE_CASES, type FileUseCases } from '../../application/use-cases';

/**
 * Abonnement aux comptes anonymisés (`identity.user.deleted`, file `file.identity.user.deleted`,
 * ADR-036, ADR-038) : fichiers du compte effacés ou détachés selon leur finalité. Un échec renvoie
 * le message en file de reprise ; le traitement est idempotent (inbox). Seuls les compteurs sont
 * journalisés, jamais l'identifiant du compte.
 */
@Injectable()
export class AccountErasureConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountErasureConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(FILE_USE_CASES) private readonly useCases: FileUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('identity.user.deleted', async (envelope) => {
      const outcome = await this.useCases.eraseAccountFiles.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        userId: envelope.payload.userId,
      });
      if (outcome.status === 'processed') {
        this.logger.log(
          `Compte anonymisé : ${outcome.erased} fichier(s) à effacer, ${outcome.detached} gardé(s) et détaché(s)`,
        );
      }
    });
  }
}
