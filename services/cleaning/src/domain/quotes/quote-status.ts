import { invalidTransition } from '../requests/errors';

/** Statuts d'un devis (valeurs du contrat Quote.status, partie 15.2). */
export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'superseded',
  'withdrawn',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * Partie 15.2 : `draft` → `sent` → `accepted` / `declined` / `expired` / `superseded` ; `sent` →
 * `withdrawn` (nouvelle visite demandée par KSP, R-VI-07). Toute autre transition est refusée.
 */
const TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  draft: ['sent'],
  sent: ['accepted', 'declined', 'expired', 'superseded', 'withdrawn'],
  accepted: [],
  declined: [],
  expired: [],
  superseded: [],
  withdrawn: [],
};

export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!canTransitionQuote(from, to)) throw invalidTransition(from, to);
}
