import { DomainRuleError, invalidTransition } from '../requests/errors';
import { addHours } from '../requests/time';
import { acceptQuote, type ConfirmedProgram, declineQuote, type OrganizationStanding } from './acceptance';
import { type OrganizationRole } from '../requests/organization-access';
import {
  assertSessionStarts,
  composeQuote,
  effectiveQuoteStatus,
  expireQuote,
  type Quote,
  type QuoteComposition,
  sendQuote,
} from './quote';

/**
 * Devis rattaché à un programme : renouvellement (R-PG-07) et avenant (R-PG-06). Sa demande est déjà
 * acceptée et le reste : seul le devis change d'état. Les règles du devis (prix strictement positif,
 * remises, délai de la première séance, validité, droits dans l'organisation) sont celles du devis
 * initial, appliquées comme si la demande en était à « visite faite » puis « devis envoyé ». Aucuns
 * frais de visite ne sont déduits : la visite a été déduite du premier programme.
 */
export type ProgramQuoteComposition = Omit<QuoteComposition, 'requestStatus' | 'deductibleVisitFee'>;

export function composeProgramQuote(input: ProgramQuoteComposition): Quote {
  return composeQuote({ ...input, requestStatus: 'visit_done', deductibleVisitFee: 0 });
}

/**
 * Envoi. Une demande ne porte qu'un devis envoyé à la fois : `pending`, le devis encore envoyé sur
 * la demande, est remplacé si le nouveau en est la révision (`replaces`, R-DV-05) ; sinon il doit
 * être périmé (il passe alors « expiré » dans la même écriture), ou l'envoi est refusé
 * (CLEANING_INVALID_TRANSITION).
 */
function settlePending(
  pending: Quote | null,
  replaces: boolean,
  now: Date,
): { expired: Quote | null; superseded: Quote | null } {
  if (!pending) return { expired: null, superseded: null };
  if (effectiveQuoteStatus(pending, now) === 'expired') {
    return { expired: { ...pending, status: 'expired' }, superseded: null };
  }
  if (!replaces) throw invalidTransition('sent', 'sent');
  return { expired: null, superseded: { ...pending, status: 'superseded' } };
}

export function sendProgramQuote(input: {
  quote: Quote;
  pending: Quote | null;
  /** Le devis envoyé révise `pending` (même nature, même programme). */
  replaces?: boolean;
  validityDays: number;
  firstSessionLeadHours: number;
  now: Date;
}): { quote: Quote; expired: Quote | null; superseded: Quote | null } {
  const settled = settlePending(input.pending, input.replaces ?? false, input.now);
  const sent = sendQuote({
    quote: input.quote,
    requestStatus: 'visit_done',
    previous: null,
    validityDays: input.validityDays,
    firstSessionLeadHours: input.firstSessionLeadHours,
    now: input.now,
  });
  return { quote: sent.quote, ...settled };
}

// --- Avenant (R-PG-06) -------------------------------------------------------------------------------

const sorted = (starts: readonly Date[]) => [...starts].sort((a, b) => a.getTime() - b.getTime());

/**
 * Devis d'avenant : il décrit le programme après l'avenant, soit les séances non démarrées
 * (`remainingStarts`) et les séances ajoutées (`addedStarts`), toutes au nouveau prix. Le délai
 * minimum avant une première séance ne vaut que pour les séances ajoutées : celles du programme ont
 * déjà leur date.
 */
export function composeAmendmentQuote(
  input: Omit<ProgramQuoteComposition, 'sessionStarts'> & {
    remainingStarts: readonly Date[];
    addedStarts: readonly Date[];
  },
): Quote {
  const added = sorted(input.addedStarts);
  if (added.length) assertSessionStarts(added, input.firstSessionLeadHours, input.now);
  const starts = sorted([...input.remainingStarts, ...added]);
  if (starts.length === 0) throw new DomainRuleError('CLEANING_SCHEDULE_EMPTY');
  // Prix, équipe et remises contrôlés comme pour tout devis, sur une date neutre.
  const priced = composeQuote({
    ...input,
    requestStatus: 'visit_done',
    deductibleVisitFee: 0,
    sessionStarts: [input.now],
    firstSessionLeadHours: 0,
  });
  return {
    ...priced,
    sessionStarts: starts,
    sessionsCount: starts.length,
    total: priced.sessionPrice * starts.length,
    visitFeeDeduction: 0,
  };
}

/** Envoi d'un devis d'avenant : dates gardées telles quelles, délai contrôlé sur les séances ajoutées. */
export function sendAmendmentQuote(input: {
  quote: Quote;
  addedStarts: readonly Date[];
  pending: Quote | null;
  replaces: boolean;
  validityDays: number;
  firstSessionLeadHours: number;
  now: Date;
}): { quote: Quote; expired: Quote | null; superseded: Quote | null } {
  const settled = settlePending(input.pending, input.replaces, input.now);
  const added = sorted(input.addedStarts);
  if (added.length) assertSessionStarts(added, input.firstSessionLeadHours, input.now);
  const sent = sendQuote({
    quote: input.quote,
    requestStatus: 'visit_done',
    previous: null,
    sessionStarts: [input.now],
    validityDays: input.validityDays,
    firstSessionLeadHours: 0,
    now: input.now,
  });
  return {
    quote: {
      ...sent.quote,
      sessionStarts: input.quote.sessionStarts,
      sessionsCount: input.quote.sessionsCount,
      total: input.quote.total,
      visitFeeDeduction: 0,
    },
    ...settled,
  };
}

/**
 * Acceptation d'un devis d'avenant (R-AC-01, R-AC-02) : aucun programme n'est créé ; le programme
 * visé est complété par l'application. Le délai minimum ne vaut que pour les séances ajoutées.
 */
export function acceptAmendmentQuote(input: {
  quote: Quote;
  organization: OrganizationStanding | null;
  addedStarts: readonly Date[];
  firstSessionLeadHours: number;
  userId: string;
  now: Date;
}): Quote {
  const accepted = acceptQuote({
    quote: input.quote,
    requestStatus: 'quote_sent',
    organization: input.organization,
    fees: [],
    sessionStarts: [addHours(input.now, input.firstSessionLeadHours)],
    firstSessionLeadHours: input.firstSessionLeadHours,
    userId: input.userId,
    now: input.now,
  });
  const added = sorted(input.addedStarts);
  if (added.length) assertSessionStarts(added, input.firstSessionLeadHours, input.now);
  return accepted.quote;
}

/** Acceptation : mêmes contrôles que le devis initial (R-AC-01, R-AC-02), sans frais de visite. */
export function acceptProgramQuote(input: {
  quote: Quote;
  organization: OrganizationStanding | null;
  startDate?: string | null;
  sessionStarts?: readonly Date[];
  firstSessionLeadHours: number;
  userId: string;
  now: Date;
}): { quote: Quote; program: ConfirmedProgram } {
  const accepted = acceptQuote({ ...input, requestStatus: 'quote_sent', fees: [] });
  return { quote: accepted.quote, program: accepted.program };
}

/** Refus (R-AC-03) : la demande et le programme ne changent pas. */
export function declineProgramQuote(input: {
  quote: Quote;
  role: OrganizationRole | null;
  reasonCode?: string | null;
  comment?: string | null;
  userId: string;
  now: Date;
}): Quote {
  return declineQuote({ ...input, requestStatus: 'quote_sent', fees: [] }).quote;
}

/** Expiration (R-AC-04) : seul le devis passe « expiré ». */
export function expireProgramQuote(quote: Quote, now: Date): Quote {
  return expireQuote({ quote, requestStatus: 'quote_sent', fees: [], now }).quote;
}
