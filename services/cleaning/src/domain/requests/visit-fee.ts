import { DomainRuleError, invalidTransition } from './errors';
import { effectiveRequestStatus, type RequestStatus } from './request-status';
import { addHours } from './time';

/**
 * Frais de visite (partie 7.2) : une ligne par visite payante, la première à l'envoi de la demande,
 * puis une nouvelle après chaque absence du client (R-VI-05). Montants en FCFA entiers.
 */
export type VisitFeeStatus = 'awaiting_payment' | 'paid' | 'refunded' | 'retained' | 'deducted';

export interface VisitFee {
  id: string;
  /** 1 à l'envoi, puis 2, 3… après chaque absence du client. */
  rank: number;
  amount: number;
  status: VisitFeeStatus;
  /** Limite de paiement (R-FV-03) ; null une fois payés. */
  dueAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
}

/** Délai de paiement des frais de visite par défaut (16.1 : 72 h, de 1 à 168 h). */
export const DEFAULT_VISIT_FEE_PAYMENT_HOURS = 72;

/**
 * R-FV-01 : frais de la catégorie de lieu (valeur par défaut des réglages sinon), majorés d'un
 * montant fixe facultatif par commune.
 */
export function visitFeeAmount(input: {
  categoryFee: number | null;
  defaultFee: number;
  communeSurcharge?: number | null;
}): number {
  return (input.categoryFee ?? input.defaultFee) + (input.communeSurcharge ?? 0);
}

/** Frais à payer, montant du jour, échéance R-FV-03. */
export function newVisitFee(input: {
  id: string;
  rank: number;
  amount: number;
  now: Date;
  paymentHours: number;
}): VisitFee {
  return {
    id: input.id,
    rank: input.rank,
    amount: input.amount,
    status: 'awaiting_payment',
    dueAt: addHours(input.now, input.paymentHours),
    paidAt: null,
    refundedAt: null,
  };
}

export function nextVisitFeeRank(fees: readonly VisitFee[]): number {
  return fees.reduce((rank, fee) => Math.max(rank, fee.rank), 0) + 1;
}

/**
 * R-FV-02 : paiement des frais en attente ; la demande passe « visite à planifier ». Des frais
 * impayés à leur échéance ont annulé la demande (statut effectif, R-FV-03) : paiement refusé.
 */
export function payVisitFee(
  fee: VisitFee,
  requestStatus: RequestStatus,
  now: Date,
): { fee: VisitFee; requestStatus: 'visit_to_schedule' } {
  if (fee.status !== 'awaiting_payment') throw new DomainRuleError('CLEANING_NOTHING_TO_PAY');
  const effective = effectiveRequestStatus({ status: requestStatus, pendingVisitFeeDueAt: fee.dueAt }, now);
  if (effective !== 'awaiting_visit_fee') throw invalidTransition(effective, 'visit_to_schedule');
  return {
    fee: { ...fee, status: 'paid', paidAt: now, dueAt: null },
    requestStatus: 'visit_to_schedule',
  };
}

/**
 * R-FV-06 : remboursement intégral au wallet de frais payés. Jamais deux fois : des frais déjà
 * remboursés, ou non payés, ne rendent rien.
 */
export function refundVisitFee(fee: VisitFee, now: Date): { fee: VisitFee; refunded: number } {
  if (fee.status !== 'paid') return { fee, refunded: 0 };
  return { fee: { ...fee, status: 'refunded', refundedAt: now }, refunded: fee.amount };
}

/** Frais payés conservés par KSP (client absent, devis refusé ou expiré, annulation tardive). */
export function retainVisitFee(fee: VisitFee): VisitFee {
  return fee.status === 'paid' ? { ...fee, status: 'retained' } : fee;
}

/**
 * Frais qui couvrent la prochaine visite : les plus récents, payés, ou remboursés après une
 * annulation par KSP ou une absence de son agent (visite suivante gratuite, R-FV-06). Une nouvelle
 * visite demandée par KSP reste rattachée aux derniers frais payés (R-VI-07).
 */
export function feeCoveringNextVisit(fees: readonly VisitFee[]): VisitFee {
  const latest = [...fees].sort((a, b) => b.rank - a.rank)[0];
  if (!latest || (latest.status !== 'paid' && latest.status !== 'refunded')) {
    throw new DomainRuleError('CLEANING_VISIT_FEE_UNPAID');
  }
  return latest;
}

/**
 * R-FV-05 : frais déduits du premier paiement si le devis est accepté (réglage activé par défaut).
 * Seuls des frais encore « payés » se déduisent : une visite gratuite (frais remboursés) ou des
 * frais conservés n'ont rien à déduire.
 */
export function deductibleVisitFeeAmount(fees: readonly VisitFee[], deductionEnabled: boolean): number {
  if (!deductionEnabled) return 0;
  return fees.filter((fee) => fee.status === 'paid').reduce((sum, fee) => sum + fee.amount, 0);
}

/**
 * À l'acceptation du devis : les frais payés sont déduits ; si la déduction est désactivée, ils sont
 * conservés (interprétation : `retained` plutôt que de rester « payés »).
 */
export function settleVisitFeesOnAcceptance(
  fees: readonly VisitFee[],
  deductionEnabled: boolean,
): VisitFee[] {
  return fees.map((fee) => {
    if (fee.status !== 'paid') return fee;
    return { ...fee, status: deductionEnabled ? 'deducted' : 'retained' };
  });
}

/**
 * R-FV-05 : la déduction est portée par la première séance réalisée, au plus son montant dû, le reste
 * par les suivantes, dans l'ordre. Renvoie la part déduite de chaque montant dû.
 */
export function allocateVisitFeeDeduction(deduction: number, dueAmounts: readonly number[]): number[] {
  let remaining = Math.max(0, deduction);
  return dueAmounts.map((due) => {
    const part = Math.min(remaining, Math.max(0, due));
    remaining -= part;
    return part;
  });
}
