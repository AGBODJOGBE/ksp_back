import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { MONTHLY_USE_CASES, type MonthlyBillingUseCases } from '../../application/monthly/use-cases';
import {
  RECOVERY_BILLING_USE_CASES,
  type RecoveryBillingUseCases,
} from '../../application/recovery/use-cases';

/**
 * Seul abonnement de billing à `wallet.prepaid.credited` (versions 1 et 2 ; seule la v2 porte
 * `forObject`) : une file par service et par événement, deux abonnements se partageraient les
 * messages. Chaque crédit sert, dans l'ordre :
 * - lot F (R-PE-04) : crédit destiné à une facture, débité aussitôt du portefeuille du titulaire ;
 * - recouvrement (ADR-064) : factures de commission dues du titulaire crédité, débitées tout de suite,
 *   sous le verrou de la tâche planifiée (passage en cours : le message revient plus tard).
 * Les deux traitements sont idempotents ; un échec renvoie le message en file de reprise.
 */
@Injectable()
export class WalletCreditEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletCreditEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(MONTHLY_USE_CASES) private readonly monthly: MonthlyBillingUseCases,
    @Inject(RECOVERY_BILLING_USE_CASES) private readonly recovery: RecoveryBillingUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe(
      'wallet.prepaid.credited',
      async (envelope) => {
        const { payload } = envelope;
        const outcome = await this.monthly.settleInvoiceFromWalletCredit.execute({ payload });
        if (outcome !== 'ignored') {
          // Identifiants seulement.
          this.logger.log(
            `Crédit ${payload.transactionId} pour la facture ${payload.forObject?.objectId} : ${outcome}`,
          );
        }
        const retry = await this.recovery.retryCommissionDebitsOnWalletCredit.execute({ payload });
        if (retry.due > 0) {
          this.logger.log(
            `Crédit ${payload.transactionId} : nouvel essai du débit de ${retry.due} facture(s) de commission, ` +
              `${retry.paid} réglée(s)${
                retry.failures.length > 0
                  ? ` ; encore dues : ${retry.failures.map((failure) => failure.invoiceNumber).join(', ')}`
                  : ''
              }`,
          );
        }
      },
      { versions: [1, 2] },
    );
  }
}
