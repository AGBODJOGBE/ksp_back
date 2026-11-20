import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { MONTHLY_USE_CASES, type MonthlyBillingUseCases } from '../../application/monthly/use-cases';

/**
 * Abonnements du lot F (CDC Nettoyage v2, 15.5, R-PE-01, R-PE-04) :
 * - `cleaning.session.completed` et `cleaning.session.missed` : séances d'organisation gardées
 *   comme lignes de la facture mensuelle (inbox : un événement reçu deux fois n'a qu'un effet) ;
 * - `wallet.prepaid.credited` (versions 1 et 2 ; seule la v2 porte `forObject`) : crédit destiné à
 *   une facture, débité aussitôt du portefeuille du titulaire.
 * Un échec renvoie le message en file de reprise.
 */
@Injectable()
export class MonthlyEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonthlyEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(MONTHLY_USE_CASES) private readonly useCases: MonthlyBillingUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('cleaning.session.completed', async (envelope) => {
      await this.useCases.recordBillableSession.execute({
        eventId: envelope.eventId,
        type: 'cleaning.session.completed',
        payload: envelope.payload,
      });
    });
    await this.consumer.subscribe('cleaning.session.missed', async (envelope) => {
      await this.useCases.recordBillableSession.execute({
        eventId: envelope.eventId,
        type: 'cleaning.session.missed',
        payload: envelope.payload,
      });
    });
    await this.consumer.subscribe(
      'wallet.prepaid.credited',
      async (envelope) => {
        const outcome = await this.useCases.settleInvoiceFromWalletCredit.execute({
          payload: envelope.payload,
        });
        if (outcome !== 'ignored') {
          // Identifiants seulement.
          this.logger.log(
            `Crédit ${envelope.payload.transactionId} pour la facture ${envelope.payload.forObject?.objectId} : ${outcome}`,
          );
        }
      },
      { versions: [1, 2] },
    );
  }
}
