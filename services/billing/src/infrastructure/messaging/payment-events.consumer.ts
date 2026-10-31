import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { BILLING_USE_CASES, type BillingUseCases } from '../../application/use-cases';

/**
 * Abonnement aux paiements en ligne (file billing.payment.intent.succeeded, ADR-031) : le reste dû
 * d'une facture payé par Mobile Money est enregistré ; la facture passe payée au total. Un échec
 * renvoie le message en file de reprise ; le traitement est idempotent (inbox).
 */
@Injectable()
export class PaymentEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(BILLING_USE_CASES) private readonly useCases: BillingUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('payment.intent.succeeded', async (envelope) => {
      const payload = envelope.payload;
      if (payload.subjectType !== 'billing_invoice') return;
      const { outcome, excess } = await this.useCases.recordOnlinePayment.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        paymentId: payload.paymentId,
        subjectType: payload.subjectType,
        invoiceId: payload.subjectId,
        amount: payload.amount.amount,
        providerReference: payload.providerReference,
        succeededAt: payload.succeededAt,
      });
      this.logger.log(`Paiement en ligne ${payload.paymentId} (facture ${payload.subjectId}) : ${outcome}`);
      if (excess > 0) {
        // Identifiants et montants seulement : à rembourser (différé, ADR-031).
        this.logger.warn(
          `Excédent de paiement en ligne : facture ${payload.subjectId}, paiement ${payload.paymentId}, ` +
            `${excess} XOF au-delà du reste dû`,
        );
      }
    });
  }
}
