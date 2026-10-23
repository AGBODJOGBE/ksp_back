import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type BillingDeps } from '../src/application/ports';
import { asStaff, CUSTOMER_ID, FixedClock, ORGANIZATION_ID } from '../src/application/testing/fakes';
import { createUseCases } from '../src/application/use-cases';
import { PrismaContractRepository } from '../src/infrastructure/persistence/prisma-contract.repository';
import { PrismaInvoiceRepository } from '../src/infrastructure/persistence/prisma-invoice.repository';
import { PrismaSettingsRepository } from '../src/infrastructure/persistence/prisma-settings.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : migrations du service dans un schéma jetable, puis
 * contrat appris par événement (inbox), émission idempotente sous appels simultanés,
 * numérotation sans trou, échéance, paiement et événements écrits dans la même transaction.
 * Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const MISSION_ID = '0192f1c4-0000-7000-8000-0000000000b1';

describeWithDatabase('dépôts billing (PostgreSQL)', () => {
  const schema = `billing_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let deps: BillingDeps & { clock: FixedClock };
  let useCases: ReturnType<typeof createUseCases>;

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
    deps = {
      contracts: new PrismaContractRepository(prisma),
      invoices: new PrismaInvoiceRepository(prisma),
      settings: new PrismaSettingsRepository(prisma),
      clock: new FixedClock(new Date('2026-10-23T08:00:00Z')),
      ids: new UuidV7Generator(),
    };
    useCases = createUseCases(deps);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  const outbox = async () =>
    (await pool.query('SELECT event_type FROM outbox ORDER BY created_at, id')).rows.map(
      (row) => row.event_type as string,
    );

  it('réglages par défaut créés par la migration', async () => {
    expect(await deps.settings.get()).toMatchObject({ paymentTermDays: 10 });
  });

  it('contrat, émission simultanée sans doublon ni trou, impayée, paiement', async () => {
    const booking = {
      eventId: '0192f1c4-0000-7000-8000-0000000000e1',
      type: 'cleaning.booking.confirmed' as const,
      occurredAt: '2026-10-23T08:00:00Z',
      payload: {
        requestId: '0192f1c4-0000-7000-8000-0000000000b2',
        quoteId: '0192f1c4-0000-7000-8000-0000000000b3',
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        total: { amount: 200_000, currency: 'XOF' as const },
        plannedInterventions: 8,
        recurrence: { period: 'week' as const, visitsPerPeriod: 1, durationMonths: 2 },
        paymentPlan: { option: 'full' as const, timing: 'after' as const, method: 'cash' as const },
        depositAmount: { amount: 200_000, currency: 'XOF' as const },
        startsAt: '2026-11-05T08:00:00.000Z',
      },
    };
    const outcomes = await Promise.all([
      useCases.registerContract.execute(booking),
      useCases.registerContract.execute(booking),
    ]);
    expect(outcomes.sort()).toEqual(['duplicate', 'registered']);

    deps.clock.current = new Date('2027-01-06T08:00:00Z');
    const runs = await Promise.allSettled([
      useCases.issueDueInvoices.execute(),
      useCases.issueDueInvoices.execute(),
    ]);
    expect(runs.every((run) => run.status === 'fulfilled')).toBe(true);
    const numbers = (await pool.query('SELECT number FROM invoices ORDER BY number')).rows.map(
      (r) => r.number,
    );
    expect(numbers).toEqual(['FAC-2027-000001', 'FAC-2027-000002']);
    expect(await outbox()).toEqual(['billing.invoice.issued', 'billing.invoice.issued']);

    deps.clock.current = new Date('2027-01-16T08:00:00Z');
    expect(await useCases.markOverdueInvoices.execute()).toEqual({ overdue: 2 });
    const page = await asStaff(() =>
      useCases.listInvoices.execute({
        page: { limit: 20, cursor: null },
        status: 'overdue',
        customerId: '',
        organizationId: ORGANIZATION_ID,
        contractId: MISSION_ID,
      }),
    );
    expect(page.items).toHaveLength(2);
    const paid = await asStaff(() =>
      useCases.recordInvoicePayment.execute({
        invoiceId: page.items[0]!.id,
        amount: page.items[0]!.total,
        method: 'mobile_money_offline',
        reference: 'MM-77',
      }),
    );
    expect(paid.status).toBe('paid');
    const { rows } = await pool.query("SELECT payload FROM outbox WHERE event_type = 'billing.invoice.paid'");
    expect(rows[0].payload.payload).toMatchObject({ invoiceId: paid.id, overdueCount: 1 });
    expect((await deps.invoices.findById(paid.id))!.payments).toHaveLength(1);
  });
});
