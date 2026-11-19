import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { writeChanges } from '../src/infrastructure/persistence/changes';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : migration v2 dans un schéma jetable, client Prisma,
 * outbox et journal d'audit écrits dans la transaction de l'état, données de démonstration. Ignoré
 * sans TEST_DATABASE_URL (fourni en CI). Le métier v2 ajoute ses dépôts lot par lot (ADR-054).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const DEMO = join(__dirname, '..', 'prisma', 'demo', 'demo-data.sql');
const REQUEST_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e01';

describeWithDatabase('base cleaning v2 (PostgreSQL)', () => {
  const schema = `cleaning_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  const ids = new UuidV7Generator();

  beforeAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const migration of readdirSync(MIGRATIONS)
      .filter((name) => /^\d{4}_/.test(name))
      .sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8'));
    }
    const url = new URL(databaseUrl as string);
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  }, 60_000);

  it('la migration crée la ligne des réglages, avec leurs valeurs par défaut (partie 16.1)', async () => {
    expect(await prisma.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      maxOpenRequests: 5,
      quoteValidityDays: 15,
      programMaxMonths: 24,
      programMaxSessions: 400,
      defaultVisitFee: 0,
      version: 0,
    });
  });

  it('événements et traces écrits dans la transaction de l’état, ou pas du tout', async () => {
    const changes = {
      events: [
        {
          type: 'cleaning.request.cancelled' as const,
          payload: {
            requestId: REQUEST_ID,
            requestNumber: 'DN-000001',
            customerId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11',
            organizationId: null,
            cause: 'customer' as const,
            visitFeeRefund: { amount: 5000, currency: 'XOF' as const },
            cancelledAt: '2026-12-01T09:00:00.000Z',
          },
        },
      ],
      audit: [
        {
          actorId: 'system',
          action: 'request.cancelled',
          entityType: 'request',
          entityId: REQUEST_ID,
          at: new Date('2026-12-01T09:00:00.000Z'),
          details: { before: 'visit_to_schedule', after: 'cancelled' },
        },
      ],
    };
    await expect(
      prisma.$transaction(async (tx) => {
        await writeChanges(tx, changes, () => ids.next());
        throw new Error('annulée');
      }),
    ).rejects.toThrow('annulée');
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.auditEntry.count()).toBe(0);

    await prisma.$transaction((tx) => writeChanges(tx, changes, () => ids.next()));
    const [event] = await prisma.outboxEvent.findMany();
    expect(event).toMatchObject({
      eventType: 'cleaning.request.cancelled',
      publishedAt: null,
      payload: {
        type: 'cleaning.request.cancelled',
        producer: 'cleaning',
        payload: { requestId: REQUEST_ID, cause: 'customer', visitFeeRefund: { amount: 5000 } },
      },
    });
    expect(await prisma.auditEntry.findMany()).toEqual([
      expect.objectContaining({
        actorId: 'system',
        action: 'request.cancelled',
        entityId: REQUEST_ID,
        details: { before: 'visit_to_schedule', after: 'cancelled' },
      }),
    ]);
  });

  it('données de démonstration : refusées sans accord, puis chargées et rejouables, conformes aux contraintes', async () => {
    const demo = readFileSync(DEMO, 'utf8');
    const client = await pool.connect();
    try {
      await expect(client.query(demo)).rejects.toThrow('Données de démonstration refusées');
      await client.query('ROLLBACK');
      expect(await prisma.zone.count()).toBe(0);
      await client.query("SET ksp.demo = 'on'");
      await client.query(demo);
      await client.query(demo);
    } finally {
      client.release();
    }
    expect(
      (await prisma.zone.findMany({ orderBy: { communeKey: 'asc' } })).map((zone) => zone.communeKey),
    ).toEqual(['abomey-calavi', 'cotonou', 'porto-novo']);
    expect((await prisma.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } })).defaultVisitFee).toBe(
      5000,
    );
    const offer = await prisma.offer.findFirstOrThrow({
      include: {
        placeType: { include: { category: true, parameters: { orderBy: { position: 'asc' } } } },
        cleaningType: true,
        tariffVersions: { include: { brackets: { orderBy: { fromValue: 'asc' } }, supplements: true } },
      },
    });
    expect(offer).toMatchObject({
      active: true,
      placeType: { code: 'villa', active: true, category: { code: 'house', active: true } },
      cleaningType: { code: 'floor', requiredSkillCode: 'indoor_cleaning', active: true },
    });
    expect(offer.placeType.parameters.map((parameter) => parameter.parameterId)).toContain(
      offer.placeType.areaParameterId,
    );
    const [tariff] = offer.tariffVersions;
    expect(tariff).toMatchObject({ version: 1, status: 'published', minimumPrice: 10000 });
    expect(tariff!.baseParameterId).toBe(offer.placeType.areaParameterId);
    expect(tariff!.brackets.map((bracket) => [bracket.fromValue, bracket.toValue, bracket.mode])).toEqual([
      [0, 50, 'flat'],
      [51, 150, 'per_unit'],
      [151, 400, 'per_unit'],
    ]);
    expect(tariff!.supplements).toHaveLength(3);
  });
});
