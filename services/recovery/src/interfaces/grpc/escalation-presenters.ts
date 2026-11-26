import { type recoveryV1 } from '@ksp/contracts';
import { type FeeQuoteView, type PartnerRef } from '../../application/litigation/escalation.port';
import { money } from './presenters';

/**
 * Devis d'une étape payante et partenaire nommé (lot R5), présentés seuls (RequestEscalation) ou avec
 * leur décision (ListMyDecisions, AnswerDecision).
 */

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');

export function presentPartnerRef(partner: PartnerRef | null): recoveryV1.PartnerRef | undefined {
  return partner
    ? { id: partner.id, kind: partner.kind, name: partner.name, office: partner.office ?? '' }
    : undefined;
}

export function presentFeeQuote(view: FeeQuoteView): recoveryV1.FeeQuote {
  const quote = view.quote;
  return {
    id: quote.id,
    stage: quote.stage,
    partner: presentPartnerRef(view.partner),
    lines: quote.lines.map((line) => ({ label: line.label, amount: money(line.amount) })),
    total: money(quote.total),
    provision: money(quote.provision),
    documentId: quote.documentId,
    validUntil: iso(quote.validUntil),
  };
}
