import { DomainRuleError, invalidTransition, requireReason } from '../requests/errors';
import {
  assertRequestTransition,
  effectiveRequestStatus,
  type RequestStatus,
  type RequestTimeline,
} from '../requests/request-status';
import { addDays, addHours, isPastDeadline } from '../requests/time';
import { retainVisitFee, type VisitFee } from '../requests/visit-fee';
import { assertQuoteTransition, type QuoteStatus } from './quote-status';

/**
 * Ligne de devis déjà chiffrée (contrat QuoteLine, R-DV-07) : une par offre au prix du calcul retenu,
 * puis la « Remise pack » négative. Type minimal en attendant le domaine du prix (lot A), qui la
 * produira depuis son calcul ; ce module ne calcule aucun prix, il contrôle et additionne.
 */
export interface PricedLine {
  offerId: string;
  cleaningTypeId: string;
  name: string;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  /** Montant de la ligne pour une séance, en FCFA entiers (négatif pour la remise pack). */
  amount: number;
  kind: 'offer' | 'pack_discount';
}

/** Remise ou majoration manuelle demandée (contrat AdjustmentInput, R-DV-03). */
export interface AdjustmentInput {
  kind: 'discount' | 'surcharge';
  /** Pourcentage du prix d'une séance en points de base (2000 = 20 %) ; ou `fixedAmount`. */
  percentBps?: number | null;
  /** Montant fixe par séance ; ou `percentBps`. */
  fixedAmount?: number | null;
  reason: string;
}

export interface QuoteAdjustment extends AdjustmentInput {
  /** Effet sur le prix d'une séance : négatif pour une remise. */
  amount: number;
  approvalStatus: 'not_required' | 'pending' | 'approved';
  approvedBy: string | null;
}

export type PaymentTerms = 'per_session' | 'monthly_invoice';

export interface Quote {
  id: string;
  requestId: string;
  /** Révision du devis (R-DV-05). */
  version: number;
  status: QuoteStatus;
  /** Révision retenue citée, figée à l'envoi (R-CS-03). */
  retainedRevision: number;
  lines: PricedLine[];
  /** Prix d'une séance du calcul retenu, ou du simulateur si les informations sont confirmées (R-CS-01). */
  basePrice: number;
  adjustments: QuoteAdjustment[];
  /** Prix d'une séance, strictement positif (R-DV-03). */
  sessionPrice: number;
  sessionStarts: Date[];
  sessionsCount: number;
  /** Somme des séances (R-PG-05). */
  total: number;
  /** Frais de visite payés à déduire, avant plafonnement au total. */
  deductibleVisitFee: number;
  /** Frais de visite déduits (R-FV-05), au plus le total. */
  visitFeeDeduction: number;
  teamSize: number;
  durationMinutes: number;
  paymentTerms: PaymentTerms;
  termsVersion: string;
  validUntil: Date | null;
  sentAt: Date | null;
  expiryRemindedAt: Date | null;
  respondedAt: Date | null;
  respondedBy: string | null;
  declineReasonCode: string | null;
  declineComment: string | null;
  /** Date de début choisie à l'acceptation, AAAA-MM-JJ à Porto-Novo (R-AC-01). */
  acceptedStartDate: string | null;
  withdrawnAt: Date | null;
  withdrawnBy: string | null;
  withdrawalReason: string | null;
  createdBy: string;
  createdAt: Date;
}

/** Composition d'un devis (CreateQuote) : tout ce qu'il faut, prix déjà calculés compris. */
export interface QuoteComposition {
  id: string;
  requestId: string;
  version: number;
  /** Statut effectif de la demande. */
  requestStatus: RequestStatus;
  retainedRevision: number;
  lines: PricedLine[];
  basePrice: number;
  adjustments: readonly AdjustmentInput[];
  /** Dates du programme recalculées (R-DV-01). */
  sessionStarts: readonly Date[];
  teamSize: number;
  durationMinutes: number;
  paymentTerms: PaymentTerms;
  termsVersion: string;
  /** Frais de visite déductibles (R-FV-05), déjà réduits à 0 si la déduction est désactivée. */
  deductibleVisitFee: number;
  /** Remise maximale sans validation d'un admin (16.1 : 20 %). */
  discountApprovalThresholdPercent: number;
  /** Délai minimum avant la première séance (16.1 : 48 h). */
  firstSessionLeadHours: number;
  createdBy: string;
  now: Date;
}

