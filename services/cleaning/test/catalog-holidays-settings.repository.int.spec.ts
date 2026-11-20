import { DuplicateKeyError } from '../src/application/ports';
import {
  PrismaCatalogSettingsReader,
  PrismaIdempotencyStore,
} from '../src/infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaHolidayRepository } from '../src/infrastructure/persistence/catalog/prisma-holiday.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/** Jours fériés, réglages lus par le catalogue et clés d'idempotence sur un vrai PostgreSQL. */
describeWithDatabase('jours fériés, réglages et idempotence (PostgreSQL)', () => {
  let db: TestDatabase;
  let holidays: PrismaHolidayRepository;
  const ids = new UuidV7Generator();
  const at = new Date('2026-11-20T10:00:00.000Z');
  const actor = '0192f1c4-0000-7000-8000-00000000ad01';

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_holidays');
    holidays = new PrismaHolidayRepository(db.prisma, ids);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  it('jour férié : un par date, retiré puis repris sur sa ligne, liste par année', async () => {
    const audit = (action: string, entityId: string) => ({
      events: [],
      audit: [
        { actorId: actor, action, entityType: 'holiday', entityId, at, details: { date: '2026-08-01' } },
      ],
    });
    const id = ids.next();
    const created = await holidays.addHoliday(
      { id, date: '2026-08-01', name: 'Fête nationale' },
      at,
      actor,
      audit('catalog.holiday.created', id),
    );
    expect(created).toEqual({ id, date: '2026-08-01', name: 'Fête nationale' });
    await holidays.addHoliday({ id: ids.next(), date: '2027-01-01', name: 'Jour de l’an' }, at, actor, {
      events: [],
      audit: [],
    });
    await expect(
      holidays.addHoliday({ id: ids.next(), date: '2026-08-01', name: 'Doublon' }, at, actor, {
        events: [],
        audit: [],
      }),
    ).rejects.toEqual(new DuplicateKeyError('code'));
    expect((await holidays.listHolidays(2026)).map((holiday) => holiday.date)).toEqual(['2026-08-01']);
    expect(await holidays.listHolidays()).toHaveLength(2);

    await holidays.removeHoliday(id, at, actor, audit('catalog.holiday.deleted', id));
    expect(await holidays.getHoliday(id)).toBeNull();
    expect(await holidays.listHolidays(2026)).toEqual([]);
    const again = await holidays.addHoliday(
      { id: ids.next(), date: '2026-08-01', name: 'Fête de l’indépendance' },
      at,
      actor,
      {
        events: [],
        audit: [],
      },
    );
    expect(again).toEqual({ id, date: '2026-08-01', name: 'Fête de l’indépendance' });
    expect(await holidays.getHoliday('x')).toBeNull();
    expect(await db.prisma.auditEntry.count({ where: { entityId: id } })).toBe(2);
  });

  it('réglages du catalogue : valeurs par défaut de la migration', async () => {
    await expect(new PrismaCatalogSettingsReader(db.prisma).catalogSettings()).resolves.toEqual({
      defaultVisitFee: 0,
      programMaxMonths: 24,
      programMaxSessions: 400,
    });
  });

  it('clé d’idempotence : relue par compte, opération et clé', async () => {
    const store = new PrismaIdempotencyStore(db.prisma);
    await db.prisma.idempotencyRecord.create({
      data: {
        actorId: actor,
        operation: 'catalog.skill.create',
        idempotencyKey: 'cle-0001',
        requestHash: 'abc',
        response: { id: 'x' },
        createdAt: at,
      },
    });
    await expect(
      store.find({ actorId: actor, operation: 'catalog.skill.create', key: 'cle-0001' }),
    ).resolves.toEqual({
      requestHash: 'abc',
      response: { id: 'x' },
    });
    await expect(
      store.find({ actorId: actor, operation: 'zone.create', key: 'cle-0001' }),
    ).resolves.toBeNull();
  });
});
