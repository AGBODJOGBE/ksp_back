import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';

/**
 * Abonnement aux paiements en ligne (file cleaning.payment.intent.succeeded, ADR-031) : l'acompte
 * ou le solde payé par Mobile Money est enregistré sur la mission. Un échec renvoie le message en
 * file de reprise ; le traitement est idempotent (inbox).
 */
@Injectable()
export class PaymentEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('payment.intent.succeeded', async (envelope) => {
      const payload = envelope.payload;
      if (payload.subjectType !== 'cleaning_mission') return;
      const outcome = await this.useCases.recordOnlinePayment.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        paymentId: payload.paymentId,
        subjectType: payload.subjectType,
        missionId: payload.subjectId,
        amount: payload.amount.amount,
        providerReference: payload.providerReference,
        succeededAt: payload.succeededAt,
      });
      this.logger.log(`Paiement en ligne ${payload.paymentId} (mission ${payload.subjectId}) : ${outcome}`);
    });
  }
}
