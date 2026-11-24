/**
 * Constat : déclaré, constaté, retenu (partie 7.4) et révisions de la version retenue (RV-59).
 *
 * Matrice règle → test :
 * - 7.4 constaté prérempli avec le déclaré                        → « constaté »
 * - 7.4 motif obligatoire pour chaque écart retenu / constaté      → « motifs des écarts »
 * - R-CS-01 retenu identique au déclaré : prix du simulateur       → « écarts montrés au client »
 * - R-CS-02 tableau déclaré / constaté / retenu, écart, effet prix → « écarts montrés au client »
 * - R-CS-03 retenu d'un devis envoyé figé, nouvelle révision motivée → « révisions (R-CS-03) »
 * - R-VI-07 une nouvelle visite ouvre une nouvelle révision         → « révisions (R-CS-03) »
 * - 15.3 SaveRetainedValues hors visit_done / quote_sent refusé     → « révisions (R-CS-03) »
 */
import { DomainRuleError } from '../requests/errors';
import {
  assertDeviationReasons,
  buildComparison,
  isRetainedConfirmed,
  lockRevision,
  prefillObserved,
  quoteBaseSessionPrice,
  retainedDeviations,
  type RetainedRevision,
  saveRetained,
} from './observation';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-22T12:00:00Z');

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

const declared = { values: { area: 120, soil: 'normal', pets: false }, cleaningTypeIds: ['floor'] };
const observed = { area: 150, soil: 'normal', pets: false };

describe('constaté', () => {
  it('prérempli avec le déclaré, sans le modifier', () => {
    const copy = prefillObserved(declared);
    expect(copy).toEqual(declared.values);
    expect(copy).not.toBe(declared.values);
  });
});

describe('motifs des écarts', () => {
  const retained = { values: { area: 140, soil: 'dirty', pets: false }, cleaningTypeIds: ['windows'] };

  it('liste les écarts avec le constat : paramètres, types ajoutés et retirés', () => {
    expect(retainedDeviations(observed, declared.cleaningTypeIds, retained)).toEqual({
      parameterCodes: ['area', 'soil'],
      addedCleaningTypeIds: ['windows'],
      removedCleaningTypeIds: ['floor'],
    });
  });

  it('un retenu identique au constaté n’exige aucun motif', () => {
    const same = retainedDeviations(observed, ['floor'], { values: observed, cleaningTypeIds: ['floor'] });
    expect(() => assertDeviationReasons(same, [])).not.toThrow();
  });

  it('chaque écart doit avoir son motif', () => {
    const deviations = retainedDeviations(observed, declared.cleaningTypeIds, retained);
    const reasons = [
      { parameterCode: 'area', reason: 'Mesure reprise' },
      { parameterCode: 'soil', reason: 'Après travaux' },
      { cleaningTypeId: 'windows', reason: 'Demandé sur place' },
    ];
    const error = thrown(() => assertDeviationReasons(deviations, reasons));
    expect(error.code).toBe('CLEANING_REASON_REQUIRED');
    expect(error.details).toEqual({ field: 'reasons', missing: ['floor'] });
    const blank = [...reasons, { cleaningTypeId: 'floor', reason: '  ' }];
    expect(thrown(() => assertDeviationReasons(deviations, blank)).details).toEqual({
      field: 'reasons',
      missing: ['floor'],
    });
    expect(() =>
      assertDeviationReasons(deviations, [...reasons, { cleaningTypeId: 'floor', reason: 'Inutile' }]),
    ).not.toThrow();
  });
});

describe('écarts montrés au client', () => {
  it('R-CS-01 : retenu identique au déclaré, « informations confirmées », prix du simulateur', () => {
    const comparison = buildComparison({
      declared: { ...declared, sessionPrice: 18_000 },
      observed: declared.values,
      retained: {
        values: { pets: false, area: 120, soil: 'normal' },
        cleaningTypeIds: ['floor'],
        sessionPrice: 18_500,
      },
    });
    expect(comparison.confirmed).toBe(true);
    expect(quoteBaseSessionPrice(comparison)).toBe(18_000);
  });

  it('R-CS-02 : une ligne par paramètre, écart et effet sur le prix', () => {
    const comparison = buildComparison({
      declared: { ...declared, sessionPrice: 18_000 },
      observed,
      retained: { values: observed, cleaningTypeIds: ['floor'], sessionPrice: 23_400 },
      priceEffects: { area: 5_400 },
    });
    expect(comparison.confirmed).toBe(false);
    expect(comparison.rows).toEqual([
      {
        parameterCode: 'area',
        declared: 120,
        observed: 150,
        retained: 150,
        changed: true,
        delta: 30,
        priceEffect: 5_400,
      },
      {
        parameterCode: 'soil',
        declared: 'normal',
        observed: 'normal',
        retained: 'normal',
        changed: false,
        delta: null,
        priceEffect: 0,
      },
      {
        parameterCode: 'pets',
        declared: false,
        observed: false,
        retained: false,
        changed: false,
        delta: null,
        priceEffect: 0,
      },
    ]);
    expect(comparison.declaredSessionPrice).toBe(18_000);
    expect(quoteBaseSessionPrice(comparison)).toBe(23_400);
  });

  it('types ajoutés ou retirés, paramètre ajouté par le retenu, constat absent', () => {
    const comparison = buildComparison({
      declared: { ...declared, sessionPrice: 18_000 },
      observed: null,
      retained: {
        values: { ...declared.values, rooms: 3 },
        cleaningTypeIds: ['windows'],
        sessionPrice: 20_000,
      },
    });
    expect(comparison.confirmed).toBe(false);
    expect(comparison.addedCleaningTypeIds).toEqual(['windows']);
    expect(comparison.removedCleaningTypeIds).toEqual(['floor']);
    expect(comparison.rows.at(-1)).toEqual({
      parameterCode: 'rooms',
      declared: null,
      observed: null,
      retained: 3,
      changed: true,
      delta: null,
      priceEffect: 0,
    });
  });

  it('paramètre retiré par le retenu : valeur retenue absente', () => {
    const comparison = buildComparison({
      declared: { ...declared, sessionPrice: 18_000 },
      observed,
      retained: { values: { area: 150, soil: 'normal' }, cleaningTypeIds: ['floor'], sessionPrice: 23_400 },
    });
    expect(comparison.rows.find((row) => row.parameterCode === 'pets')).toMatchObject({
      declared: false,
      retained: null,
      changed: true,
    });
  });

  it('confirmé seulement si valeurs et types sont identiques', () => {
    expect(isRetainedConfirmed(declared, { values: declared.values, cleaningTypeIds: ['floor'] })).toBe(true);
    expect(
      isRetainedConfirmed(declared, { values: { area: 120, soil: 'normal' }, cleaningTypeIds: ['floor'] }),
    ).toBe(false);
    expect(
      isRetainedConfirmed(declared, { values: declared.values, cleaningTypeIds: ['floor', 'windows'] }),
    ).toBe(false);
  });
});

