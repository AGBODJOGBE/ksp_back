import { floorRate, isRate, isWholeAmount } from './money';
import { type Outcome, refusal, success } from './outcome';

/**
 * Montant dû d'un dossier, tenu à jour (R-SD-08) : principal + intérêts et pénalités prévus au contrat
 * + frais de procédure refacturables − paiements reçus. Chaque composante garde ce qui a été payé, pour
 * imputer un paiement dans l'ordre frais → intérêts → principal (R-EN-03, décision 5).
 */
export interface Component {
  owed: number;
  paid: number;
}

export interface CaseAmounts {
  costs: Component;
  interests: Component;
  principal: Component;
}

export type ComponentName = keyof CaseAmounts;

/** Ordre d'imputation d'un paiement (R-EN-03). */
export const ALLOCATION_ORDER: readonly ComponentName[] = ['costs', 'interests', 'principal'];

export interface Allocation {
  costs: number;
  interests: number;
  principal: number;
  /** Part au-delà du montant dû : trop-perçu à rembourser par la finance (R-EN-05). */
  overpayment: number;
}

/**
 * Montants à l'ouverture : principal, intérêts et pénalités, et paiements partiels déjà reçus avant la
 * soumission (4.1, étape 3), imputés comme tout paiement.
 */
export function openingAmounts(
  principal: number,
  interests: number,
  priorPayments = 0,
): Outcome<CaseAmounts> {
  if (![principal, interests, priorPayments].every(isWholeAmount) || principal === 0) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Montants entiers en FCFA, principal strictement positif');
  }
  const amounts: CaseAmounts = {
    costs: { owed: 0, paid: 0 },
    interests: { owed: interests, paid: 0 },
    principal: { owed: principal, paid: 0 },
  };
  if (priorPayments > totalDue(amounts)) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Les paiements déjà reçus dépassent la créance');
  }
  return success(applyPayment(amounts, priorPayments).amounts);
}

export function remaining(component: Component): number {
  return component.owed - component.paid;
}

/** Montant dû restant. */
export function totalDue(amounts: CaseAmounts): number {
  return ALLOCATION_ORDER.reduce((sum, name) => sum + remaining(amounts[name]), 0);
}

export function totalPaid(amounts: CaseAmounts): number {
  return ALLOCATION_ORDER.reduce((sum, name) => sum + amounts[name].paid, 0);
}

export function isFullyPaid(amounts: CaseAmounts): boolean {
  return totalDue(amounts) === 0;
}

/** Répartition d'un paiement sans l’appliquer : frais, puis intérêts, puis principal, puis trop-perçu. */
export function allocate(amounts: CaseAmounts, payment: number): Allocation {
  let left = payment;
  const allocation: Allocation = { costs: 0, interests: 0, principal: 0, overpayment: 0 };
  for (const name of ALLOCATION_ORDER) {
    const part = Math.min(left, remaining(amounts[name]));
    allocation[name] = part;
    left -= part;
  }
  allocation.overpayment = left;
  return allocation;
}

/** Imputation d'un paiement (encaissement, paiement hors ligne ou paiement direct déclaré, R-PR-07). */
export function applyPayment(
  amounts: CaseAmounts,
  payment: number,
): { amounts: CaseAmounts; allocation: Allocation } {
  const allocation = allocate(amounts, payment);
  return {
    allocation,
    amounts: {
      costs: { ...amounts.costs, paid: amounts.costs.paid + allocation.costs },
      interests: { ...amounts.interests, paid: amounts.interests.paid + allocation.interests },
      principal: { ...amounts.principal, paid: amounts.principal.paid + allocation.principal },
    },
  };
}

/**
 * Base de la commission d'un encaissement : intérêts et principal. Les frais de procédure recouvrés
 * remboursent la provision du créancier en priorité (R-CO-06) et le trop-perçu est rendu : ni l'un ni
 * l'autre n'est commissionné (à valider).
 */
export function commissionBase(allocation: Allocation): number {
  return allocation.interests + allocation.principal;
}

/** Frais de procédure mis à la charge du débiteur par le juge (R-CO-06), ajoutés au montant dû. */
export function addRecoverableCosts(amounts: CaseAmounts, costs: number): Outcome<CaseAmounts> {
  if (!isWholeAmount(costs) || costs === 0)
    return refusal('RECOVERY_INVALID_AMOUNT', 'Frais entiers et positifs');
  return success({ ...amounts, costs: { ...amounts.costs, owed: amounts.costs.owed + costs } });
}

/**
 * Montant corrigé après une contestation (R-PR-02) : nouveau principal, jamais en dessous de ce qui a
 * déjà été payé sur le principal.
 */
export function correctPrincipal(amounts: CaseAmounts, principal: number): Outcome<CaseAmounts> {
  if (!isWholeAmount(principal) || principal < amounts.principal.paid) {
    return refusal(
      'RECOVERY_INVALID_AMOUNT',
      'Le principal corrigé ne peut descendre sous ce qui est déjà payé',
    );
  }
  return success({ ...amounts, principal: { ...amounts.principal, owed: principal } });
}

/**
 * Accord transactionnel (R-PR-05) : le débiteur paie tout de suite une partie contre l'abandon du reste.
 * Dans le barème du créancier si la remise ne dépasse pas sa remise maximale ; sinon le créancier valide.
 */
export function settlementWithinScale(due: number, offered: number, maxDiscountBp: number): boolean {
  if (!isWholeAmount(offered) || !isRate(maxDiscountBp) || offered === 0 || offered > due) return false;
  return due - offered <= floorRate(due, maxDiscountBp);
}

/** Montant abandonné par l'accord transactionnel exécuté : il solde le dossier sans paiement. */
export function waiveRemainder(amounts: CaseAmounts): CaseAmounts {
  return {
    costs: { owed: amounts.costs.paid, paid: amounts.costs.paid },
    interests: { owed: amounts.interests.paid, paid: amounts.interests.paid },
    principal: { owed: amounts.principal.paid, paid: amounts.principal.paid },
  };
}
