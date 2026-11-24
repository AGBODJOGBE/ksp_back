import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type PrivacyDeps } from '../../application/deps';
import { EraseAccountDataUseCase } from '../../application/privacy/account-erasure.use-case';

/**
 * Abonnement aux comptes anonymisés par identity (identity.user.deleted, file
 * cleaning.identity.user.deleted, ADR-036) : effacement des données personnelles du compte tenues
 * par cleaning (R-DP-02). Seul abonné de ce type d'événement dans le service (une file par
 * consommateur et par type, ADR-047) ; les événements d'argent ont leur propre écouteur. Un échec
 * renvoie le message en file de reprise ; le traitement est idempotent (inbox dans la transaction
 * de l'effacement). Seuls des nombres sont journalisés, jamais l'identifiant du compte.
 */
@Injectable()
export class AccountErasureConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountErasureConsumer.name);
  private readonly erasure: EraseAccountDataUseCase;

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
  ) {
    this.erasure = new EraseAccountDataUseCase(deps as PrivacyDeps);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('identity.user.deleted', async (envelope) => {
      const outcome = await this.erasure.execute({
        eventId: envelope.eventId,
        userId: envelope.payload.userId,
      });
      if (outcome.status === 'processed') {
        this.logger.log(
          `Compte anonymisé : ${outcome.places} lieu(x), ${outcome.requests} demande(s), ` +
            `${outcome.visitArrivals + outcome.sessionArrivals} position(s) d'arrivée, ` +
            `${outcome.agentProfiles} fiche(s) d'agent effacés`,
        );
      }
    });
  }
}
