import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { createUseCases } from '../src/application/use-cases';
import { type PayoutExecutor } from '../src/application/ports';
import { PrismaLedgerStore } from '../src/infrastructure/persistence/prisma-ledger.store';
import { PrismaCreditRequests } from '../src/infrastructure/persistence/prisma-credit-requests';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { HmacPhoneFingerprints } from '../src/infrastructure/security/hmac-phone-fingerprints';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import { runWithContext } from '@ksp/platform';

/**
 * Intégration contre un vrai PostgreSQL (ADR-042) : migrations du service dans un schéma jetable,
 * soldes tenus par la base, transaction déséquilibrée refusée à la validation, écritures immuables,
 * reversement jamais au-delà du solde sous demandes simultanées, issue d'un reversement appliquée une
 * seule fois (inbox). Portefeuille prépayé (ADR-046) : recharge créditée une fois, débits simultanés
 * jamais au-delà du solde ni négatifs (application puis base), remboursement unique, événements
 * écrits dans l'outbox. Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const ORG = { type: 'organization', id: '0192f1c4-0000-7000-8000-00000000a001' };
const BENEFICIARY = { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' };
const USER = { type: 'user', id: '0192f1c4-0000-7000-8000-00000000c001' };
const MISSION_ID = '0192f1c4-0000-7000-8000-00000000e001';
const xof = (amount: number) => ({ amount, currency: 'XOF' });
const TOP_UP_AMOUNT = 20000;

describeWithDatabase('grand livre wallet (PostgreSQL)', () => {
  const schema = `wallet_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let store: PrismaLedgerStore;
  let useCases: ReturnType<typeof createUseCases>;
  const requests: Parameters<PayoutExecutor['request']>[0][] = [];

  const asRecovery = <T>(fn: () => Promise<T>) =>
    runWithContext({ correlationId: 'c-int', callerService: 'recovery' }, fn);

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
    store = new PrismaLedgerStore(prisma);
    useCases = createUseCases({
      ledger: store,
      payouts: store,
      executor: {
        request: async (input) => {
          requests.push(input);
          return { payoutId: `pay-${requests.length}` };
        },
      },
      topUps: {
        create: async () => {
          throw new Error('non utilisé');
        },
        // payment confirme chaque recharge de ces tests (relecture avant crédit, ADR-048).
        get: async (paymentId) => ({
          paymentId,
          status: 'succeeded',
          holderId: USER.id,
          customerId: USER.id,
          organizationId: null,
          amount: TOP_UP_AMOUNT,
          receivedAmount: TOP_UP_AMOUNT,
        }),
      },
      fingerprints: new HmacPhoneFingerprints('test-phone-hash-secret-0123456789abcdef'),
      settings: {
        ledgerCallers: ['recovery'],
        debitCallers: ['cleaning', 'billing'],
        topUpMin: 500,
        topUpMax: 1_000_000,
        manualRefundMax: 100_000,
        creditApprovalThreshold: 50_000,
      },
      creditRequests: new PrismaCreditRequests(prisma),
      clock: new SystemClock(),
      ids: new UuidV7Generator(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  const collect = (reference: string, amount = 25000) =>
    asRecovery(() =>
      useCases.recordCollection.execute({
        holder: ORG,
        grossAmount: { amount, currency: 'XOF' },
        commissionRateBps: 1250,
        reference,
        description: 'Échéance',
      }),
    );

  it('encaissement : soldes tenus par la base, balance_after, rejeu sans double écriture', async () => {
    const results = await Promise.all([collect('payment:1'), collect('payment:1')]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await pool.query('SELECT code, balance FROM ledger_accounts ORDER BY code');
    expect(rows).toEqual([
      { code: `holder:organization:${ORG.id}`, balance: '21875' },
      { code: 'ksp:collections', balance: '25000' },
      { code: 'ksp:commission', balance: '3125' },
      { code: 'ksp:payouts_in_transit', balance: '0' },
      { code: 'ksp:prepaid_funds', balance: '0' },
      { code: 'ksp:service_revenue', balance: '0' },
    ]);
    const statement = await asRecovery(() =>
      useCases.listStatement.execute(ORG, { limit: 10, cursor: null }),
    );
    expect(statement.items[0]).toMatchObject({ direction: 'credit', amount: 21875, balanceAfter: 21875 });
  });

  it('transaction déséquilibrée refusée par la base ; écritures immuables', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO ledger_transactions (id, kind, caller, reference, holder_type, holder_id, amount, description, created_at) ' +
          "VALUES ('0192f1c4-0000-7000-8000-0000000ff001', 'collection', 'test', 'bad', 'organization', $1, 1, 'x', now())",
        [ORG.id],
      );
      await client.query(
        'INSERT INTO ledger_entries (id, transaction_id, account_code, direction, amount, created_at) ' +
          "VALUES ('0192f1c4-0000-7000-8000-0000000ff002', '0192f1c4-0000-7000-8000-0000000ff001', 'ksp:collections', 'debit', 10, now())",
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/déséquilibrée/);
    } finally {
      client.release();
    }
    await expect(pool.query('UPDATE ledger_entries SET amount = 1')).rejects.toThrow(/immuable/);
    await expect(pool.query('DELETE FROM ledger_transactions')).rejects.toThrow(/immuable/);
  });

  it('reversements simultanés : jamais au-delà du solde', async () => {
    const outcomes = await Promise.allSettled(
      ['k-payout-0001', 'k-payout-0002', 'k-payout-0003'].map((key) =>
        asRecovery(() =>
          useCases.requestPayout.execute({
            idempotencyKey: key,
            holder: ORG,
            amount: { amount: 10000, currency: 'XOF' },
            beneficiary: BENEFICIARY,
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    const wallet = await asRecovery(() => useCases.getBalance.execute(ORG));
    expect(wallet).toMatchObject({ balance: 1875, payoutsInProgress: 20000 });
    const { rows } = await pool.query('SELECT beneficiary_phone FROM wallet_payouts');
    expect(rows.every((row) => row.beneficiary_phone === null)).toBe(true);
  });

  it('issue d’un reversement appliquée une seule fois (inbox), invariant du grand livre respecté', async () => {
    const [payout] = (await store.list({ status: 'submitted' }, { limit: 1, cursor: null })).items;
    const event = {
      eventId: '0192f1c4-0000-7000-b000-000000000001',
      eventType: 'payment.payout.completed',
      outcome: 'completed' as const,
      paymentPayoutId: payout!.paymentPayoutId!,
      issuer: 'wallet',
      reference: payout!.id,
      amount: 10000,
    };
    const results = await Promise.all([
      useCases.settlePayout.execute(event),
      useCases.settlePayout.execute(event),
    ]);
    expect(results.sort()).toEqual(['duplicate', 'recorded']);
    const overview = await store.overview();
    const balance = (code: string) => overview.internal.find((a) => a.account === code)!.balance;
    expect(balance('ksp:collections')).toBe(
      overview.owedToHolders + balance('ksp:commission') + balance('ksp:payouts_in_transit'),
    );
    expect(balance('ksp:payouts_in_transit')).toBe(10000);
  });

  describe('portefeuille prépayé (ADR-046)', () => {
    const asCleaning = <T>(fn: () => Promise<T>) =>
      runWithContext(
        {
          correlationId: 'c-int',
          callerService: 'cleaning',
          user: { userId: USER.id, sessionId: 's-int', activeContext: 'personal', roles: [], mfa: false },
        },
        fn,
      );
    const debit = (key: string, amount: number) =>
      asCleaning(() =>
        useCases.debitPrepaid.execute({
          idempotencyKey: key,
          holder: USER,
          amount: xof(amount),
          object: { objectType: 'cleaning_mission', objectId: MISSION_ID, part: 'deposit' },
          description: 'Nettoyage de maison — acompte',
        }),
      );
    const prepaidBalance = async () =>
      (await asCleaning(() => useCases.getPrepaidBalance.execute(USER))).balance;
    const outbox = async (type: string) =>
      (await pool.query('SELECT payload FROM outbox WHERE event_type = $1', [type])).rows.map(
        (row) => row.payload,
      );

    it('recharge créditée une seule fois (inbox et référence du paiement), événement dans l’outbox', async () => {
      const event = {
        eventId: '0192f1c4-0000-7000-b000-00000000c001',
        eventType: 'payment.intent.succeeded',
        paymentId: '0192f1c4-0000-7000-b000-00000000c0f1',
        subjectId: USER.id,
        customerId: USER.id,
        organizationId: null,
        amount: 20000,
      };
      const results = await Promise.all([
        useCases.creditTopUp.execute(event),
        useCases.creditTopUp.execute(event),
        useCases.creditTopUp.execute({ ...event, eventId: '0192f1c4-0000-7000-b000-00000000c002' }),
      ]);
      expect(results.filter((r) => r === 'recorded')).toHaveLength(1);
      expect(await prepaidBalance()).toBe(20000);
      const [credited] = await outbox('wallet.prepaid.credited');
      expect(credited.payload).toMatchObject({
        kind: 'top_up',
        origin: 'payment',
        userId: USER.id,
        balanceAfter: xof(20000),
      });
    });

    it('débits simultanés : jamais au-delà du solde, montant manquant indiqué, jamais négatif', async () => {
      const outcomes = await Promise.allSettled(
        ['k-debit-0001', 'k-debit-0002', 'k-debit-0003'].map((key) => debit(key, 8000)),
      );
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
      const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({
        code: 'WALLET_INSUFFICIENT_FUNDS',
        details: { missing: xof(4000) },
      });
      expect(await prepaidBalance()).toBe(4000);
      expect(await outbox('wallet.prepaid.debited')).toHaveLength(2);
      // La base refuse elle-même un solde négatif, même sans le contrôle de l'application.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO ledger_transactions (id, kind, caller, reference, holder_type, holder_id, amount, description, created_at) ' +
            "VALUES ('0192f1c4-0000-7000-8000-0000000ff101', 'service_payment', 'test', 'neg', 'user', $1, 5000, 'x', now())",
          [USER.id],
        );
        await expect(
          client.query(
            'INSERT INTO ledger_entries (id, transaction_id, account_code, direction, amount, created_at) ' +
              "VALUES ('0192f1c4-0000-7000-8000-0000000ff102', '0192f1c4-0000-7000-8000-0000000ff101', $1, 'debit', 5000, now())",
            [`prepaid:user:${USER.id}`],
          ),
        ).rejects.toThrow(/prepaid_balance_check/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('remboursement d’un débit une seule fois ; rejeu du débit remboursé refusé ; invariant', async () => {
      // Un des débits simultanés acceptés (lequel dépend de l'ordre des verrous).
      const { rows: debits } = await pool.query(
        "SELECT reference FROM ledger_transactions WHERE kind = 'service_payment' AND caller = 'cleaning' ORDER BY id LIMIT 1",
      );
      const reference = debits[0].reference as string;
      const original = await store.findByReference('cleaning', reference);
      const results = await Promise.all([
        useCases.refundFromEvent.execute({
          producer: 'cleaning',
          transactionIds: [original!.id],
          reason: 'mission annulée',
        }),
        asCleaning(() => useCases.refundDebit.execute({ transactionId: original!.id, reason: 'annulée' })),
      ]);
      expect(results).toHaveLength(2);
      expect(await prepaidBalance()).toBe(12000);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'refund'",
      );
      expect(rows[0].n).toBe(1);
      await expect(debit(reference.slice('debit:'.length), 8000)).rejects.toMatchObject({
        code: 'WALLET_DEBIT_REFUNDED',
      });
      const overview = await store.overview();
      const balance = (code: string) => overview.internal.find((a) => a.account === code)!.balance;
      expect(balance('ksp:prepaid_funds')).toBe(overview.owedToCustomers + balance('ksp:service_revenue'));
      expect(overview).toMatchObject({ owedToCustomers: 12000, customersCount: 1 });
    });
  });
});
