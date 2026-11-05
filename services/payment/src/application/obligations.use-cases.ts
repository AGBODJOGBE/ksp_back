import { currentContext } from '@ksp/platform';
import { isUnderReview, type PaymentIntent } from '../domain/payment-intent';
import { type PaymentDeps } from './ports';
import { PaymentErrors } from './shared/errors';
import { requireUuid } from './shared/validation';

export interface PendingObligation {
  kind: string;
  reference: string;
  description: string;
}

/** Seul identity interroge ce contrat, avant de supprimer un compte (UC-ID-11). */
const ALLOWED_CALLERS = new Set(['identity']);

/** Montant lisible : 34 000 FCFA (montants entiers en XOF). */
function formatAmount(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
}

function describe(intent: PaymentIntent): PendingObligation {
  const amount = formatAmount(intent.amount);
  return isUnderReview(intent)
    ? {
        kind: 'payment_under_review',
        reference: intent.id,
        description: `Un paiement de ${amount} est en cours de vérification par KSP.`,
      }
    : {
        kind: 'pending_payment',
        reference: intent.id,
        description: `Un paiement de ${amount} est en attente de confirmation.`,
      };
}

/**
 * ksp.common.v1.ObligationService.HasPendingObligations (UC-ID-11, ADR-036) : un paiement en ligne
 * du compte encore en attente, ou en écart de montant pas encore traité par la finance (« en
 * vérification »), bloque la suppression du compte. Le payeur est la personne connectée : ses
 * paiements comptent, en son nom ou pour une organisation.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: PaymentDeps) {}

  async execute(input: { userId: string }): Promise<PendingObligation[]> {
    // Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement).
    const caller = currentContext()?.callerService;
    if (caller && !ALLOWED_CALLERS.has(caller)) throw PaymentErrors.callerForbidden();
    const open = await this.deps.payments.listOpenForCustomer(requireUuid('userId', input.userId));
    return open.map(describe);
  }
}
