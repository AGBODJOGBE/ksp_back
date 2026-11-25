import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

/**
 * Abonnement aux signatures de document (`document.signature.completed`, ADR-044, ADR-060) : un
 * mandat signé fait passer son dossier « frais à payer ». Idempotent (inbox) ; un échec renvoie le
 * message en file de reprise. Seuls des identifiants sont journalisés.
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