function invalidAdjustment(reason: 'required' | 'out_of_range'): DomainRuleError {
  return new DomainRuleError('CLEANING_VALIDATION_FAILED', { field: 'adjustments', reason });
}

/** Effet d'une remise ou d'une majoration sur le prix d'une séance, arrondi au franc. */
export function adjustmentAmount(basePrice: number, input: AdjustmentInput): number {
  requireReason(input.reason, 'adjustments');
  const hasPercent = input.percentBps !== undefined && input.percentBps !== null;
  const hasFixed = input.fixedAmount !== undefined && input.fixedAmount !== null;
  if (hasPercent === hasFixed) throw invalidAdjustment('required');
  const value = (hasPercent ? input.percentBps : input.fixedAmount) as number;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidAdjustment('out_of_range');
  const magnitude = hasPercent ? Math.round((basePrice * value) / 10_000) : value;
  return input.kind === 'discount' ? -magnitude : magnitude;
}

/**
 * R-DV-03 : une remise de plus de `thresholdPercent` exige la validation d'un admin. Interprétation :
 * on cumule toutes les remises (sans les compenser par les majorations), rapportées au prix de base ;
 * le seuil exact ne l'exige pas (« plus de »).
 */
export function discountNeedsApproval(
  basePrice: number,
  adjustments: readonly Pick<QuoteAdjustment, 'amount'>[],
  thresholdPercent: number,
): boolean {
  const discounts = adjustments.reduce((sum, item) => sum + Math.max(0, -item.amount), 0);
  return discounts * 100 > basePrice * thresholdPercent;
}

function pricedAdjustments(
  basePrice: number,
  inputs: readonly AdjustmentInput[],
  thresholdPercent: number,
): QuoteAdjustment[] {
  const priced = inputs.map((input) => ({ input, amount: adjustmentAmount(basePrice, input) }));
  const approval = discountNeedsApproval(basePrice, priced, thresholdPercent);
  return priced.map(({ input, amount }) => ({
    kind: input.kind,
    percentBps: input.percentBps ?? null,
    fixedAmount: input.fixedAmount ?? null,
    reason: input.reason.trim(),
    amount,
    approvalStatus: input.kind === 'discount' && approval ? 'pending' : 'not_required',
    approvedBy: null,
  }));
}

/** R-DV-01, RV-55, R-PG-03 : au moins une date, la première au moins `leadHours` après maintenant. */
export function assertSessionStarts(starts: readonly Date[], leadHours: number, now: Date): void {
  const first = starts[0];
  if (!first) throw new DomainRuleError('CLEANING_SCHEDULE_EMPTY');
  if (first.getTime() < addHours(now, leadHours).getTime()) {
    throw new DomainRuleError('CLEANING_LEAD_TIME_TOO_SHORT', { minimumHours: leadHours });
  }
}

function schedule(starts: readonly Date[], sessionPrice: number, deductibleVisitFee: number) {
  const sorted = [...starts].sort((a, b) => a.getTime() - b.getTime());
  const total = sessionPrice * sorted.length;
  return {
    sessionStarts: sorted,
    sessionsCount: sorted.length,
    total,
    visitFeeDeduction: Math.min(deductibleVisitFee, total),
  };
}

const sum = (amounts: readonly number[]) => amounts.reduce((total, amount) => total + amount, 0);

