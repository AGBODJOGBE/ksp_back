import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  RECOVERY_BILLING_USE_CASES,
  type RecoveryBillingUseCases,
} from '../../application/recovery/use-cases';

/**
 * Abonnements de la facturation du recouvrement (ADR-064) :
 * - `recovery.payment.collected` : encaissement gardé comme ligne de la facture de commission du mois ;
 * - `wallet.prepaid.debited` : débit de frais de dossier ou de forfait d'étude fait par recovery, qui
 *   donne un reçu ; tout autre débit est ignoré.
 * Inbox : un événement reçu deux fois n'a qu'un effet. Un échec renvoie le message en file de reprise.
 */
@Injectable()
export class RecoveryEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(RECOVERY_BILLING_USE_CASES) private readonly useCases: RecoveryBillingUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('recovery.payment.collected', async (envelope) => {
      await this.useCases.recordCollection.execute({ eventId: envelope.eventId, payload: envelope.payload });
    });
    await this.consumer.subscribe('wallet.prepaid.debited', async (envelope) => {
      const outcome = await this.useCases.recordFeeReceipt.execute({
        eventId: envelope.eventId,
        payload: envelope.payload,
      });
      // Identifiants seulement.
      if (outcome === 'recorded') {
        this.logger.log(`Reçu de frais émis pour le débit ${envelope.payload.transactionId}`);
      }
    });
  }
}
