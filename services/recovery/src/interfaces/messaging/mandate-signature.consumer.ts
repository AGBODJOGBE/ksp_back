import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PLAN_PROTOCOL_TEMPLATE } from '../../application/amicable/amicable-rules';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

/**
 * Abonnement aux signatures de document (`document.signature.completed`, ADR-044, ADR-060) : un
 * mandat signé fait passer son dossier « frais à payer » (R2) ; un protocole d'échéancier signé par le
 * débiteur signe l'échéancier (R4, modèle `recovery_settlement_agreement`). Idempotent (inbox) ; un
 * échec renvoie le message en file de reprise. Seuls des identifiants sont journalisés.
 */
@Injectable()
export class MandateSignatureConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(MandateSignatureConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('document.signature.completed', async (envelope) => {
      const payload = envelope.payload;
      if (payload.template === PLAN_PROTOCOL_TEMPLATE) {
        const signed = await this.useCases.recordPlanSignature.execute({
          eventId: envelope.eventId,
          documentId: payload.documentId,
          template: payload.template,
          producerService: payload.producerService,
          subjectType: payload.subjectType,
          subjectId: payload.subjectId,
          signedAt: payload.signedAt,
        });
        if (signed === 'recorded') this.logger.log(`Échéancier signé : dossier ${payload.subjectId}`);
        return;
      }
      const outcome = await this.useCases.recordMandateSignature.execute({
        eventId: envelope.eventId,
        documentId: payload.documentId,
        template: payload.template,
        producerService: payload.producerService,
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        signerUserId: payload.signerUserId,
        signedAt: payload.signedAt,
      });
      if (outcome === 'recorded') this.logger.log(`Mandat signé : dossier ${payload.subjectId} à payer`);
    });
  }
}
