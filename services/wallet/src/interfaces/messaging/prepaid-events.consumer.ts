import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { WALLET_USE_CASES, type WalletUseCases } from '../../application/use-cases';

/**
 * Portefeuille prépayé (ADR-046) :
 * - file wallet.payment.intent.succeeded : une recharge confirmée (objet wallet_top_up) est créditée
 *   au portefeuille, une seule fois (inbox et référence du paiement) ; les autres objets sont ignorés ;
 * - file wallet.cleaning.mission.refunded : chaque débit cité est remboursé, une seule fois.
 * Un échec repasse par la file de reprise.
 */
@Injectable()
export class PrepaidEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PrepaidEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('payment.intent.succeeded', async (envelope) => {
      const payload = envelope.payload;
      if (payload.subjectType !== 'wallet_top_up') return;
      const outcome = await this.useCases.creditTopUp.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        paymentId: payload.paymentId,
        subjectId: payload.subjectId,
        customerId: payload.customerId,
        organizationId: payload.organizationId,
        amount: payload.amount.amount,
      });
      if (outcome === 'ignored') {
        // Identifiants seulement : la recharge ne désigne pas le titulaire du payeur.
        this.logger.error(
          `ALERTE wallet : recharge ${payload.paymentId} pour ${payload.subjectId}, titulaire différent ` +
            "du payeur ; rien n'est crédité",
        );
        return;
      }
      this.logger.log(`Recharge ${payload.paymentId} : ${outcome}`);
    });

    await this.consumer.subscribe('cleaning.mission.refunded', async (envelope) => {
      const payload = envelope.payload;
      const result = await this.useCases.refundFromEvent.execute({
        producer: envelope.producer,
        transactionIds: payload.refunds.map((refund) => refund.walletTransactionId),
        reason: 'mission annulée',
      });
      this.logger.log(
        `Remboursement de la mission ${payload.missionId} : ${
          result === 'ignored' ? 'ignoré' : `${result.refunded} remboursé(s), ${result.already} déjà fait(s)`
        }`,
      );
    });
  }
}
