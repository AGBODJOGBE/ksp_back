import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { MONTHLY_USE_CASES, type MonthlyBillingUseCases } from '../../application/monthly/use-cases';

/**
 * Abonnements du lot F (CDC Nettoyage v2, 15.5, R-PE-01) : `cleaning.session.completed` et
 * `cleaning.session.missed`, séances d'organisation gardées comme lignes de la facture mensuelle
 * (inbox : un événement reçu deux fois n'a qu'un effet). Le crédit destiné à une facture
 * (`wallet.prepaid.credited`, R-PE-04) passe par `WalletCreditEventsConsumer`, seul abonné de billing
 * à cet événement. Un échec renvoie le message en file de reprise.
 */
@Injectable()
export class MonthlyEventsConsumer implements OnApplicationBootstrap {
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
  }
}
