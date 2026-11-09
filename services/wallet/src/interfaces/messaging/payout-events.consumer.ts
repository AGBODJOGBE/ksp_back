import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { WALLET_USE_CASES, type WalletUseCases } from '../../application/use-cases';

/**
 * Issues des reversements (files wallet.payment.payout.completed et wallet.payment.payout.failed,
 * ADR-041) : le reversement wallet est soldé (terminé) ou son montant rendu (échec). Idempotent
 * (inbox dans la même transaction que l'écriture) ; un échec repasse par la file de reprise.
 */
@Injectable()
export class PayoutEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const type of ['payment.payout.completed', 'payment.payout.failed'] as const) {
      await this.consumer.subscribe(type, async (envelope) => {
        const payload = envelope.payload;
        const outcome = await this.useCases.settlePayout.execute({
          eventId: envelope.eventId,
          eventType: envelope.type,
          outcome: type === 'payment.payout.completed' ? 'completed' : 'failed',
          paymentPayoutId: payload.payoutId,
          issuer: payload.issuer,
          reference: payload.reference,
          amount: payload.amount.amount,
        });
        if (outcome === 'amount_mismatch') {
          // Identifiants et montants seulement : à vérifier par la finance.
          this.logger.error(
            `ALERTE wallet : reversement ${payload.reference} (payment ${payload.payoutId}) soldé pour ` +
              `${payload.amount.amount} XOF, montant différent du reversement wallet ; rien n'est écrit`,
          );
          return;
        }
        this.logger.log(`Reversement ${payload.reference} (${type}) : ${outcome}`);
      });
    }
  }
}
