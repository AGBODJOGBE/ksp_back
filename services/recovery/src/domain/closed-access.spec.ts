import { closedAccessEnd, DEFAULT_CLOSED_ACCESS_DAYS, debtorAccessMode } from './debtor-access';

const closedAt = new Date('2026-11-20T10:00:00Z');
const at = (iso: string) => new Date(iso);

describe('espace du débiteur après la clôture (ADR-061 complété)', () => {
  it('lecture seule 30 jours par défaut, réglable ; 0 : aucun accès', () => {
    expect(DEFAULT_CLOSED_ACCESS_DAYS).toBe(30);
    expect(closedAccessEnd(closedAt, 30)).toEqual(at('2026-12-20T10:00:00Z'));
    expect(closedAccessEnd(closedAt, 7)).toEqual(at('2026-11-27T10:00:00Z'));
    expect(closedAccessEnd(closedAt, 0)).toBeNull();
  });

  it('accès complet pour un dossier en cours, lecture seule après la clôture, rien au-delà', () => {
    const now = at('2026-12-01T10:00:00Z');
    expect(debtorAccessMode('active', null, now, 30)).toBe('full');
    expect(debtorAccessMode('suspended', null, now, 30)).toBe('full');
    expect(debtorAccessMode('closed', closedAt, now, 30)).toBe('read_only');
    expect(debtorAccessMode('closed', closedAt, at('2026-12-20T09:59:59Z'), 30)).toBe('read_only');
    expect(debtorAccessMode('closed', closedAt, at('2026-12-20T10:00:00Z'), 30)).toBeNull();
    expect(debtorAccessMode('closed', closedAt, now, 0)).toBeNull();
  });

  it('aucun accès pour un dossier refusé, pas encore actif, ou clos à une date inconnue', () => {
    const now = at('2026-11-21T10:00:00Z');
    for (const status of ['draft', 'awaiting_fee', 'under_review', 'info_requested', 'rejected'] as const) {
      expect(debtorAccessMode(status, closedAt, now, 30)).toBeNull();
    }
    expect(debtorAccessMode('closed', null, now, 30)).toBeNull();
  });
});
