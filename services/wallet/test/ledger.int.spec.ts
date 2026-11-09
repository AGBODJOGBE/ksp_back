import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { createUseCases } from '../src/application/use-cases';
import { type PayoutExecutor } from '../src/application/ports';
import { PrismaLedgerStore } from '../src/infrastructure/persistence/prisma-ledger.store';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import { runWithContext } from '@ksp/platform';

/**
 * Intégration contre un vrai PostgreSQL (ADR-042) : migrations du service dans un schéma jetable,
 * soldes tenus par la base, transaction déséquilibrée refusée à la validation, écritures immuables,
 * reversement jamais au-delà du solde sous demandes simultanées, issue d'un reversement appliquée une
 * seule fois (inbox). Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const ORG = { type: 'organization', id: '0192f1c4-0000-7000-8000-00000000a001' };
const BENEFICIARY = { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' };

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
      settings: { ledgerCallers: ['recovery'] },
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
});
