import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RecoveryEventPayloads, type WalletEventPayloads } from '@ksp/contracts';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type RecoveryBillingDeps } from '../src/application/recovery/ports';
import { createRecoveryBillingUseCases } from '../src/application/recovery/use-cases';
import {
  as,
  asStaff,
  CUSTOMER_ID,
  FakeWallet,
  FixedClock,
  InMemoryOrganizations,
  ORGANIZATION_ID,
  ORGANIZATION_PROFILE,
} from '../src/application/testing/fakes';
import { PrismaRecoveryBillingRepository } from '../src/infrastructure/persistence/prisma-recovery-billing.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import {
  COMMISSION_BILLING_LOCK,
  CommissionBillingSchedulerService,
} from '../src/infrastructure/scheduling/commission-billing-scheduler.service';
import { PgRunLock } from '../src/infrastructure/scheduling/pg-run-lock';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Facturation du recouvrement (ADR-064) contre un vrai PostgreSQL (migrations du service, dont 0010,
 * dans un schéma jetable) : encaissements et reçus idempotents (inbox, transaction du portefeuille),
 * facture de commission unique par créancier et par mois même avec deux passages simultanés,
 * numérotation sans trou par série et par année, lignes figées, événement sans donnée personnelle,
 * débit automatique et nouvel essai, obligations, tâche sous verrou consultatif.
 * Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const CASE_ID = '0192f1c4-0000-7000-8000-0000000000ca';
const at = (iso: string) => new Date(iso);
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

interface OutboxRow {
  event_type: string;
  payload: { version: number; producer: string; payload: Record<string, unknown> };
}