/** CreateQuote (UC-NT-33) : brouillon d'un devis, ou de sa révision quand un devis est envoyé. */
export function composeQuote(input: QuoteComposition): Quote {
  const status = input.requestStatus;
  if (status !== 'visit_done' && status !== 'quote_sent') throw invalidTransition(status, status);
  if (!Number.isSafeInteger(input.teamSize) || input.teamSize < 1) {
    throw new DomainRuleError('CLEANING_VALIDATION_FAILED', { field: 'teamSize', reason: 'out_of_range' });
  }
  const adjustments = pricedAdjustments(
    input.basePrice,
    input.adjustments,
    input.discountApprovalThresholdPercent,
  );
  const sessionPrice = input.basePrice + sum(adjustments.map((item) => item.amount));
  if (sessionPrice <= 0) throw new DomainRuleError('CLEANING_PRICE_NOT_POSITIVE');
  const sorted = [...input.sessionStarts].sort((a, b) => a.getTime() - b.getTime());
  assertSessionStarts(sorted, input.firstSessionLeadHours, input.now);
  return {
    id: input.id,
    requestId: input.requestId,
    version: input.version,
    status: 'draft',
    retainedRevision: input.retainedRevision,
    lines: [...input.lines],
    basePrice: input.basePrice,
    adjustments,
    sessionPrice,
    ...schedule(sorted, sessionPrice, input.deductibleVisitFee),
    deductibleVisitFee: input.deductibleVisitFee,
    teamSize: input.teamSize,
    durationMinutes: input.durationMinutes,
    paymentTerms: input.paymentTerms,
    termsVersion: input.termsVersion,
    validUntil: null,
    sentAt: null,
    expiryRemindedAt: null,
    respondedAt: null,
    respondedBy: null,
    declineReasonCode: null,
    declineComment: null,
    acceptedStartDate: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawalReason: null,
    createdBy: input.createdBy,
    createdAt: input.now,
  };
}

export type QuoteDraftChanges = Partial<
  Pick<
    QuoteComposition,
    'lines' | 'basePrice' | 'adjustments' | 'sessionStarts' | 'teamSize' | 'durationMinutes'
  >
>;

/**
 * UpdateQuoteDraft : brouillon seulement, champs absents inchangés. Interprétation : toute
 * modification recalcule le devis et redemande la validation d'une remise au-delà du seuil.
 */
export function updateQuoteDraft(
  quote: Quote,
  changes: QuoteDraftChanges,
  context: Pick<
    QuoteComposition,
    | 'requestStatus'
    | 'deductibleVisitFee'
    | 'discountApprovalThresholdPercent'
    | 'firstSessionLeadHours'
    | 'now'
  >,
): Quote {
  if (quote.status !== 'draft') throw invalidTransition(quote.status, quote.status);
  const recomposed = composeQuote({
    ...quote,
    ...context,
    adjustments: quote.adjustments,
    ...changes,
    createdBy: quote.createdBy,
  });
  return { ...recomposed, createdAt: quote.createdAt };
}

/**
 * R-DV-03 : validation d'une remise au-delà du seuil par une personne autre que l'auteur du devis
 * (la permission cleaning.quote.adjust_price est contrôlée par l'application). Rejouable sans effet.
 */
export function approveAdjustments(quote: Quote, approverId: string): Quote {
  if (quote.status !== 'draft') throw invalidTransition(quote.status, quote.status);
  if (!quote.adjustments.some((item) => item.approvalStatus === 'pending')) return quote;
  if (approverId === quote.createdBy) throw new DomainRuleError('CLEANING_SECOND_APPROVER_REQUIRED');
  return {
    ...quote,
    adjustments: quote.adjustments.map((item) =>
      item.approvalStatus === 'pending'
        ? { ...item, approvalStatus: 'approved', approvedBy: approverId }
        : item,
    ),
  };
}

/** Statut lu d'après l'heure : un devis envoyé dont la validité est passée est expiré (15.2). */
export function effectiveQuoteStatus(quote: Pick<Quote, 'status' | 'validUntil'>, now: Date): QuoteStatus {
  if (quote.status === 'sent' && quote.validUntil && isPastDeadline(quote.validUntil, now)) return 'expired';
  return quote.status;
}

/**
 * SendQuote (R-DV-02, R-DV-04, R-DV-07, R-CS-03) : prix figé, dates recalculées (`sessionStarts`, sinon
 * celles du brouillon), validité de `validityDays` jours. « Visite faite » : la demande passe « devis
 * envoyé ». « Devis envoyé » : c'est une révision, qui remplace le devis envoyé (`superseded`).
 * La révision retenue citée est figée à part (`lockRevision`).
 */
