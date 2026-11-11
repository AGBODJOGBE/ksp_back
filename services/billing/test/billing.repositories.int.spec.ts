import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type BillingDeps } from '../src/application/ports';
import {
  asStaff,
  CUSTOMER_ID,
  FixedClock,
  FakeWallet,
  InMemoryOrganizations,
  ORGANIZATION_ID,
  ORGANIZATION_PROFILE,
} from '../src/application/testing/fakes';
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
    const organizations = new InMemoryOrganizations();
    organizations.profiles.set(ORGANIZATION_ID, ORGANIZATION_PROFILE);
    deps = {
      contracts: new PrismaContractRepository(prisma),
      invoices: new PrismaInvoiceRepository(prisma),
      settings: new PrismaSettingsRepository(prisma),
      organizations,
      wallet: new FakeWallet(),
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
    // Novembre et décembre 2026, émises en janvier 2027 : année de la période (ADR-049).
    expect(numbers).toEqual(['FAC-2026-000001', 'FAC-2026-000002']);
    const headers = await pool.query(
      'SELECT DISTINCT organization_legal_name, organization_address, organization_ifu, organization_rccm FROM invoices',
    );
    expect(headers.rows).toEqual([
      {
        organization_legal_name: 'SARL Bénin Propre',
        organization_address: 'Lot 12, Haie Vive, Cotonou',
        organization_ifu: '3201912345678',
        organization_rccm: 'RB/COT/19 B 1234',
      },
    ]);
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
    // Période facturée (dates au Bénin) : décembre seulement ; la fin de novembre est exclusive.
    const december = await asStaff(() =>
      useCases.listInvoices.execute({
        page: { limit: 20, cursor: null },
        status: '',
        customerId: '',
        organizationId: '',
        contractId: '',
        periodFrom: '2026-12-01',
        periodTo: '2026-12-31',
      }),
    );
    expect(december.items.map((invoice) => invoice.periodIndex)).toEqual([2]);
    // Même clé envoyée deux fois en même temps : un seul paiement, les deux réponses la facture payée.
    const payOnce = () =>
      asStaff(() =>
        useCases.recordInvoicePayment.execute({
          invoiceId: page.items[0]!.id,
          amount: page.items[0]!.total,
          method: 'mobile_money_offline',
          reference: 'MM-77',
          idempotencyKey: 'paiement-cle-0001',
        }),
      );
    const [paid, replayed] = await Promise.all([payOnce(), payOnce()]);
    expect(paid.status).toBe('paid');
    expect(replayed.status).toBe('paid');
    expect((await payOnce()).payments).toHaveLength(1);
    const keyed = await pool.query('SELECT idempotency_key FROM invoice_payments WHERE invoice_id = $1', [
      paid.id,
    ]);
    expect(keyed.rows).toEqual([{ idempotency_key: 'paiement-cle-0001' }]);
    // L'en-tête copié à l'émission ne change pas avec un paiement.
    expect(paid.organization).toEqual({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 12, Haie Vive, Cotonou',
      ifu: '3201912345678',
      rccm: 'RB/COT/19 B 1234',
    });
    const { rows } = await pool.query("SELECT payload FROM outbox WHERE event_type = 'billing.invoice.paid'");
    expect(rows[0].payload.payload).toMatchObject({ invoiceId: paid.id, overdueCount: 1 });
    expect((await deps.invoices.findById(paid.id))!.payments).toHaveLength(1);

    // Paiement en ligne de la seconde facture (ADR-031) : inbox, paiement, état et événement dans
    // la même transaction ; le même événement reçu deux fois n'a qu'un effet.
    const online = {
      eventId: '0192f1c4-0000-7000-8000-0000000000e1',
      eventType: 'payment.intent.succeeded',
      paymentId: '0192f1c4-0000-7000-8000-0000000000e2',
      subjectType: 'billing_invoice',
      invoiceId: page.items[1]!.id,
      amount: page.items[1]!.total,
      providerReference: 'trx_1',
      succeededAt: '2027-01-16T09:00:00.000Z',
    };
    expect((await useCases.recordOnlinePayment.execute(online)).outcome).toBe('recorded');
    expect((await useCases.recordOnlinePayment.execute(online)).outcome).toBe('duplicate');
    const settled = (await deps.invoices.findById(page.items[1]!.id))!;
    expect(settled).toMatchObject({ status: 'paid' });
    expect(settled.payments.map((payment) => payment.method)).toEqual(['mobile_money_online']);
    const paidEvents = await pool.query(
      "SELECT payload FROM outbox WHERE event_type = 'billing.invoice.paid'",
    );
    expect(paidEvents.rows).toHaveLength(2);
  });

  it('annulation arrivée avant la confirmation : pas marquée traitée, appliquée au nouvel essai (ADR-032)', async () => {
    const missionId = '0192f1c4-0000-7000-8000-0000000000c1';
    const cancellation = {
      eventId: '0192f1c4-0000-7000-8000-0000000000c2',
      type: 'cleaning.request.cancelled' as const,
      occurredAt: '2026-11-20T08:00:00Z',
      payload: {
        requestId: '0192f1c4-0000-7000-8000-0000000000c3',
        missionId,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        cancelledBy: 'customer' as const,
        outcome: 'cancelled' as const,
      },
    };
    await expect(useCases.terminateContract.execute(cancellation)).rejects.toMatchObject({
      code: 'BILLING_CONTRACT_NOT_YET_REGISTERED',
    });
    const inbox = await pool.query('SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1', [
      cancellation.eventId,
    ]);
    expect(inbox.rows[0].n).toBe(0);
    await useCases.registerContract.execute({
      eventId: '0192f1c4-0000-7000-8000-0000000000c4',
      type: 'cleaning.booking.confirmed',
      occurredAt: '2026-11-01T08:00:00Z',
      payload: {
        requestId: cancellation.payload.requestId,
        quoteId: '0192f1c4-0000-7000-8000-0000000000c5',
        missionId,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        total: { amount: 100_000, currency: 'XOF' },
        plannedInterventions: 4,
        recurrence: null,
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
        depositAmount: { amount: 100_000, currency: 'XOF' },
        startsAt: '2026-11-05T08:00:00.000Z',
      },
    });
    await useCases.terminateContract.execute(cancellation);
    const contract = await deps.contracts.findById(missionId);
    expect(contract?.terminatedAt).toEqual(new Date('2026-11-20T08:00:00Z'));
    // Prestation ponctuelle (ADR-049) : enregistrée comme telle, facturée en une fois.
    expect(contract?.oneOff).toBe(true);
    expect((await deps.contracts.findById(MISSION_ID))?.oneOff).toBe(false);
  });
});
