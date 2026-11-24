import {
  DEFAULT_COMMON_CHECKLIST,
  DEFAULT_SETTINGS,
  mergeSettings,
  type ModuleSettings,
  SETTING_BOUNDS,
  settingsChanges,
  settingsProblems,
} from './settings';

const merge = (patch: Partial<ModuleSettings>, current: ModuleSettings = DEFAULT_SETTINGS) =>
  mergeSettings(current, patch);

describe('16.1 : valeurs par défaut', () => {
  it('cas nominal : les défauts du tableau sont valides', () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([]);
    expect(DEFAULT_SETTINGS).toMatchObject({
      maxOpenRequests: 5,
      defaultPlanningMode: 'proposal',
      planningHorizonDays: 14,
      scoreWeights: { continuity: 40, proximity: 25, balance: 20, rating: 15 },
      claimWindowHours: 48,
    });
    expect(DEFAULT_COMMON_CHECKLIST).toHaveLength(4);
  });
});

describe('UpdateSettings : fusion avec les valeurs en vigueur, puis validation en entier', () => {
  it('cas nominal : champs absents inchangés, champ fourni remplacé', () => {
    const result = merge({ planningHorizonDays: 21, defaultPlanningMode: 'automatic' });
    expect(result).toEqual({
      ok: true,
      value: { ...DEFAULT_SETTINGS, planningHorizonDays: 21, defaultPlanningMode: 'automatic' },
    });
  });

  it('cas limite : chaque réglage est borné (bornes incluses, hors bornes refusé)', () => {
    for (const [field, [min, max]] of Object.entries(SETTING_BOUNDS)) {
      const key = field as keyof ModuleSettings;
      // Base qui laisse passer les règles croisées aux bornes de chaque réglage.
      const base: ModuleSettings = {
        ...DEFAULT_SETTINGS,
        unpaidInvoicesSuspension: 12,
        defaultMaxHoursDay: 1,
        defaultMaxHoursWeek: 168,
        quoteReminderDays: 0,
      };
      const fits = (value: number) => {
        const result = mergeSettings(base, {
          [key]: value,
          ...(key === 'quoteReminderDays' ? { quoteValidityDays: 90 } : {}),
        });
        return result.ok ? null : result.problems;
      };
      if (key !== 'unpaidInvoicesSuspension' && key !== 'unpaidInvoicesWarning') {
        expect([field, fits(min)]).toEqual([field, null]);
      }
      if (key !== 'unpaidInvoicesWarning') expect([field, fits(max)]).toEqual([field, null]);
      expect([field, fits(min - 1)]).toEqual([field, [{ field, reason: 'out_of_range' }]]);
      expect([field, fits(max + 1)]).toEqual([field, [{ field, reason: 'out_of_range' }]]);
    }
  });

  it('cas limite : valeur non entière refusée', () => {
    expect(merge({ maxOpenRequests: 2.5 })).toEqual({
      ok: false,
      problems: [{ field: 'maxOpenRequests', reason: 'invalid_type' }],
    });
  });

  it('règle croisée : avertissement < suspension', () => {
    expect(merge({ unpaidInvoicesWarning: 2 })).toEqual({
      ok: false,
      problems: [{ field: 'unpaidInvoicesWarning', reason: 'out_of_range' }],
    });
    expect(merge({ unpaidInvoicesWarning: 2, unpaidInvoicesSuspension: 3 }).ok).toBe(true);
  });

  it('règle croisée : heures par jour ≤ heures par semaine', () => {
    expect(merge({ defaultMaxHoursDay: 10, defaultMaxHoursWeek: 9 })).toEqual({
      ok: false,
      problems: [{ field: 'defaultMaxHoursDay', reason: 'out_of_range' }],
    });
    expect(merge({ defaultMaxHoursDay: 10, defaultMaxHoursWeek: 10 }).ok).toBe(true);
  });

  it('règle croisée : poids du score, total = 100', () => {
    expect(merge({ scoreWeights: { continuity: 50, proximity: 25, balance: 20, rating: 15 } })).toEqual({
      ok: false,
      problems: [{ field: 'scoreWeights', reason: 'out_of_range' }],
    });
    expect(merge({ scoreWeights: { continuity: 100, proximity: 0, balance: 0, rating: 0 } }).ok).toBe(true);
    expect(merge({ scoreWeights: { continuity: 101, proximity: -1, balance: 0, rating: 0 } })).toMatchObject({
      ok: false,
      problems: [
        { field: 'scoreWeights.continuity', reason: 'out_of_range' },
        { field: 'scoreWeights.proximity', reason: 'out_of_range' },
      ],
    });
  });

  it('règle croisée : rappel < validité ; 0 = aucun rappel', () => {
    expect(merge({ quoteReminderDays: 15 })).toEqual({
      ok: false,
      problems: [{ field: 'quoteReminderDays', reason: 'out_of_range' }],
    });
    expect(merge({ quoteReminderDays: 0, quoteValidityDays: 1 }).ok).toBe(true);
    expect(merge({ quoteReminderDays: 14 }).ok).toBe(true);
  });

  it('frais de visite par défaut : entier positif ou nul', () => {
    expect(merge({ defaultVisitFee: 0 }).ok).toBe(true);
    expect(merge({ defaultVisitFee: -1 })).toMatchObject({
      ok: false,
      problems: [{ field: 'defaultVisitFee', reason: 'out_of_range' }],
    });
  });

  it('mode de planification : manuel, proposition ou automatique', () => {
    expect(merge({ defaultPlanningMode: 'manual' }).ok).toBe(true);
    expect(merge({ defaultPlanningMode: 'other' as never })).toMatchObject({
      ok: false,
      problems: [{ field: 'defaultPlanningMode', reason: 'invalid_type' }],
    });
  });

  it('points communs : 0 à 50, codes uniques, libellé obligatoire', () => {
    expect(merge({ commonChecklist: [] }).ok).toBe(true);
    const many = Array.from({ length: 51 }, (_, i) => ({ code: `point_${i}`, label: 'Point', order: i }));
    expect(merge({ commonChecklist: many })).toMatchObject({
      ok: false,
      problems: [{ field: 'commonChecklist', reason: 'out_of_range' }],
    });
    expect(
      merge({
        commonChecklist: [
          { code: 'arrival', label: 'Arrivée', order: 0 },
          { code: 'arrival', label: '', order: 1 },
          { code: 'Bad code', label: 'x', order: -1 },
        ],
      }),
    ).toEqual({
      ok: false,
      problems: [
        { field: 'commonChecklist[1].code', reason: 'duplicate' },
        { field: 'commonChecklist[1].label', reason: 'required' },
        { field: 'commonChecklist[2].code', reason: 'invalid_type' },
        { field: 'commonChecklist[2].order', reason: 'out_of_range' },
      ],
    });
  });
});

describe('journal d’audit : avant et après des réglages modifiés', () => {
  it('cas nominal : seuls les réglages changés', () => {
    const after = { ...DEFAULT_SETTINGS, planningHorizonDays: 21 };
    expect(settingsChanges(DEFAULT_SETTINGS, after)).toEqual({
      before: { planningHorizonDays: 14 },
      after: { planningHorizonDays: 21 },
    });
  });

  it('cas limite : rien de changé ; objets comparés par valeur', () => {
    expect(settingsChanges(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toEqual({ before: {}, after: {} });
    const weights = { ...DEFAULT_SETTINGS.scoreWeights };
    expect(settingsChanges(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, scoreWeights: weights }).after).toEqual(
      {},
    );
  });
});