describeWithDatabase('facturation du recouvrement (PostgreSQL, ADR-064)', () => {
  const schema = `billing_recovery_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let deps: RecoveryBillingDeps & {
    clock: FixedClock;
    wallet: FakeWallet;
    organizations: InMemoryOrganizations;
  };
  let useCases: ReturnType<typeof createRecoveryBillingUseCases>;
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
    const organizations = new InMemoryOrganizations();
    organizations.profiles.set(ORGANIZATION_ID, ORGANIZATION_PROFILE);
    deps = {
      recovery: new PrismaRecoveryBillingRepository(prisma),
      organizations,
      wallet: new FakeWallet(),
      clock: new FixedClock(),
      ids,
    };
    useCases = createRecoveryBillingUseCases(deps);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  }, 60_000);

  const collect = (overrides: Partial<RecoveryEventPayloads['recovery.payment.collected']> = {}) =>
    useCases.recordCollection.execute({
      eventId: ids.next(),
      payload: {
        caseId: CASE_ID,
        caseNumber: 'RC-000123',
        creditor: { type: 'organization', id: ORGANIZATION_ID },
        kind: 'b2b',
        collectionId: ids.next(),
        source: 'payment_link',
        gross: xof(100_000),
        allocatedCosts: xof(0),
        allocatedInterests: xof(0),
        allocatedPrincipal: xof(100_000),
        overpaid: xof(0),
        commission: xof(10_000),
        commissionSettlement: 'deducted',
        stage: 'amicable',
        amountDueAfter: xof(0),
        receivedAt: '2026-11-12T10:00:00Z',
        ...overrides,
      },
    });

  const debited = (overrides: Partial<WalletEventPayloads['wallet.prepaid.debited']> = {}) => ({
    transactionId: ids.next(),
    holder: { type: 'organization' as const, id: ORGANIZATION_ID },
    userId: CUSTOMER_ID,
    amount: xof(25_000),
    balanceAfter: xof(0),
    service: 'recovery',
    objectType: 'recovery_case_fee',
    objectId: CASE_ID,
    part: null,
    description: 'Frais de dossier RC-000123',
    debitedAt: '2026-11-03T09:00:00Z',
    ...overrides,
  });

  const events = async (type: string): Promise<OutboxRow[]> =>
    (
      await pool.query('SELECT event_type, payload FROM outbox WHERE event_type = $1 ORDER BY created_at', [
        type,
      ])
    ).rows as OutboxRow[];

  const commissionInvoices = async () =>
    (
      await pool.query(
        'SELECT id, number, status, creditor_type, total_collected, commission_deducted, commission_invoiced, ' +
          'commission_total, organization_legal_name, debit_attempts, last_debit_failure, debit_missing_amount, ' +
          'next_debit_attempt_at, paid_at, wallet_transaction_id FROM commission_invoices ORDER BY number',
      )
    ).rows as Record<string, unknown>[];

  it('encaissements idempotents ; une facture par créancier et par mois, même avec deux passages simultanés', async () => {
    const payload = {
      caseId: CASE_ID,
      caseNumber: 'RC-000123',
      creditor: { type: 'organization' as const, id: ORGANIZATION_ID },
      kind: 'b2b' as const,
      collectionId: ids.next(),
      source: 'direct_to_creditor' as const,
      gross: xof(60_000),
      allocatedCosts: xof(0),
      allocatedInterests: xof(0),
      allocatedPrincipal: xof(60_000),
      overpaid: xof(0),
      commission: xof(9_000),
      commissionSettlement: 'invoiced' as const,
      stage: 'formal_notice' as const,
      amountDueAfter: xof(40_000),
      receivedAt: '2026-11-04T10:00:00Z',
    };
    const eventId = ids.next();
    expect(await useCases.recordCollection.execute({ eventId, payload })).toBe('recorded');
    expect(await useCases.recordCollection.execute({ eventId, payload })).toBe('duplicate');
    expect(await useCases.recordCollection.execute({ eventId: ids.next(), payload })).toBe('duplicate');
    await collect({ receivedAt: '2026-11-20T10:00:00Z', caseNumber: 'RC-000124' });
    await collect({ creditor: { type: 'user', id: CUSTOMER_ID }, commission: xof(4_000) });
    // 1er décembre 00:30 au Bénin : pour décembre.
    await collect({ receivedAt: '2026-11-30T23:30:00Z' });

    deps.clock.current = at('2026-11-30T23:00:00Z');
    const runs = await Promise.all([
      useCases.issueCommissionInvoices.execute(),
      useCases.issueCommissionInvoices.execute(),
    ]);
    expect(runs.reduce((sum, run) => sum + run.issued, 0)).toBe(2);
    const [userInvoice, organizationInvoice] = await commissionInvoices();
    expect(userInvoice).toMatchObject({
      number: 'FCR-2026-000001',
      status: 'paid',
      creditor_type: 'user',
      commission_deducted: 4_000,
      commission_invoiced: 0,
      organization_legal_name: null,
      next_debit_attempt_at: null,
    });
    expect(organizationInvoice).toMatchObject({
      number: 'FCR-2026-000002',
      status: 'pending_payment',
      creditor_type: 'organization',
      total_collected: 160_000,
      commission_deducted: 10_000,
      commission_invoiced: 9_000,
      commission_total: 19_000,
      organization_legal_name: 'SARL Bénin Propre',
    });
    const lines = (
      await pool.query(
        'SELECT position, case_number, source, settlement FROM commission_invoice_lines WHERE invoice_id = $1 ORDER BY position',
        [organizationInvoice!.id],
      )
    ).rows;
    expect(lines).toEqual([
      { position: 1, case_number: 'RC-000123', source: 'direct_to_creditor', settlement: 'invoiced' },
      { position: 2, case_number: 'RC-000124', source: 'payment_link', settlement: 'deducted' },
    ]);
    // L'encaissement du 1er décembre (heure du Bénin) reste à facturer.
    const unbilled = await pool.query(
      'SELECT count(*)::int AS n FROM commission_collections WHERE invoice_id IS NULL',
    );
    expect(unbilled.rows[0].n).toBe(1);

    const issued = await events('billing.commission_invoice.issued');
    expect(issued).toHaveLength(2);
    expect(issued[1]!.payload).toMatchObject({ producer: 'billing', version: 1 });
    expect(issued[1]!.payload.payload).toEqual({
      invoiceId: organizationInvoice!.id,
      invoiceNumber: 'FCR-2026-000002',
      creditor: { type: 'organization', id: ORGANIZATION_ID },
      period: '2026-11',
      totalCollected: xof(160_000),
      commissionDeducted: xof(10_000),
      commissionInvoiced: xof(9_000),
      commissionTotal: xof(19_000),
      issuedAt: '2026-11-30T23:00:00.000Z',
    });
    const counters = await pool.query("SELECT year, last_number FROM series_counters WHERE series = 'FCR'");
    expect(counters.rows).toEqual([{ year: 2026, last_number: 2 }]);
  });

  it('débit automatique : solde insuffisant noté, nouvel essai le lendemain, puis réglée', async () => {
    deps.clock.current = at('2026-11-30T23:00:00Z');
    deps.wallet.balances.set(ORGANIZATION_ID, 4_000);
    const first = await useCases.debitCommissionInvoices.execute();
    expect(first).toEqual({
      paid: 0,
      failures: [expect.objectContaining({ invoiceNumber: 'FCR-2026-000002', reason: 'insufficient_funds' })],
    });
    let [, organizationInvoice] = await commissionInvoices();
    expect(organizationInvoice).toMatchObject({
      status: 'pending_payment',
      debit_attempts: 1,
      last_debit_failure: 'insufficient_funds',
      debit_missing_amount: 5_000,
      next_debit_attempt_at: at('2026-12-01T23:00:00Z'),
    });
    // Facture due : elle bloque la suppression si identity désigne l'organisation.
    const obligations = await as(
      CUSTOMER_ID,
      () => useCases.hasPendingObligations.execute({ userId: CUSTOMER_ID, organizationId: ORGANIZATION_ID }),
      { callerService: 'identity' },
    );
    expect(obligations.map((obligation) => obligation.reference)).toEqual(['FCR-2026-000002']);

    deps.wallet.balances.set(ORGANIZATION_ID, 20_000);
    deps.clock.current = at('2026-12-01T10:00:00Z');
    expect((await useCases.debitCommissionInvoices.execute()).paid).toBe(0);
    deps.clock.current = at('2026-12-01T23:00:00Z');
    expect((await useCases.debitCommissionInvoices.execute()).paid).toBe(1);
    [, organizationInvoice] = await commissionInvoices();
    expect(organizationInvoice).toMatchObject({
      status: 'paid',
      debit_attempts: 2,
      last_debit_failure: null,
      debit_missing_amount: null,
      next_debit_attempt_at: null,
      paid_at: at('2026-12-01T23:00:00Z'),
    });
    expect(organizationInvoice!.wallet_transaction_id).toBe(
      deps.wallet.debits.get(`billing_commission_invoice:${organizationInvoice!.id}`)!.transactionId,
    );
    expect(
      await as(
        CUSTOMER_ID,
        () =>
          useCases.hasPendingObligations.execute({ userId: CUSTOMER_ID, organizationId: ORGANIZATION_ID }),
        { callerService: 'identity' },
      ),
    ).toEqual([]);
  });

  it('lecture : périmètre du client, filtres, pages, back-office', async () => {
    const page = { limit: 1, cursor: null };
    const first = await as(
      CUSTOMER_ID,
      () => useCases.listMyCommissionInvoices.execute({ page, status: '', period: '2026-11' }),
      { activeContext: ORGANIZATION_ID },
    );
    expect(first.items.map((invoice) => invoice.number)).toEqual(['FCR-2026-000002']);
    expect(first.items[0]!.lines).toHaveLength(2);
    expect(first.nextCursor).toBeNull();
    const all = await asStaff(
      () => useCases.listCommissionInvoices.execute({ page, status: '', period: '', creditorId: '' }),
      'recovery_admin',
    );
    expect(all.items).toHaveLength(1);
    const next = await asStaff(() =>
      useCases.listCommissionInvoices.execute({
        page: { limit: 1, cursor: all.nextCursor },
        status: '',
        period: '',
        creditorId: '',
      }),
    );
    expect([...all.items, ...next.items].map((invoice) => invoice.number).sort()).toEqual([
      'FCR-2026-000001',
      'FCR-2026-000002',
    ]);
    const detail = await asStaff(() => useCases.getCommissionInvoice.execute(first.items[0]!.id));
    expect(detail.organization).toMatchObject({ legalName: 'SARL Bénin Propre', rccm: 'RB/COT/19 B 1234' });
  });

  it('reçus : un par transaction, même reçue deux fois en même temps, numéros sans trou', async () => {
    const payload = debited();
    const outcomes = await Promise.all([
      useCases.recordFeeReceipt.execute({ eventId: ids.next(), payload }),
      useCases.recordFeeReceipt.execute({ eventId: ids.next(), payload }),
    ]);
    expect(outcomes.sort()).toEqual(['duplicate', 'recorded']);
    expect(
      await useCases.recordFeeReceipt.execute({
        eventId: ids.next(),
        payload: debited({
          objectType: 'recovery_study_fee',
          description: "Forfait d'étude du dossier RC-000123",
        }),
      }),
    ).toBe('recorded');
    expect(
      await useCases.recordFeeReceipt.execute({
        eventId: ids.next(),
        payload: debited({ service: 'cleaning', objectType: 'cleaning_session' }),
      }),
    ).toBe('ignored');
    const rows = (
      await pool.query('SELECT number, kind, case_number, amount FROM fee_receipts ORDER BY number')
    ).rows;
    expect(rows).toEqual([
      { number: 'RFD-2026-000001', kind: 'case_fee', case_number: 'RC-000123', amount: 25_000 },
      { number: 'RFD-2026-000002', kind: 'study_fee', case_number: 'RC-000123', amount: 25_000 },
    ]);
    const mine = await as(
      CUSTOMER_ID,
      () => useCases.listMyFeeReceipts.execute({ page: { limit: 20, cursor: null }, caseId: CASE_ID }),
      { activeContext: ORGANIZATION_ID },
    );
    expect(mine.items.map((receipt) => receipt.number)).toEqual(['RFD-2026-000002', 'RFD-2026-000001']);
    const personal = await as(CUSTOMER_ID, () =>
      useCases.listMyFeeReceipts.execute({ page: { limit: 20, cursor: null }, caseId: '' }),
    );
    expect(personal.items).toEqual([]);
  });

  it('tâche planifiée sous verrou : une réplique à la fois ; l’encaissement tardif part sur la facture suivante', async () => {
    const scheduler = new CommissionBillingSchedulerService(useCases, new PgRunLock(prisma), 0);
    deps.clock.current = at('2026-12-31T23:00:00Z');
    // Une autre réplique tient le verrou : passage sauté, rien n'est émis.
    let release: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (release = resolve));
    const other = new PgRunLock(prisma).tryRun(COMMISSION_BILLING_LOCK, () => holding, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await scheduler.tick()).toBe('skipped');
    expect(await commissionInvoices()).toHaveLength(2);
    release();
    await other;
    expect(await scheduler.tick()).toBe('ran');
    const december = (await commissionInvoices()).find((invoice) => invoice.number === 'FCR-2026-000003');
    expect(december).toMatchObject({ status: 'paid', total_collected: 100_000, commission_invoiced: 0 });
    // La base refuse une série inconnue.
    await expect(
      pool.query("INSERT INTO series_counters (series, year, last_number) VALUES ('FAC', 2026, 1)"),
    ).rejects.toThrow(/series_counters_values_check/);
  });
});
