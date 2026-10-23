import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';

/**
 * Abonnement aux factures de billing (files cleaning.billing.invoice.overdue et
 * cleaning.billing.invoice.paid) : avertissement, suspension ou déblocage des contrats.
 * Un échec renvoie le message en file de reprise ; le traitement est idempotent (inbox).
 */
@Injectable()
export class BillingEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('billing.invoice.overdue', async (envelope) => {
      const outcome = await this.useCases.handleInvoiceEvent.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        invoiceId: envelope.payload.invoiceId,
        contractId: envelope.payload.contractId,
        source: envelope.payload.source,
        status: 'overdue',
      });
      this.logger.log(`Facture ${envelope.payload.invoiceId} impayée : ${outcome}`);
    });
    await this.consumer.subscribe('billing.invoice.paid', async (envelope) => {
      const outcome = await this.useCases.handleInvoiceEvent.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        invoiceId: envelope.payload.invoiceId,
        contractId: envelope.payload.contractId,
        source: envelope.payload.source,
        status: 'paid',
      });
      this.logger.log(`Facture ${envelope.payload.invoiceId} réglée : ${outcome}`);
    });
  }
}
