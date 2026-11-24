/**
 * Statuts du devis (partie 15.2).
 *
 * Matrice règle → test :
 * - 15.2 (devis) draft → sent → accepted / declined / expired / superseded → « transitions de 15.2 »
 * - 15.2 / R-VI-07 sent → withdrawn                                        → « transitions de 15.2 »
 * - 15.2 toute autre transition : CLEANING_INVALID_TRANSITION              → « refuse le reste »
 */
import { DomainRuleError } from '../requests/errors';
import { assertQuoteTransition, canTransitionQuote, QUOTE_STATUSES } from './quote-status';

describe('transitions de 15.2', () => {
  it('brouillon envoyé, puis une seule réponse', () => {
    expect(canTransitionQuote('draft', 'sent')).toBe(true);
    for (const to of ['accepted', 'declined', 'expired', 'superseded', 'withdrawn'] as const) {
      expect(canTransitionQuote('sent', to)).toBe(true);
    }
  });
});

describe('refuse le reste', () => {
  it('un brouillon n’est ni accepté ni retiré ; les statuts finaux sont figés', () => {
    expect(canTransitionQuote('draft', 'accepted')).toBe(false);
    expect(canTransitionQuote('draft', 'withdrawn')).toBe(false);
    expect(canTransitionQuote('sent', 'draft')).toBe(false);
    for (const from of ['accepted', 'declined', 'expired', 'superseded', 'withdrawn'] as const) {
      for (const to of QUOTE_STATUSES) expect(canTransitionQuote(from, to)).toBe(false);
    }
  });

  it('répond CLEANING_INVALID_TRANSITION avec from et to', () => {
    expect(() => assertQuoteTransition('sent', 'sent')).toThrow(DomainRuleError);
    try {
      assertQuoteTransition('withdrawn', 'accepted');
    } catch (error) {
      expect((error as DomainRuleError).details).toEqual({ from: 'withdrawn', to: 'accepted' });
    }
    expect(() => assertQuoteTransition('draft', 'sent')).not.toThrow();
  });
});
