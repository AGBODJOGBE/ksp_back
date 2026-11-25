import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

/**
 * Abonnement aux liens de paiement payés (`payment.link.paid`, ADR-040, ADR-060 point 7) : le paiement
 * d'un lien du débiteur devient un encaissement imputé, commissionné et crédité au créancier.
 * Idempotent (inbox, référence du paiement) ; un échec renvoie le message en file de reprise. Seuls
 * des identifiants et des montants sont journalisés.
 */
@Injectable()
export class PaymentLinkPaidConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentLinkPaidConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('payment.link.paid', async (envelope) => {
      const payload = envelope.payload;
      const outcome = await this.useCases.recordLinkPayment.execute({
        eventId: envelope.eventId,
        paymentId: payload.paymentId,
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        amount: payload.amount.amount,
        providerReference: payload.providerReference,
        paidAt: payload.paidAt,
      });
      if (outcome === 'recorded') {
        this.logger.log(`Lien payé : paiement ${payload.paymentId} encaissé (${payload.amount.amount} XOF)`);
      }
    });
  }
}
