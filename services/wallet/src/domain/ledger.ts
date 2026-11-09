/**
 * Grand livre en double entrée (ADR-042) des fonds que KSP détient pour ses clients (créanciers du
 * Recouvrement). Chaque opération est une transaction de lignes (compte, sens, montant) équilibrée :
 * la somme des débits égale celle des crédits. Une transaction ne se modifie jamais ; une erreur se
 * corrige par une écriture inverse. Aucun solde n'est saisi : il découle des écritures.
 *
 * Comptes :
 * - `holder:<type>:<id>` : ce que KSP doit à un titulaire (compte ou organisation) — passif, sens
 *   naturel crédit ;
 * - `ksp:collections` : fonds encaissés et détenus par KSP (chez le prestataire ou en banque) —
 *   actif, sens naturel débit ;
 * - `ksp:commission` : commissions acquises par KSP — produit, sens naturel crédit ;
 * - `ksp:payouts_in_transit` : reversements demandés, pas encore confirmés — passif, crédit.
 *
 * Invariant : collections = Σ titulaires + commission + en transit (sens naturels).
 */
export type HolderType = 'user' | 'organization';
export const HOLDER_TYPES: readonly HolderType[] = ['user', 'organization'];

export interface Holder {
  type: HolderType;
  id: string;
}

export type InternalAccount = 'ksp:collections' | 'ksp:commission' | 'ksp:payouts_in_transit';
export const INTERNAL_ACCOUNTS: readonly InternalAccount[] = [
  'ksp:collections',
  'ksp:commission',
  'ksp:payouts_in_transit',
];
export type AccountCode = InternalAccount | `holder:${HolderType}:${string}`;

export type Direction = 'debit' | 'credit';

export function holderAccount(holder: Holder): AccountCode {
  return `holder:${holder.type}:${holder.id}`;
}

/** Sens naturel d'un compte : le solde augmente quand une écriture va dans ce sens. */
export function normalSide(account: AccountCode): Direction {
  return account === 'ksp:collections' ? 'debit' : 'credit';
}

export interface EntryLine {
  account: AccountCode;
  direction: Direction;
  /** Entier XOF strictement positif. */
  amount: number;
}

export type TransactionKind =
  'collection' | 'payout_hold' | 'payout_settlement' | 'payout_release' | 'reversal';

export interface LedgerTransaction {
  id: string;
  kind: TransactionKind;
  /** Service appelant (jeton de service) ; `wallet` pour ses propres écritures. */
  caller: string;
  /** Référence d'idempotence, unique par appelant. */
  reference: string;
  holder: Holder;
  /** Montant pour le titulaire : net crédité, montant retenu ou rendu, montant annulé. */
  amount: number;
  /** Encaissement (et son annulation) : brut, commission, taux en points de base. */
  grossAmount: number | null;
  commission: number | null;
  commissionRateBps: number | null;
  description: string;
  reversesTransactionId: string | null;
  /** Reversement wallet concerné (retenue, solde, restitution). */
  payoutId: string | null;
  createdAt: Date;
  entries: EntryLine[];
}

/** Montant XOF d'une opération : entier, 1 à 1 000 000 000. */
export const MAX_AMOUNT = 1_000_000_000;
/** Taux de commission en points de base : 0 à 10 000 (100 %). */
export const MAX_RATE_BPS = 10_000;

/**
 * Commission sur un encaissement : taux × brut, **arrondie à l'entier inférieur** (KSP ne prélève
 * jamais plus que le taux annoncé ; le franc restant va au titulaire). Calcul en entiers exacts.
 */
export function commissionOf(gross: number, rateBps: number): number {
  return Math.floor((gross * rateBps) / MAX_RATE_BPS);
}

/** Lignes sans montant retirées (commission nulle, ou taux de 100 %). */
const nonZero = (lines: EntryLine[]) => lines.filter((line) => line.amount > 0);

/** Encaissement : fonds reçus par KSP, net au titulaire, commission à KSP. */
export function collectionEntries(
  holder: Holder,
  gross: number,
  rateBps: number,
): { net: number; commission: number; entries: EntryLine[] } {
  const commission = commissionOf(gross, rateBps);
  const net = gross - commission;
  return {
    net,
    commission,
    entries: nonZero([
      { account: 'ksp:collections', direction: 'debit', amount: gross },
      { account: holderAccount(holder), direction: 'credit', amount: net },
      { account: 'ksp:commission', direction: 'credit', amount: commission },
    ]),
  };
}

/** Reversement demandé : retenu sur le solde du titulaire, en transit. */
export function payoutHoldEntries(holder: Holder, amount: number): EntryLine[] {
  return [
    { account: holderAccount(holder), direction: 'debit', amount },
    { account: 'ksp:payouts_in_transit', direction: 'credit', amount },
  ];
}

/** Reversement terminé : l'argent a quitté KSP. */
export function payoutSettlementEntries(amount: number): EntryLine[] {
  return [
    { account: 'ksp:payouts_in_transit', direction: 'debit', amount },
    { account: 'ksp:collections', direction: 'credit', amount },
  ];
}

/** Reversement en échec : le montant retenu est rendu au titulaire. */
export function payoutReleaseEntries(holder: Holder, amount: number): EntryLine[] {
  return [
    { account: 'ksp:payouts_in_transit', direction: 'debit', amount },
    { account: holderAccount(holder), direction: 'credit', amount },
  ];
}

/** Écriture inverse : mêmes comptes et montants, sens opposés. */
export function reversalEntries(original: Pick<LedgerTransaction, 'entries'>): EntryLine[] {
  return original.entries.map((line) => ({
    ...line,
    direction: line.direction === 'debit' ? 'credit' : 'debit',
  }));
}

/** Transaction équilibrée, montants entiers strictement positifs, au moins deux lignes. */
export function isBalanced(entries: readonly EntryLine[]): boolean {
  if (entries.length < 2) return false;
  if (!entries.every((line) => Number.isSafeInteger(line.amount) && line.amount > 0)) return false;
  const sum = (direction: Direction) =>
    entries.filter((line) => line.direction === direction).reduce((total, line) => total + line.amount, 0);
  return sum('debit') === sum('credit');
}

/** Effet d'une ligne sur le solde de son compte (sens naturel : +, sens opposé : -). */
export function balanceDelta(line: EntryLine): number {
  return line.direction === normalSide(line.account) ? line.amount : -line.amount;
}

/** Même encaissement (rejeu d'une référence) : même titulaire, même brut, même taux. */
export function sameCollection(
  transaction: Pick<LedgerTransaction, 'kind' | 'holder' | 'grossAmount' | 'commissionRateBps'>,
  request: { holder: Holder; gross: number; rateBps: number },
): boolean {
  return (
    transaction.kind === 'collection' &&
    transaction.holder.type === request.holder.type &&
    transaction.holder.id === request.holder.id &&
    transaction.grossAmount === request.gross &&
    transaction.commissionRateBps === request.rateBps
  );
}
