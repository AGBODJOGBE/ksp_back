import { type BillingDeps } from './ports';
import { requireCaller } from './shared/access';
import { requireUuid } from './shared/validation';

export interface PendingObligation {
  kind: string;
  reference: string;
  description: string;
}

/** Montant lisible : 34 000 FCFA (montants entiers en XOF). */
function formatAmount(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

/** Seul identity interroge ce contrat, avant de supprimer un compte (UC-ID-11). */
const ALLOWED_CALLERS = ['identity'];

/**
 * ksp.common.v1.ObligationService.HasPendingObligations (UC-ID-11, ADR-036) : une facture en
 * attente de paiement ou impayée du compte bloque la suppression. Aujourd'hui, seules les
 * organisations sont facturées au mois : la facture compte pour le compte qui a fait la demande de
 * prestation (choix prudent, ADR-036), même s'il n'est pas le dernier administrateur.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: { userId: string }): Promise<PendingObligation[]> {
    requireCaller(ALLOWED_CALLERS);
    const invoices = await this.deps.invoices.listUnpaidForCustomer(requireUuid('userId', input.userId));
    return invoices.map((invoice) => ({
      kind: 'unpaid_invoice',
      reference: invoice.number,
      description:
        invoice.status === 'overdue'
          ? `La facture ${invoice.number} (${formatAmount(invoice.total)}) est impayée.`
          : `La facture ${invoice.number} (${formatAmount(invoice.total)}) est en attente de paiement.`,
    }));
  }
}
