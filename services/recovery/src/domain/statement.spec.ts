import {
  isPeriod,
  periodBounds,
  periodOf,
  periodsToState,
  previousPeriod,
  type StatedCollection,
  statementMovements,
} from './statement';

const collection = (overrides: Partial<StatedCollection>): StatedCollection => ({
  id: '0192f1c4-0000-7000-8000-000000000c01',
  source: 'payment_link',
  settlement: 'deducted',
  gross: 100_000,
  overpaid: 0,
  commission: 10_000,
  net: 90_000,
  creditedAt: new Date('2026-11-10T10:00:00Z'),
  ...overrides,
});

describe('relevé mensuel d’un dossier (R-CO-05)', () => {
  it('mois du Bénin : bornes à minuit heure locale, mois précédent, mois à relever', () => {
    expect(isPeriod('2026-11')).toBe(true);
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('2026-1')).toBe(false);
    // 30 novembre 23 h 30 UTC : déjà le 1er décembre au Bénin.
    expect(periodOf(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12');
    expect(previousPeriod('2027-01')).toBe('2026-12');
    expect(previousPeriod('2026-11')).toBe('2026-10');
    expect(periodBounds('2026-12')).toEqual({
      start: new Date('2026-11-30T23:00:00Z'),
      end: new Date('2026-12-31T23:00:00Z'),
    });
    // Le 1er janvier à 00 h 30 au Bénin : décembre et, en reprise, novembre et octobre.
    expect(periodsToState(new Date('2026-12-31T23:30:00Z'), 2)).toEqual(['2026-12', '2026-11', '2026-10']);
  });

  it('encaissements crédités dans le mois, dans l’ordre ; encaissé − commission − frais = reversé', () => {
    const { movements, totals } = statementMovements(
      [
        collection({ id: 'c-2', creditedAt: new Date('2026-11-25T10:00:00Z') }),
        collection({
          id: 'c-1',
          source: 'offline_cash',
          gross: 60_000,
          overpaid: 10_000,
          commission: 5_000,
          net: 45_000,
          creditedAt: new Date('2026-11-02T10:00:00Z'),
        }),
        // Crédité le 30 novembre à 23 h 30 UTC : le 1er décembre au Bénin, sur le relevé suivant.
        collection({ id: 'c-3', creditedAt: new Date('2026-11-30T23:30:00Z') }),
        // Paiement direct au créancier : rien de reversé, commission facturée par billing.
        collection({
          id: 'c-4',
          source: 'direct_to_creditor',
          settlement: 'invoiced',
          net: 0,
          creditedAt: null,
        }),
        // Pas encore crédité (wallet injoignable) : sur le relevé du mois de son crédit.
        collection({ id: 'c-5', creditedAt: null }),
      ],
      '2026-11',
    );
    expect(movements).toEqual([
      {
        collectionId: 'c-1',
        day: '2026-11-02',
        source: 'offline_cash',
        collected: 50_000,
        commission: 5_000,
        costs: 0,
        remitted: 45_000,
      },
      {
        collectionId: 'c-2',
        day: '2026-11-25',
        source: 'payment_link',
        collected: 100_000,
        commission: 10_000,
        costs: 0,
        remitted: 90_000,
      },
    ]);
    expect(totals).toEqual({ collected: 150_000, commission: 15_000, costs: 0, remitted: 135_000 });
    for (const movement of movements) {
      expect(movement.collected - movement.commission - movement.costs).toBe(movement.remitted);
    }
    expect(statementMovements([collection({})], '2026-10').movements).toEqual([]);
  });
});
