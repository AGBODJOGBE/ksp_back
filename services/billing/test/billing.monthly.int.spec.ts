import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CleaningEventPayloads } from '@ksp/contracts';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type MonthlyBillingDeps } from '../src/application/monthly/ports';
import { createMonthlyUseCases } from '../src/application/monthly/use-cases';
import { createUseCases } from '../src/application/use-cases';
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
import { FakeWalletCredits } from '../src/application/testing/monthly-fakes';
import { PrismaContractRepository } from '../src/infrastructure/persistence/prisma-contract.repository';
import { PrismaInvoiceRepository } from '../src/infrastructure/persistence/prisma-invoice.repository';
import { PrismaMonthlyInvoiceRepository } from '../src/infrastructure/persistence/prisma-monthly-invoice.repository';
import { PrismaSettingsRepository } from '../src/infrastructure/persistence/prisma-settings.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PgRunLock } from '../src/infrastructure/scheduling/pg-run-lock';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Lot F contre un vrai PostgreSQL (migrations du service, dont 0008, dans un schéma jetable).
 * Critère du lot : scénario de 3 mois — facture de novembre payée, décembre et janvier impayées
 * (billing publie 1 puis 2 impayées de l'organisation : avertissement puis suspension côté
 * cleaning), paiement → impayées redescendues à 0 (reprise côté cleaning). Plus : émission
 * concurrente sans doublon, verrou consultatif entre deux répliques, relances, avoir, annulation.
 * Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const PROGRAM_ID = '0192f1c4-0000-7000-8000-0000000000c1';
const PLACE_ID = '0192f1c4-0000-7000-8000-0000000000d1';
const at = (iso: string) => new Date(iso);
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

interface OutboxRow {
  event_type: string;
  payload: { version: number; payload: Record<string, unknown> };
}

