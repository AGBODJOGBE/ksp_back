import { DEFAULT_FULL_SETTINGS } from './settings.use-cases';
import { createUseCases } from './use-cases';
import { ADMIN_ID, AGENT_ID, asCreditor, asStaff, makeDeps, NOW, rejection } from './testing/fakes';

describe('réglages et jours fériés (partie 17.1, R1)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
  });

  const asAdmin = <T>(fn: () => Promise<T>, mfaAgeSeconds = 60) =>
    asStaff(ADMIN_ID, ['recovery_admin'], fn, mfaAgeSeconds);

  describe('réglages', () => {
    it('rend les valeurs par défaut tant que rien n’est enregistré', async () => {
      const stored = await asAdmin(() => useCases.getSettings.execute());
      expect(stored.settings).toEqual(DEFAULT_FULL_SETTINGS);
      expect(stored.settings).toMatchObject({
        minimumCaseAmount: 25_000,
        feePaymentDays: 7,
        reviewBusinessDays: 2,
        contactWindow: { start: '08:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
        closedCaseRetentionYears: 5,
      });
      expect(stored.settings.scales.b2b).toMatchObject({ maxDurationMonths: 12, minInstallment: 25_000 });
      expect(stored.settings.scales.b2c).toMatchObject({ maxDurationMonths: 6, minInstallment: 5_000 });
      expect(stored.updatedAt).toBeNull();
    });

    it('enregistre une modification dans les bornes, tracée dans le journal d’audit', async () => {
      const settings = { ...DEFAULT_FULL_SETTINGS, amicableDurationDays: 30, minimumCaseAmount: 50_000 };
      const saved = await asAdmin(() => useCases.updateSettings.execute({ settings }));
      expect(saved).toMatchObject({ updatedAt: NOW, updatedBy: ADMIN_ID });
      const reread = await asAdmin(() => useCases.getSettings.execute());
      expect(reread.settings).toMatchObject({ amicableDurationDays: 30, minimumCaseAmount: 50_000 });
      expect(deps.audit.entries).toEqual([
        expect.objectContaining({
          action: 'settings.updated',
          details: { changed: ['minimumCaseAmount', 'amicableDurationDays'] },
        }),
      ]);
    });

    it('complète des réglages anciens par les valeurs par défaut', async () => {
      deps.settings.row = { values: { feePaymentDays: 10 }, updatedAt: NOW, updatedBy: ADMIN_ID };
      const stored = await asAdmin(() => useCases.getSettings.execute());
      expect(stored.settings).toMatchObject({ feePaymentDays: 10, reviewBusinessDays: 2 });
      expect(stored.settings.scales.rent).toEqual(DEFAULT_FULL_SETTINGS.scales.rent);
    });

    it.each([
      ['un délai hors bornes', { formalNoticeDays: 7 }, 'formalNoticeDays'],
      ['un montant minimum négatif', { minimumCaseAmount: -1 }, 'minimumCaseAmount'],
      [
        'une plage de contact vide',
        { contactWindow: { start: '19:00', end: '08:00', days: [1] } },
        'contactWindow',
      ],
    ])('refuse %s (RECOVERY_SETTING_OUT_OF_BOUNDS)', async (_label, change, field) => {
      const settings = { ...DEFAULT_FULL_SETTINGS, ...change };
      const error = await rejection(asAdmin(() => useCases.updateSettings.execute({ settings })));
      expect(error.code).toBe('RECOVERY_SETTING_OUT_OF_BOUNDS');
      expect(error.details.field).toBe(field);
      expect(deps.settings.row).toBeNull();
    });

    it('refuse un barème ou des poids de score incohérents', async () => {
      const scale = { ...DEFAULT_FULL_SETTINGS.scales.b2c, maxDurationMonths: 0 };
      const badScale = { ...DEFAULT_FULL_SETTINGS, scales: { ...DEFAULT_FULL_SETTINGS.scales, b2c: scale } };
      expect(
        (await rejection(asAdmin(() => useCases.updateSettings.execute({ settings: badScale })))).details
          .field,
      ).toBe('defaultB2cScale');
      const zeroWeights = Object.fromEntries(
        Object.keys(DEFAULT_FULL_SETTINGS.scoreWeights).map((key) => [key, 0]),
      ) as unknown as typeof DEFAULT_FULL_SETTINGS.scoreWeights;
      const badWeights = { ...DEFAULT_FULL_SETTINGS, scoreWeights: zeroWeights };
      expect(
        (await rejection(asAdmin(() => useCases.updateSettings.execute({ settings: badWeights })))).details
          .field,
      ).toBe('scoreWeights');
    });

    it('modification réservée aux administrateurs, double authentification de moins de 10 minutes', async () => {
      const settings = DEFAULT_FULL_SETTINGS;
      expect(
        (
          await rejection(
            asStaff(AGENT_ID, ['recovery_agent'], () => useCases.updateSettings.execute({ settings })),
          )
        ).code,
      ).toBe('AUTH_FORBIDDEN');
      expect((await rejection(asAdmin(() => useCases.updateSettings.execute({ settings }), 900))).code).toBe(
        'AUTH_MFA_REQUIRED',
      );
      expect((await rejection(asCreditor(() => useCases.getSettings.execute()))).code).toBe('AUTH_FORBIDDEN');
    });
  });

  describe('jours fériés', () => {
    const holidays = [
      { date: '2026-08-01', label: 'Fête de l’indépendance' },
      { date: '2026-01-10', label: 'Fête des religions endogènes' },
    ];

    it('remplace la liste d’une année, triée, et la relit pour tout le personnel', async () => {
      const saved = await asAdmin(() => useCases.setHolidays.execute({ year: 2026, holidays }));
      expect(saved.map((h) => h.date)).toEqual(['2026-01-10', '2026-08-01']);
      await asAdmin(() => useCases.setHolidays.execute({ year: 2026, holidays: [holidays[0]!] }));
      const listed = await asStaff(AGENT_ID, ['recovery_agent'], () =>
        useCases.listHolidays.execute({ year: 2026 }),
      );
      expect(listed).toEqual([{ date: '2026-08-01', label: 'Fête de l’indépendance' }]);
      expect(deps.audit.entries.map((e) => e.action)).toEqual(['holidays.set', 'holidays.set']);
    });

    it.each([
      ['une date d’une autre année', [{ date: '2027-01-01', label: 'Nouvel an' }], 'holidays[0].date'],
      ['une date mal formée', [{ date: '2026-13-01', label: 'X' }], 'holidays[0].date'],
      [
        'une date en double',
        [
          { date: '2026-01-01', label: 'Nouvel an' },
          { date: '2026-01-01', label: 'Encore' },
        ],
        'holidays[1].date',
      ],
      ['un libellé vide', [{ date: '2026-01-01', label: ' ' }], 'holidays[0].label'],
    ])('refuse %s', async (_label, list, field) => {
      const error = await rejection(
        asAdmin(() => useCases.setHolidays.execute({ year: 2026, holidays: list })),
      );
      expect(error).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field } });
    });

    it('refuse une année hors bornes', async () => {
      const error = await rejection(asAdmin(() => useCases.listHolidays.execute({ year: 1999 })));
      expect(error).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'year' } });
    });
  });
});
