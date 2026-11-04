import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';

/**
 * Abonnement aux décisions de KSP sur les organisations (files
 * cleaning.identity.organization.suspended et cleaning.identity.organization.reactivated) :
 * suspension et reprise de leurs missions (ADR-030) ; comptes anonymisés (identity.user.deleted) :
 * effacement de la position de leurs dossiers (ADR-035). Seul l'identifiant de l'organisation est
 * journalisé (ni raison sociale ni motif). Un échec renvoie le message en file de reprise ; le
 * traitement est idempotent (inbox).
 */
@Injectable()
export class IdentityEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(IdentityEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('identity.organization.suspended', async (envelope) => {
      const outcome = await this.useCases.handleOrganizationEvent.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        organizationId: envelope.payload.organizationId,
        suspended: true,
        occurredAt: envelope.occurredAt,
      });
      this.logger.log(
        `Organisation ${envelope.payload.organizationId} suspendue : ` +
          `cause posée sur ${outcome.changed} mission(s) en cours sur ${outcome.examined}`,
      );
    });
    await this.consumer.subscribe('identity.organization.reactivated', async (envelope) => {
      const outcome = await this.useCases.handleOrganizationEvent.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        organizationId: envelope.payload.organizationId,
        suspended: false,
        occurredAt: envelope.occurredAt,
      });
      this.logger.log(
        `Organisation ${envelope.payload.organizationId} réactivée : ` +
          `cause levée sur ${outcome.changed} mission(s) en cours sur ${outcome.examined}`,
      );
    });
    // Compte anonymisé (UC-ID-11, ADR-035) : position effacée de ses demandes et missions. Événement
    // du contrat, pas encore publié par identity : actif dès qu'il le sera. Aucun identifiant journalisé.
    await this.consumer.subscribe('identity.user.deleted', async (envelope) => {
      const outcome = await this.useCases.eraseCustomerLocations.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        userId: envelope.payload.userId,
      });
      if (outcome === 'processed') this.logger.log('Compte anonymisé : positions effacées');
    });
  }
}