describeWithDatabase('facture mensuelle des organisations (PostgreSQL, lot F)', () => {
  const schema = `billing_lotf_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let deps: MonthlyBillingDeps & { clock: FixedClock; wallet: FakeWallet };
  let monthly: ReturnType<typeof createMonthlyUseCases>;
  let billing: ReturnType<typeof createUseCases>;
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
      contracts: new PrismaContractRepository(prisma),
      invoices: new PrismaInvoiceRepository(prisma),
      settings: new PrismaSettingsRepository(prisma),
      monthly: new PrismaMonthlyInvoiceRepository(prisma),
      organizations,
      wallet: new FakeWallet(),
      walletCredits: new FakeWalletCredits(),
      clock: new FixedClock(),
      ids,
    };
    monthly = createMonthlyUseCases(deps);
    billing = createUseCases(deps);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  }, 60_000);

  let rank = 0;
  const completed = (completedAt: string, amount = 30_000, deduction = 0) => {
    rank += 1;
    const payload: CleaningEventPayloads['cleaning.session.completed'] = {
      sessionId: ids.next(),
      programId: PROGRAM_ID,
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
      payerKind: 'organization',
      placeId: PLACE_ID,
      programNumber: 'PN-000057',
      rank,
      sessionsCount: 12,
      scheduledStart: completedAt,
      price: xof(amount + deduction),
      visitFeeDeduction: xof(deduction),
      amountDue: xof(amount),
      completedAt,
      completedBy: 'team',
    };
    return monthly.recordBillableSession.execute({
      eventId: ids.next(),
      type: 'cleaning.session.completed',
      payload,
    });
  };

  const events = async (type: string): Promise<OutboxRow[]> =>
    (
      await pool.query(
        'SELECT event_type, payload FROM outbox WHERE event_type = $1 ORDER BY created_at, id',
        [type],
      )
    ).rows as OutboxRow[];

  const monthlyInvoices = async () =>
    (
      await pool.query(
        "SELECT id, number, status, total, settled_by, period_start FROM invoices WHERE kind = 'monthly' ORDER BY period_start",
      )
    ).rows as { id: string; number: string; status: string; total: number; settled_by: string | null }[];

  const payFromWallet = (invoiceId: string, key: string) =>
    as(CUSTOMER_ID, () => billing.payMyInvoiceFromWallet.execute({ invoiceId, idempotencyKey: key }), {
      activeContext: ORGANIZATION_ID,
      orgRole: 'org_admin',
    });

  it('critère du lot F : mois 1 payé, mois 2 et 3 impayés, puis paiement', async () => {
    // Mois 1 : novembre, dont une séance qui porte la déduction des frais de visite (R-FV-05).
    await completed('2026-11-04T09:00:00Z', 25_000, 5_000);
    await completed('2026-11-18T09:00:00Z');
    // Séance réalisée le 30 novembre à 23:30 UTC : 1er décembre au Bénin (RV-92).
    await completed('2026-11-30T23:30:00Z');

    // 1er décembre 00:00 (Bénin) : facture de novembre ; deux passages simultanés, une facture.
    deps.clock.current = at('2026-11-30T23:00:00Z');
    const runs = await Promise.all([
      monthly.issueMonthlyInvoices.execute(),
      monthly.issueMonthlyInvoices.execute(),
    ]);
    expect(runs.reduce((sum, run) => sum + run.issued, 0)).toBe(1);
    let [november] = await monthlyInvoices();
    expect(november).toMatchObject({ number: 'FAC-2026-000001', status: 'pending_payment', total: 55_000 });
    deps.wallet.balances.set(ORGANIZATION_ID, 55_000);
    await payFromWallet(november!.id, 'paiement-novembre');
    [november] = await monthlyInvoices();
    expect(november).toMatchObject({ status: 'paid', settled_by: 'payment' });

    // Mois 2 : décembre (avec la séance du 30 novembre au soir), impayé.
    await completed('2026-12-09T09:00:00Z');
    deps.clock.current = at('2026-12-31T23:00:00Z');
    expect(await monthly.issueMonthlyInvoices.execute()).toEqual({ issued: 1, deferredOrganizationIds: [] });
    // Échéance le 11 janvier (Bénin) ; impayée le 12 à minuit.
    deps.clock.current = at('2027-01-11T22:59:00Z');
    expect(await monthly.markMonthlyInvoicesOverdue.execute()).toEqual({ overdue: 0 });
    deps.clock.current = at('2027-01-11T23:00:00Z');
    expect(await monthly.markMonthlyInvoicesOverdue.execute()).toEqual({ overdue: 1 });

    // Mois 3 : janvier, impayé.
    await completed('2027-01-13T09:00:00Z');
    deps.clock.current = at('2027-01-31T23:00:00Z');
    expect(await monthly.issueMonthlyInvoices.execute()).toEqual({ issued: 1, deferredOrganizationIds: [] });
    deps.clock.current = at('2027-02-11T23:00:00Z');
    expect(await monthly.markMonthlyInvoicesOverdue.execute()).toEqual({ overdue: 1 });

    const [, december, january] = await monthlyInvoices();
    // L'année du numéro est celle de la période facturée : décembre émis en janvier garde 2026.
    expect(december).toMatchObject({ number: 'FAC-2026-000002', status: 'overdue', total: 60_000 });
    expect(january).toMatchObject({ number: 'FAC-2027-000001', status: 'overdue', total: 30_000 });
    expect(await monthly.countOrganizationUnpaidInvoices.execute(ORGANIZATION_ID)).toBe(2);

    // billing.invoice.overdue v2 : 1 puis 2 impayées de l'organisation (avertissement, puis
    // suspension côté cleaning, seuils 1 et 2), sans contrat.
    const overdue = await events('billing.invoice.overdue');
    expect(overdue.map((row) => row.payload.version)).toEqual([2, 2]);
    expect(overdue.map((row) => row.payload.payload.holderOverdueCount)).toEqual([1, 2]);
    expect(overdue.every((row) => !('contractId' in row.payload.payload))).toBe(true);

    // Paiement des deux factures : impayées 1 puis 0 (reprise et réaffectation côté cleaning).
    deps.wallet.balances.set(ORGANIZATION_ID, 90_000);
    deps.clock.current = at('2027-02-15T10:00:00Z');
    await payFromWallet(december!.id, 'paiement-decembre');
    await payFromWallet(january!.id, 'paiement-janvier');
    const paid = await events('billing.invoice.paid');
    expect(
      paid.map((row) => [
        row.payload.version,
        row.payload.payload.settledBy,
        row.payload.payload.holderOverdueCount,
      ]),
    ).toEqual([
      [2, 'payment', 0],
      [2, 'payment', 1],
      [2, 'payment', 0],
    ]);
    expect(await monthly.countOrganizationUnpaidInvoices.execute(ORGANIZATION_ID)).toBe(0);

    // Toutes les séances sont facturées une seule fois.
    const billed = await pool.query(
      'SELECT count(*)::int AS n FROM billable_sessions WHERE invoice_id IS NULL',
    );
    expect(billed.rows[0].n).toBe(0);
    const issued = await events('billing.invoice.issued');
    expect(issued.map((row) => row.payload.payload.kind)).toEqual(['monthly', 'monthly', 'monthly']);
  });

  it('séance déjà reçue ou événement rejoué : une seule ligne facturable', async () => {
    const sessionId = ids.next();
    const eventId = ids.next();
    const payload = {
      sessionId,
      programId: PROGRAM_ID,
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
      payerKind: 'organization' as const,
      placeId: PLACE_ID,
      programNumber: 'PN-000058',
      rank: 1,
      sessionsCount: 1,
      scheduledStart: '2027-02-10T09:00:00Z',
      price: xof(10_000),
      visitFeeDeduction: xof(0),
      amountDue: xof(10_000),
      completedAt: '2027-02-10T09:00:00Z',
      completedBy: 'team' as const,
    };
    const input = { eventId, type: 'cleaning.session.completed' as const, payload };
    expect(await monthly.recordBillableSession.execute(input)).toBe('recorded');
    expect(await monthly.recordBillableSession.execute(input)).toBe('duplicate');
    expect(await monthly.recordBillableSession.execute({ ...input, eventId: ids.next() })).toBe('duplicate');
  });

  it('relances, avoir qui solde, annulation (février)', async () => {
    deps.clock.current = at('2027-02-28T23:00:00Z');
    expect(await monthly.issueMonthlyInvoices.execute()).toEqual({ issued: 1, deferredOrganizationIds: [] });
    const february = (await monthlyInvoices()).at(-1)!;
    expect(february).toMatchObject({ number: 'FAC-2027-000002', total: 10_000 });

    deps.clock.current = at('2027-03-07T23:00:00Z'); // 3 jours avant l'échéance (11 mars)
    expect(await monthly.sendInvoiceReminders.execute()).toEqual({ reminded: 1 });
    expect(await monthly.sendInvoiceReminders.execute()).toEqual({ reminded: 0 });
    const reminded = await events('billing.invoice.reminded');
    expect(reminded.at(-1)?.payload.payload).toMatchObject({ offsetDays: -3, balance: xof(10_000) });

    const line = { label: 'Séance non conforme', quantity: 1, unitPrice: 10_000, amount: 10_000 };
    const request = {
      idempotencyKey: 'cleaning_claim_credit_note:1',
      invoiceId: february.id,
      lines: [line],
      reason: 'Réclamation',
    };
    const [first, second] = await Promise.all([
      monthly.issueCreditNote.execute(request),
      monthly.issueCreditNote.execute(request).catch(() => monthly.issueCreditNote.execute(request)),
    ]);
    expect(first.creditNote.number).toBe(second.creditNote.number);
    expect(first.creditNote.number).toBe('AV-2027-000001');
    expect((await monthlyInvoices()).at(-1)).toMatchObject({ status: 'paid', settled_by: 'credit_note' });
    const credited = await pool.query('SELECT count(*)::int AS n FROM credit_notes');
    expect(credited.rows[0].n).toBe(1);
    expect((await events('billing.invoice.paid')).at(-1)?.payload.payload).toMatchObject({
      settledBy: 'credit_note',
    });

    // Mars : une séance, facture annulée et séance remise à facturer.
    await completed('2027-03-10T09:00:00Z');
    deps.clock.current = at('2027-03-31T23:00:00Z'); // 1er avril 00:00 au Bénin
    await monthly.issueMonthlyInvoices.execute();
    const march = (await monthlyInvoices()).at(-1)!;
    await asStaff(() => monthly.cancelInvoice.execute({ invoiceId: march.id, releaseSessions: true }));
    expect((await monthlyInvoices()).at(-1)).toMatchObject({
      status: 'cancelled',
      settled_by: 'cancellation',
    });
    const released = await pool.query(
      'SELECT count(*)::int AS n FROM billable_sessions WHERE invoice_id IS NULL',
    );
    expect(released.rows[0].n).toBe(1);
  });

  it('verrou consultatif : deux répliques, un seul passage', async () => {
    const lock = new PgRunLock(prisma);
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    const first = lock.tryRun('billing.monthly_billing.test', () => holding, 30_000);
    // Laisse la première réplique prendre le verrou.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await lock.tryRun('billing.monthly_billing.test', async () => 'second', 30_000)).toEqual({
      ran: false,
    });
    release();
    expect(await first).toEqual({ ran: true, result: undefined });
    expect(await lock.tryRun('billing.monthly_billing.test', async () => 'third', 30_000)).toEqual({
      ran: true,
      result: 'third',
    });
  });

  it('contraintes de la migration : facture sans contrat ni nature refusée, une facture mensuelle par mois', async () => {
    await expect(
      pool.query(
        "INSERT INTO invoices (id, number, status, customer_id, source, period_start, period_end, lines, total, issued_at, due_at) VALUES ($1, 'FAC-2099-000001', 'pending_payment', $2, 'cleaning', now(), now(), '[]', 0, now(), now())",
        [ids.next(), CUSTOMER_ID],
      ),
    ).rejects.toThrow(/invoices_contract_or_kind_check/);
    const [existing] = (
      await pool.query("SELECT organization_id, period_start FROM invoices WHERE kind = 'monthly' LIMIT 1")
    ).rows;
    await expect(
      pool.query(
        "INSERT INTO invoices (id, number, status, customer_id, organization_id, source, period_start, period_end, lines, total, issued_at, due_at, kind) VALUES ($1, 'FAC-2099-000002', 'pending_payment', $2, $3, 'cleaning', $4, now(), '[]', 0, now(), now(), 'monthly')",
        [ids.next(), CUSTOMER_ID, existing.organization_id, existing.period_start],
      ),
    ).rejects.toThrow(/invoices_monthly_organization_period_key/);
  });
});