describe('révisions (R-CS-03)', () => {
  const input = {
    values: observed,
    cleaningTypeIds: ['floor'],
    reasons: [],
    sessionPrice: 23_400,
  };
  const base = {
    observed,
    declaredCleaningTypeIds: ['floor'],
    currentVisitId: 'visit-1',
    authorId: 'sup-1',
    now: NOW,
  };

  function first(): RetainedRevision {
    return saveRetained({ ...base, requestStatus: 'visit_done', revisions: [], input }).saved;
  }

  it('« visite faite » : crée la révision 1 sans motif, puis la modifie en place', () => {
    const rev1 = first();
    expect(rev1).toMatchObject({
      revision: 1,
      reason: null,
      visitId: 'visit-1',
      lockedAt: null,
      sessionPrice: 23_400,
    });
    const later = at('2026-11-22T13:00:00Z');
    const updated = saveRetained({
      ...base,
      now: later,
      requestStatus: 'visit_done',
      revisions: [rev1],
      input: { ...input, sessionPrice: 23_000 },
    });
    expect(updated.revisions).toHaveLength(1);
    expect(updated.saved).toMatchObject({
      revision: 1,
      sessionPrice: 23_000,
      createdAt: NOW,
      updatedAt: later,
    });
  });

  it('l’envoi du devis fige la révision, sans la redater si elle l’est déjà', () => {
    const locked = lockRevision([first()], 1, NOW);
    expect(locked[0]?.lockedAt).toEqual(NOW);
    expect(lockRevision(locked, 1, at('2026-11-23T12:00:00Z'))[0]?.lockedAt).toEqual(NOW);
    expect(thrown(() => lockRevision(locked, 2, NOW)).code).toBe('CLEANING_INVALID_TRANSITION');
  });

  it('« devis envoyé » : la révision figée ne bouge pas, une nouvelle révision exige un motif', () => {
    const locked = lockRevision([first()], 1, NOW);
    const request = { ...base, requestStatus: 'quote_sent' as const, revisions: locked };
    expect(thrown(() => saveRetained({ ...request, input })).details).toEqual({ field: 'reason' });
    const result = saveRetained({
      ...request,
      input: { ...input, reason: 'Superficie corrigée', sessionPrice: 22_000 },
    });
    expect(result.revisions[0]).toEqual(locked[0]);
    expect(result.saved).toMatchObject({ revision: 2, reason: 'Superficie corrigée', lockedAt: null });
    const again = saveRetained({
      ...request,
      revisions: result.revisions,
      input: { ...input, sessionPrice: 21_000 },
    });
    expect(again.saved).toMatchObject({ revision: 2, reason: 'Superficie corrigée', sessionPrice: 21_000 });
  });

  it('nouvelle visite (R-VI-07) : la révision ouverte de l’ancienne visite est close, une nouvelle s’ouvre', () => {
    const rev1 = first();
    const next = {
      ...base,
      currentVisitId: 'visit-2',
      requestStatus: 'visit_done' as const,
      revisions: [rev1],
    };
    expect(thrown(() => saveRetained({ ...next, input })).code).toBe('CLEANING_REASON_REQUIRED');
    const result = saveRetained({
      ...next,
      input: { ...input, reason: 'Nouvelle visite : accès au jardin' },
    });
    expect(result.revisions.map((rev) => [rev.revision, rev.lockedAt])).toEqual([
      [1, NOW],
      [2, null],
    ]);
    expect(result.saved.visitId).toBe('visit-2');
  });

  it('écart sans motif refusé ; hors « visite faite » ou « devis envoyé » refusé', () => {
    const deviating = { ...input, values: { ...observed, area: 100 } };
    expect(
      thrown(() => saveRetained({ ...base, requestStatus: 'visit_done', revisions: [], input: deviating }))
        .details,
    ).toEqual({
      field: 'reasons',
      missing: ['area'],
    });
    expect(
      thrown(() => saveRetained({ ...base, requestStatus: 'visit_scheduled', revisions: [], input })).details,
    ).toEqual({
      from: 'visit_scheduled',
      to: 'visit_scheduled',
    });
  });
});
