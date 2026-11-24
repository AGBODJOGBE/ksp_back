import { IDEMPOTENCY_RETENTION_DAYS, idempotencyCutoff, retentionCutoff } from './retention';

describe('durée de conservation (R-DP-01, partie 16.1)', () => {
  it('N mois civils avant maintenant, à la même heure (UTC)', () => {
    expect(retentionCutoff(new Date('2026-11-04T10:00:00Z'), 12).toISOString()).toBe(
      '2025-11-04T10:00:00.000Z',
    );
    expect(retentionCutoff(new Date('2027-01-15T08:30:15.250Z'), 3).toISOString()).toBe(
      '2026-10-15T08:30:15.250Z',
    );
    expect(retentionCutoff(new Date('2030-06-03T08:00:00Z'), 120).toISOString()).toBe(
      '2020-06-03T08:00:00.000Z',
    );
  });

  it('fin de mois : le jour est ramené au dernier jour du mois visé', () => {
    expect(retentionCutoff(new Date('2027-03-31T12:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T12:00:00.000Z',
    );
    // Année bissextile.
    expect(retentionCutoff(new Date('2028-03-31T12:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T12:00:00.000Z',
    );
    expect(retentionCutoff(new Date('2027-05-31T00:00:00Z'), 1).toISOString()).toBe(
      '2027-04-30T00:00:00.000Z',
    );
    expect(retentionCutoff(new Date('2027-12-31T23:59:59Z'), 10).toISOString()).toBe(
      '2027-02-28T23:59:59.000Z',
    );
  });

  it('une clôture d’il y a N mois et un jour est avant la limite, N mois moins un jour après', () => {
    const now = new Date('2030-06-03T08:00:00Z');
    const cutoff = retentionCutoff(now, 12);
    expect(new Date('2029-06-02T08:00:00Z').getTime()).toBeLessThan(cutoff.getTime());
    expect(new Date('2029-06-04T08:00:00Z').getTime()).toBeGreaterThan(cutoff.getTime());
  });

  it('clés d’idempotence : gardées 7 jours (R-EX-05)', () => {
    expect(IDEMPOTENCY_RETENTION_DAYS).toBe(7);
    expect(idempotencyCutoff(new Date('2030-06-10T08:00:00Z')).toISOString()).toBe(
      '2030-06-03T08:00:00.000Z',
    );
  });
});
