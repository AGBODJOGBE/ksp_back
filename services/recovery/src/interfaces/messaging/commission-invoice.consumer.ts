import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

/**
 * Abonnement aux factures de commission de billing (`billing.commission_invoice.issued`, ADR-064) :
 * la facture du mois est rattachée aux relevés mensuels du créancier (R-CO-05). Idempotent (inbox) ;
 * un échec renvoie le message en file de reprise. Seuls des identifiants sont journalisés.
 */
@Injectable()
export class CommissionInvoiceConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommissionInvoiceConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('billing.commission_invoice.issued', async (envelope) => {
      const payload = envelope.payload;
      const result = await this.useCases.recordCommissionInvoice.execute({
        eventId: envelope.eventId,
        invoiceId: payload.invoiceId,
        invoiceNumber: payload.invoiceNumber,
        creditor: payload.creditor,
        period: payload.period,
        issuedAt: payload.issuedAt,
      });
      if (result.outcome === 'recorded') {
        this.logger.log(
          `Facture de commission ${payload.invoiceId} (${payload.period}) : ${result.statements} relevé(s) rattaché(s)`,
        );
      } else if (result.outcome === 'ignored') {
        this.logger.warn(`Facture de commission ${payload.invoiceId} ignorée : contenu inattendu`);
      }
    });
  }
}
