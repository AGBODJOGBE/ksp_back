import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry, runWithContext } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type BillingDeps } from '../src/application/ports';
import { type IssueInvoiceInput } from '../src/application/session-invoices.use-cases';
import { CUSTOMER_ID, FakeWallet, FixedClock, InMemoryOrganizations } from '../src/application/testing/fakes';
import { createUseCases } from '../src/application/use-cases';
import { PrismaContractRepository } from '../src/infrastructure/persistence/prisma-contract.repository';
import { PrismaInvoiceRepository } from '../src/infrastructure/persistence/prisma-invoice.repository';
import { PrismaSettingsRepository } from '../src/infrastructure/persistence/prisma-settings.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : factures de séance émises au paiement par cleaning
 * (ADR-055, R-PP-06). Quinze séances d'un même programme, émises en même temps (avec un rejeu
 * simultané) : quinze factures payées, numéros consécutifs sans trou, paiement et événement écrits
 * dans la même transaction ; un rejeu de clé ne crée rien.
 * Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const SESSIONS = 15;
const sessionId = (rank: number) => `0192f1c4-0000-7000-8000-${String(0x5e00 + rank).padStart(12, '0')}`;
const debitId = (rank: number) => `0192f1c4-0000-7000-d000-${String(rank).padStart(12, '0')}`;
const xof = (amount: number) => ({ amount, currency: 'XOF' });

/** Séance `rank`/15 du programme PN-2026-000007, payée 15 000 FCFA par le portefeuille. */
function sessionRequest(rank: number): IssueInvoiceInput {
  const day = `2026-11-${String(rank + 1).padStart(2, '0')}`;
  return {
    idempotencyKey: `cleaning_session_invoice:${sessionId(rank)}`,
    kind: 'session',
    customerId: CUSTOMER_ID,
    organizationId: '',
    sourceObject: { objectType: 'cleaning_session', objectId: sessionId(rank) },
    requestNumber: 'DN-2026-000012',
    programNumber: 'PN-2026-000007',
    sessionRank: `${rank}/${SESSIONS}`,
    placeLabel: 'Maison de Cocotomey',
    serviceDate: day,
    lines: [
      {
        label: `Nettoyage — séance ${rank}/${SESSIONS}`,
        quantity: 1,
        unitPrice: xof(15_000),
        amount: xof(15_000),
        kind: 'session',
        serviceDate: day,
        programNumber: 'PN-2026-000007',
        placeLabel: 'Maison de Cocotomey',
        sourceObjectId: sessionId(rank),
      },
    ],
    payment: {
      method: 'wallet',
      reference: debitId(rank),
      amount: xof(15_000),
      paidAt: `${day}T17:00:00.000Z`,
    },
  };
}

describeWithDatabase('factures de séance émises au paiement (PostgreSQL)', () => {
  const schema = `billing_session_test_${Date.now()}`;
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
      organizations: new InMemoryOrganizations(),
      wallet: new FakeWallet(),
      clock: new FixedClock(new Date('2026-11-20T08:00:00Z')),
      ids: new UuidV7Generator(),
    };
    useCases = createUseCases(deps);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  }, 60_000);

  const issue = (input: IssueInvoiceInput) =>
    runWithContext({ correlationId: 'c-test', callerService: 'cleaning' }, () =>
      useCases.issueInvoice.execute(input),
    );

  it('15 séances d’un programme : 15 factures payées, numéros consécutifs, rejeu sans nouvelle facture', async () => {
    const ranks = Array.from({ length: SESSIONS }, (_, index) => index + 1);
    // Toutes en même temps, plus un rejeu simultané de la première séance.
    const results = await Promise.all([
      ...ranks.map((rank) => issue(sessionRequest(rank))),
      issue(sessionRequest(1)),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(SESSIONS);
    expect(results[SESSIONS]!.invoice.id).toBe(results[0]!.invoice.id);

    const { rows } = await pool.query(
      'SELECT i.number, i.status, i.kind, i.total, i.contract_id, i.period_index, e.session_rank, e.issuer, ' +
        "e.idempotency_key, to_char(e.service_date, 'YYYY-MM-DD') AS service_date " +
        'FROM invoices i JOIN invoice_issuances e ON e.invoice_id = i.id ORDER BY i.number',
    );
    expect(rows.map((row) => row.number)).toEqual(ranks.map((n) => `FAC-2026-${String(n).padStart(6, '0')}`));
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'paid',
        kind: 'session',
        total: 15_000,
        contract_id: null,
        period_index: null,
        issuer: 'cleaning',
      });
    }
    expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(SESSIONS);
    expect(rows.find((row) => row.session_rank === `3/${SESSIONS}`)).toMatchObject({
      service_date: '2026-11-04',
    });
    expect((await pool.query('SELECT last_number FROM invoice_counters WHERE year = 2026')).rows).toEqual([
      { last_number: SESSIONS },
    ]);
    const payments = await pool.query(
      "SELECT count(*)::int AS count FROM invoice_payments WHERE method = 'wallet' AND recorded_by = 'system'",
    );
    expect(payments.rows).toEqual([{ count: SESSIONS }]);
    const events = await pool.query(
      "SELECT payload FROM outbox WHERE event_type = 'billing.invoice.issued' ORDER BY created_at, id",
    );
    expect(events.rows).toHaveLength(SESSIONS);
    expect(events.rows[0].payload.payload).toMatchObject({
      kind: 'session',
      status: 'paid',
      source: 'cleaning',
      total: xof(15_000),
    });

    // Relue telle quelle : champs v2, lignes, paiement.
    const third = results[2]!.invoice;
    expect(await deps.invoices.findById(third.id)).toMatchObject({
      number: third.number,
      kind: 'session',
      issuance: {
        issuer: 'cleaning',
        idempotencyKey: `cleaning_session_invoice:${sessionId(3)}`,
        sourceObject: { objectType: 'cleaning_session', objectId: sessionId(3) },
        programNumber: 'PN-2026-000007',
        sessionRank: `3/${SESSIONS}`,
        serviceDate: '2026-11-04',
      },
      lines: [expect.objectContaining({ kind: 'session', sourceObjectId: sessionId(3) })],
      payments: [expect.objectContaining({ method: 'wallet', reference: debitId(3), amount: 15_000 })],
    });

    // Rejeu d'une clé : même facture, rien de nouveau ; même clé, autre contenu : refusé.
    deps.clock.current = new Date('2026-11-21T08:00:00Z');
    const replayed = await issue(sessionRequest(7));
    expect(replayed).toMatchObject({ created: false, invoice: { id: results[6]!.invoice.id } });
    await expect(issue({ ...sessionRequest(7), placeLabel: 'Bureau' })).rejects.toMatchObject({
      code: 'BILLING_IDEMPOTENCY_KEY_REUSED',
    });
    expect((await pool.query('SELECT count(*)::int AS count FROM invoices')).rows).toEqual([
      { count: SESSIONS },
    ]);
    expect((await pool.query('SELECT count(*)::int AS count FROM invoice_issuances')).rows).toEqual([
      { count: SESSIONS },
    ]);
    expect((await pool.query('SELECT count(*)::int AS count FROM outbox')).rows).toEqual([
      { count: SESSIONS },
    ]);
  });
});
