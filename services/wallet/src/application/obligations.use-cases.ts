import { currentContext } from '@ksp/platform';
import { type WalletDeps } from './ports';
import { formatXof, requireUuid, WalletErrors } from './shared';

export interface PendingObligation {
  kind: 'prepaid_balance' | 'funds_owed' | 'negative_balance' | 'payout_in_progress';
  reference: string;
  description: string;
}

/** Seul identity interroge ce contrat, avant de supprimer un compte (UC-ID-11). */
const ALLOWED_CALLERS = new Set(['identity']);

/**
 * ksp.common.v1.ObligationService.HasPendingObligations (UC-ID-11, ADR-036, ADR-048) : de l'argent
 * encore tenu pour le compte bloque sa suppression — solde du portefeuille prépayé, fonds dus (ou
 * dette envers KSP), reversement pas encore terminé. Seuls les comptes du titulaire « user » sont
 * lus : le portefeuille d'une organisation lui appartient et survit au départ d'un membre.
 */
export class HasPendingObligationsUseCase {
  constructor(private readonly deps: WalletDeps) {}

  async execute(input: { userId: string }): Promise<PendingObligation[]> {
    // Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement).
    const caller = currentContext()?.callerService;
    if (caller && !ALLOWED_CALLERS.has(caller)) throw WalletErrors.callerForbidden();
    const holder = { type: 'user' as const, id: requireUuid('userId', input.userId) };
    const wallet = await this.deps.ledger.summary(holder);
    const obligations: PendingObligation[] = [];
    if (wallet.prepaid.balance > 0) {
      obligations.push({
        kind: 'prepaid_balance',
        reference: 'prepaid',
        description: `Votre portefeuille contient encore ${formatXof(wallet.prepaid.balance)} : utilisez-le ou demandez son remboursement.`,
      });
    }
    if (wallet.balance > 0) {
      obligations.push({
        kind: 'funds_owed',
        reference: 'collections',
        description: `${formatXof(wallet.balance)} vous sont dus : demandez leur reversement.`,
      });
    } else if (wallet.balance < 0) {
      obligations.push({
        kind: 'negative_balance',
        reference: 'collections',
        description: `Un solde de ${formatXof(-wallet.balance)} reste dû à KSP.`,
      });
    }
    if (wallet.payoutsInProgress > 0) {
      obligations.push({
        kind: 'payout_in_progress',
        reference: 'payouts',
        description: `Un reversement de ${formatXof(wallet.payoutsInProgress)} est en cours.`,
      });
    }
    return obligations;
  }
}
