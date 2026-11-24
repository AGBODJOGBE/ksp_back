import { DomainRuleError, invalidTransition } from '../requests/errors';
import { assertOrganizationRight, type OrganizationRole } from '../requests/organization-access';
import { assertRequestTransition, type RequestStatus } from '../requests/request-status';
import { localDay } from '../requests/time';
import {
  allocateVisitFeeDeduction,
  retainVisitFee,
  settleVisitFeesOnAcceptance,
  type VisitFee,
} from '../requests/visit-fee';
import { assertSessionStarts, effectiveQuoteStatus, type Quote } from './quote';
import { assertQuoteTransition } from './quote-status';

/** Situation de l'organisation du contexte actif au moment d'agir (R-AC-02, R-PE-06). */
export interface OrganizationStanding {
  role: OrganizationRole;
  suspended: boolean;
  /** Factures impayées de l'organisation comptées par cleaning (RV-87). */
  unpaidInvoices: number;
  /** Seuil de suspension des réglages (16.1 : 2). */
  unpaidInvoicesSuspension: number;
}

/** Séance créée à l'acceptation (R-PG-05), avec sa part des frais de visite déduits (R-FV-05). */
export interface ConfirmedSession {
  rank: number;
  scheduledStart: Date;
  price: number;
  visitFeeDeduction: number;
  status: 'to_assign';
}

/** Programme confirmé (partie 8) : devis accepté, séances créées, affectation des agents à venir. */
export interface ConfirmedProgram {
  status: 'confirmed';
  payerKind: 'individual' | 'organization';
  quoteId: string;
  /** Somme des séances (R-PG-05). */
  total: number;
  visitFeeDeduction: number;
  sessions: ConfirmedSession[];
}

/**
 * R-AC-01 : la date de début se décale « dans la limite de la validité ». Interprétation : le jour
 * choisi (AAAA-MM-JJ, Porto-Novo) ne dépasse pas le jour local de fin de validité du devis.
 */
export function assertStartDateWithinValidity(startDate: string, validUntil: Date): void {
  if (startDate > localDay(validUntil)) {
    throw new DomainRuleError('CLEANING_VALIDATION_FAILED', { field: 'startDate', reason: 'out_of_range' });
  }
}

/**
 * Accepter un devis (UC-NT-08, R-AC-01, R-AC-02, R-PG-03, R-PG-05, R-FV-05). Les dates du programme
 * (décalées si le client a choisi une autre date de début) sont générées hors de ce module et passées
 * dans `sessionStarts` ; absentes, ce sont celles du devis.
 */
export function acceptQuote(input: {
  quote: Quote;
  requestStatus: RequestStatus;
  /** null : contexte personnel. */
  organization: OrganizationStanding | null;
  fees: readonly VisitFee[];
  startDate?: string | null;
  sessionStarts?: readonly Date[];
  firstSessionLeadHours: number;
  userId: string;
  now: Date;
}): { quote: Quote; requestStatus: 'accepted'; fees: VisitFee[]; program: ConfirmedProgram } {
  const { quote, organization, now } = input;
  assertOrganizationRight(organization?.role ?? null, 'accept_quote');
  const status = effectiveQuoteStatus(quote, now);
  if (status === 'expired') throw new DomainRuleError('CLEANING_QUOTE_EXPIRED');
  assertQuoteTransition(status, 'accepted');
  assertRequestTransition(input.requestStatus, 'accepted');
  if (organization?.suspended) throw new DomainRuleError('CLEANING_ORGANIZATION_SUSPENDED');
  if (organization && organization.unpaidInvoices >= organization.unpaidInvoicesSuspension) {
    throw new DomainRuleError('CLEANING_ORGANIZATION_UNPAID_INVOICES', {
      unpaidCount: organization.unpaidInvoices,
      threshold: organization.unpaidInvoicesSuspension,
    });
  }
  if (input.startDate && quote.validUntil) assertStartDateWithinValidity(input.startDate, quote.validUntil);
  const starts = [...(input.sessionStarts ?? quote.sessionStarts)].sort((a, b) => a.getTime() - b.getTime());
  assertSessionStarts(starts, input.firstSessionLeadHours, now);

  const total = quote.sessionPrice * starts.length;
  const deduction = Math.min(quote.visitFeeDeduction, total);
  const parts = allocateVisitFeeDeduction(
    deduction,
    starts.map(() => quote.sessionPrice),
  );
  return {
    quote: {
      ...quote,
      status: 'accepted',
      respondedAt: now,
      respondedBy: input.userId,
      acceptedStartDate: input.startDate ?? null,
    },
    requestStatus: 'accepted',
    fees: settleVisitFeesOnAcceptance(input.fees, quote.visitFeeDeduction > 0),
    program: {
      status: 'confirmed',
      payerKind: quote.paymentTerms === 'monthly_invoice' ? 'organization' : 'individual',
      quoteId: quote.id,
      total,
      visitFeeDeduction: deduction,
      sessions: starts.map((scheduledStart, index) => ({
        rank: index + 1,
        scheduledStart,
        price: quote.sessionPrice,
        visitFeeDeduction: parts[index] ?? 0,
        status: 'to_assign',
      })),
    },
  };
}

/** Motifs de refus d'un devis, liste du contrat (DeclineQuoteRequest.reason_code). */
export const DECLINE_REASON_CODES = ['price', 'schedule', 'no_longer_needed', 'other'] as const;

/**
 * Refuser un devis (UC-NT-09, R-AC-03) : motif facultatif (liste et texte), dossier clos, frais de
 * visite conservés (R-FV-06). Devis périmé ou retiré : CLEANING_INVALID_TRANSITION (RV-14).
 */
export function declineQuote(input: {
  quote: Quote;
  requestStatus: RequestStatus;
  role: OrganizationRole | null;
  reasonCode?: string | null;
  comment?: string | null;
  fees: readonly VisitFee[];
  userId: string;
  now: Date;
}): { quote: Quote; requestStatus: 'declined'; fees: VisitFee[] } {
  assertOrganizationRight(input.role, 'decline_quote');
  assertQuoteTransition(effectiveQuoteStatus(input.quote, input.now), 'declined');
  assertRequestTransition(input.requestStatus, 'declined');
  const code = input.reasonCode || null;
  if (code && !(DECLINE_REASON_CODES as readonly string[]).includes(code)) {
    throw new DomainRuleError('CLEANING_VALIDATION_FAILED', {
      field: 'reasonCode',
      reason: 'unknown_choice',
    });
  }
  return {
    quote: {
      ...input.quote,
      status: 'declined',
      respondedAt: input.now,
      respondedBy: input.userId,
      declineReasonCode: code,
      declineComment: input.comment?.trim() || null,
    },
    requestStatus: 'declined',
    fees: input.fees.map(retainVisitFee),
  };
}

/**
 * Transmettre un devis pour accord (R-AC-02) : un membre le transmet aux administrateurs. Rejouable
 * sans effet ; un devis qui n'est plus envoyé et valable est refusé.
 */
export function forwardQuote(input: { quote: Quote; role: OrganizationRole | null; now: Date }): Quote {
  assertOrganizationRight(input.role, 'forward_quote');
  const status = effectiveQuoteStatus(input.quote, input.now);
  if (status !== 'sent') throw invalidTransition(status, status);
  return input.quote;
}