export function sendQuote(input: {
  quote: Quote;
  requestStatus: RequestStatus;
  previous: Quote | null;
  sessionStarts?: readonly Date[];
  validityDays: number;
  firstSessionLeadHours: number;
  now: Date;
}): { quote: Quote; superseded: Quote | null; requestStatus: 'quote_sent' } {
  const { quote, now } = input;
  assertQuoteTransition(quote.status, 'sent');
  let superseded: Quote | null = null;
  if (input.requestStatus === 'visit_done') {
    assertRequestTransition('visit_done', 'quote_sent');
  } else if (input.requestStatus === 'quote_sent' && input.previous) {
    assertQuoteTransition(effectiveQuoteStatus(input.previous, now), 'superseded');
    superseded = { ...input.previous, status: 'superseded' };
  } else {
    throw invalidTransition(input.requestStatus, 'quote_sent');
  }
  if (quote.adjustments.some((item) => item.approvalStatus === 'pending')) {
    throw new DomainRuleError('CLEANING_QUOTE_APPROVAL_REQUIRED');
  }
  if (quote.sessionPrice <= 0) throw new DomainRuleError('CLEANING_PRICE_NOT_POSITIVE');
  const linesTotal =
    sum(quote.lines.map((line) => line.amount)) + sum(quote.adjustments.map((item) => item.amount));
  if (linesTotal !== quote.sessionPrice) {
    throw new DomainRuleError('CLEANING_VALIDATION_FAILED', {
      field: 'lines',
      reason: 'lines_total_mismatch',
    });
  }
  const starts = [...(input.sessionStarts ?? quote.sessionStarts)].sort((a, b) => a.getTime() - b.getTime());
  assertSessionStarts(starts, input.firstSessionLeadHours, now);
  return {
    quote: {
      ...quote,
      ...schedule(starts, quote.sessionPrice, quote.deductibleVisitFee),
      status: 'sent',
      sentAt: now,
      validUntil: addDays(now, input.validityDays),
    },
    superseded,
    requestStatus: 'quote_sent',
  };
}

/**
 * R-DV-04 (RV-53) : rappel `reminderDays` jours avant l'expiration, une seule fois par devis envoyé
 * (une révision a son propre rappel), jamais avec 0, jamais une fois le devis périmé.
 */
export function isReminderDue(quote: Quote, now: Date, reminderDays: number): boolean {
  if (reminderDays <= 0 || quote.status !== 'sent' || !quote.validUntil || quote.expiryRemindedAt)
    return false;
  return (
    !isPastDeadline(quote.validUntil, now) && isPastDeadline(addDays(quote.validUntil, -reminderDays), now)
  );
}

export function markReminded(quote: Quote, now: Date): Quote {
  return { ...quote, expiryRemindedAt: now };
}

/**
 * R-AC-04 : sans réponse à la date de validité, le devis et le dossier passent « expiré » ; les frais
 * de visite payés sont conservés (R-FV-06).
 */
export function expireQuote(input: {
  quote: Quote;
  requestStatus: RequestStatus;
  fees: readonly VisitFee[];
  now: Date;
}): { quote: Quote; requestStatus: 'expired'; fees: VisitFee[] } {
  if (effectiveQuoteStatus(input.quote, input.now) !== 'expired')
    throw invalidTransition(input.quote.status, 'expired');
  assertQuoteTransition(input.quote.status, 'expired');
  assertRequestTransition(input.requestStatus, 'expired');
  return {
    quote: { ...input.quote, status: 'expired' },
    requestStatus: 'expired',
    fees: input.fees.map(retainVisitFee),
  };
}

/**
 * R-VI-07 : depuis « visite faite » ou « devis envoyé » (encore valable), la supervision demande une
 * nouvelle visite avec un motif ; le devis envoyé est retiré, la demande repasse « visite à
 * planifier ». La visite est gratuite : les derniers frais payés la couvrent (`feeCoveringNextVisit`).
 */
export function requestNewVisit(input: {
  request: RequestTimeline;
  sentQuote: Quote | null;
  reason: string;
  staffId: string;
  now: Date;
}): { requestStatus: 'visit_to_schedule'; withdrawn: Quote | null } {
  const status = effectiveRequestStatus(input.request, input.now);
  if (status !== 'visit_done' && status !== 'quote_sent')
    throw invalidTransition(status, 'visit_to_schedule');
  const reason = requireReason(input.reason);
  if (status === 'visit_done') return { requestStatus: 'visit_to_schedule', withdrawn: null };
  if (!input.sentQuote) throw invalidTransition(status, 'visit_to_schedule');
  assertQuoteTransition(input.sentQuote.status, 'withdrawn');
  return {
    requestStatus: 'visit_to_schedule',
    withdrawn: {
      ...input.sentQuote,
      status: 'withdrawn',
      withdrawnAt: input.now,
      withdrawnBy: input.staffId,
      withdrawalReason: reason,
    },
  };
}
