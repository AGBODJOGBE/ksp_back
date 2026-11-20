import { DomainRuleError } from '../requests/errors';
import {
  acceptanceStanding,
  assertNotAtUnpaidThreshold,
  atSuspensionThreshold,
  requestWarnings,
} from './acceptance';
import { DEFAULT_UNPAID_THRESHOLDS } from './standing';

describe('organisation au seuil d’impayés (RV-86, R-AC-02)', () => {
  it('au seuil de suspension : acceptation refusée, avec le compte et le seuil', () => {
    expect(atSuspensionThreshold(2, DEFAULT_UNPAID_THRESHOLDS)).toBe(true);
    expect(atSuspensionThreshold(1, DEFAULT_UNPAID_THRESHOLDS)).toBe(false);
    expect(() => assertNotAtUnpaidThreshold(1, DEFAULT_UNPAID_THRESHOLDS)).not.toThrow();
    let error: unknown;
    try {
      assertNotAtUnpaidThreshold(3, DEFAULT_UNPAID_THRESHOLDS);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DomainRuleError);
    expect(error).toMatchObject({
      code: 'CLEANING_ORGANIZATION_UNPAID_INVOICES',
      details: { unpaidCount: 3, threshold: 2 },
    });
  });

  it('demande, frais et visite restent possibles, avec un avertissement non bloquant', () => {
    expect(requestWarnings({ overdueCount: 2 }, DEFAULT_UNPAID_THRESHOLDS)).toEqual([
      'organization_unpaid_invoices',
    ]);
    expect(requestWarnings({ overdueCount: 1 }, DEFAULT_UNPAID_THRESHOLDS)).toEqual([]);
    expect(requestWarnings(null, DEFAULT_UNPAID_THRESHOLDS)).toEqual([]);
  });

  it('situation passée à acceptQuote : compte de cleaning et seuil des réglages', () => {
    expect(
      acceptanceStanding({
        role: 'org_admin',
        suspended: false,
        overdueCount: 2,
        thresholds: { warning: 1, suspension: 3 },
      }),
    ).toEqual({ role: 'org_admin', suspended: false, unpaidInvoices: 2, unpaidInvoicesSuspension: 3 });
  });
});
