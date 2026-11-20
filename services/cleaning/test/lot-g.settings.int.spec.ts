import { type CleaningDeps } from '../src/application/deps';
import { SettingsUseCases } from '../src/application/settings/settings.use-cases';
import { DEFAULT_SETTINGS } from '../src/domain/settings/settings';
import { PrismaSettingsRepository } from '../src/infrastructure/persistence/settings/prisma-settings.repository';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import { toPatch, toSettings } from '../src/interfaces/grpc/settings-admin.controller';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';
import { asStaffWith } from './support/lot-g-seed';

/**
 * Réglages du module (UC-NT-43) contre un vrai PostgreSQL : lecture, PATCH fusionné puis validé en
 * entier, trace d'audit avant et après, contrainte de la base. Ignoré sans TEST_DATABASE_URL.
 */
const READER = ['cleaning.request.read'];
const ADMIN = ['cleaning.request.read', 'cleaning.settings.manage', 'cleaning.amounts.read'];

describeWithDatabase('réglages du module (PostgreSQL)', () => {
  let db: TestDatabase;
  let useCases: SettingsUseCases;
  const ids = new UuidV7Generator();

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_g_settings');
    useCases = new SettingsUseCases({
      moduleSettings: new PrismaSettingsRepository(db.prisma, ids),
      clock: new SystemClock(),
      people: { userNames: async (list: string[]) => new Map(list.map((id) => [id, 'Admin Nettoyage'])) },
    } as unknown as CleaningDeps);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  it('lecture : valeurs par défaut de la migration ; frais de visite masqués sans cleaning.amounts.read', async () => {
    const view = await asStaffWith(READER, () => useCases.get());
    expect(view.settings).toEqual(DEFAULT_SETTINGS);
    expect(toSettings(view).defaultVisitFee).toBeUndefined();
    await expect(asStaffWith([], () => useCases.get())).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  }, 60_000);

  it('modification : champs absents inchangés, tracée avec avant et après, auteur rendu', async () => {
    const admin = ids.next();
    const view = await asStaffWith(
      ADMIN,
      () =>
        useCases.update(
          toPatch({
            planningHorizonDays: 21,
            defaultPlanningMode: 'automatic',
            scoreWeights: { continuity: 50, proximity: 20, balance: 15, rating: 15 },
            defaultVisitFee: { amount: 2_000, currency: 'XOF' },
          }),
        ),
      admin,
    );
    expect(view.settings).toMatchObject({
      planningHorizonDays: 21,
      defaultPlanningMode: 'automatic',
      maxOpenRequests: 5,
      defaultVisitFee: 2_000,
    });
    expect(toSettings(view)).toMatchObject({
      defaultVisitFee: { amount: 2_000, currency: 'XOF' },
      updatedBy: admin,
      updatedByName: 'Admin Nettoyage',
    });
    const trace = await db.prisma.auditEntry.findFirstOrThrow({ where: { action: 'settings.updated' } });
    expect(trace).toMatchObject({
      actorId: admin,
      details: {
        before: { planningHorizonDays: 14, defaultPlanningMode: 'proposal', defaultVisitFee: 0 },
        after: { planningHorizonDays: 21, defaultPlanningMode: 'automatic', defaultVisitFee: 2_000 },
      },
    });
  }, 60_000);

  it('refus : règle croisée ou borne, avec le nom du champ du contrat ; permission exigée', async () => {
    await expect(
      asStaffWith(ADMIN, () => useCases.update(toPatch({ defaultMaxHoursPerDay: 30 }))),
    ).rejects.toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'defaultMaxHoursPerDay', reason: 'out_of_range' },
    });
    await expect(
      asStaffWith(ADMIN, () => useCases.update(toPatch({ unpaidInvoicesWarning: 2 }))),
    ).rejects.toMatchObject({ details: { field: 'unpaidInvoicesWarning' } });
    await expect(
      asStaffWith(READER, () => useCases.update(toPatch({ planningHorizonDays: 3 }))),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    // Rien n'a changé.
    const view = await asStaffWith(READER, () => useCases.get());
    expect(view.settings.planningHorizonDays).toBe(21);
    expect(await db.prisma.auditEntry.count({ where: { action: 'settings.updated' } })).toBe(1);
  }, 60_000);
});
