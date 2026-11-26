import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { createUseCases } from '../src/application/use-cases';
import { type PayoutExecutor } from '../src/application/ports';
import { PrismaLedgerStore } from '../src/infrastructure/persistence/prisma-ledger.store';
import { PrismaCreditRequests } from '../src/infrastructure/persistence/prisma-credit-requests';
import { PrismaWithdrawals } from '../src/infrastructure/persistence/prisma-withdrawals';
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
      withdrawals: new PrismaWithdrawals(prisma),
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
        debitCallers: ['cleaning', 'billing', 'recovery'],
        creditCallers: ['cleaning'],
        topUpMin: 500,
        topUpMax: 1_000_000,
        manualRefundMax: 100_000,
        creditApprovalThreshold: 50_000,
        debitCheckDelayMinutes: 30,
      },
      debitChecks: { debitStatus: async () => 'recorded' },
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
      { code: 'ksp:prepaid_withdrawals_in_transit', balance: '0' },
      { code: 'ksp:recovery_provisions', balance: '0' },
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
      // Version 2 seulement (RV-101).
      expect(credited.version).toBe(2);
      expect(credited.payload).toMatchObject({
        kind: 'top_up',
        topUpChannel: 'mobile_money_online',
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
      const refund = () =>
        asCleaning(() => useCases.refundDebit.execute({ transactionId: original!.id, reason: 'annulée' }));
      const results = await Promise.all([refund(), refund()]);
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

    it('provision du recouvrement : tenue sur ksp:recovery_provisions par la base, remboursée du même compte', async () => {
      const CASE_ID = '0192f1c4-0000-7000-8000-00000000ca01';
      const asRecoveryFor = <T>(fn: () => Promise<T>) =>
        runWithContext(
          {
            correlationId: 'c-int',
            callerService: 'recovery',
            user: { userId: USER.id, sessionId: 's-int', activeContext: 'personal', roles: [], mfa: false },
          },
          fn,
        );
      const accountBalance = async (code: string) =>
        Number(
          (await pool.query('SELECT balance FROM ledger_accounts WHERE code = $1', [code])).rows[0].balance,
        );
      const revenueBefore = await accountBalance('ksp:service_revenue');
      const before = await prepaidBalance();
      const provision = () =>
        asRecoveryFor(() =>
          useCases.debitPrepaid.execute({
            idempotencyKey: `recovery_provision:${CASE_ID}:0001`,
            holder: USER,
            amount: xof(7000),
            object: { objectType: 'recovery_provision', objectId: CASE_ID, part: '' },
            description: 'Provision du dossier RC-000123',
          }),
        );
      const first = await provision();
      // Rejeu de la même clé : le même débit, rien de plus.
      expect(await provision()).toMatchObject({ created: false, transaction: { id: first.transaction.id } });
      const debitId = first.transaction.id;
      const { rows: lines } = await pool.query(
        'SELECT account_code, direction, amount, balance_after FROM ledger_entries WHERE transaction_id = $1 ORDER BY account_code',
        [debitId],
      );
      expect(lines).toEqual([
        {
          account_code: 'ksp:recovery_provisions',
          direction: 'credit',
          amount: '7000',
          balance_after: '7000',
        },
        {
          account_code: `prepaid:user:${USER.id}`,
          direction: 'debit',
          amount: '7000',
          balance_after: String(before - 7000),
        },
      ]);
      expect(await accountBalance('ksp:recovery_provisions')).toBe(7000);
      expect(await accountBalance('ksp:service_revenue')).toBe(revenueBefore);
      const overview = await store.overview();
      const balance = (code: string) => overview.internal.find((a) => a.account === code)!.balance;
      expect(balance('ksp:prepaid_funds')).toBe(
        overview.owedToCustomers + balance('ksp:service_revenue') + balance('ksp:recovery_provisions'),
      );

      const refund = await asRecoveryFor(() =>
        useCases.refundDebit.execute({ transactionId: debitId, reason: 'dossier refusé' }),
      );
      expect(refund).toMatchObject({ created: true, wallet: { balance: before } });
      expect(await accountBalance('ksp:recovery_provisions')).toBe(0);
      expect(await accountBalance('ksp:service_revenue')).toBe(revenueBefore);
      // Débit de frais de dossier de recovery : un service payé, comme avant.
      const fee = await asRecoveryFor(() =>
        useCases.debitPrepaid.execute({
          idempotencyKey: `recovery_case_fee:${CASE_ID}`,
          holder: USER,
          amount: xof(1000),
          object: { objectType: 'recovery_case_fee', objectId: CASE_ID, part: '' },
          description: 'Frais de dossier RC-000123',
        }),
      );
      expect(await accountBalance('ksp:service_revenue')).toBe(revenueBefore + 1000);
      await asRecoveryFor(() =>
        useCases.refundDebit.execute({ transactionId: fee.transaction.id, reason: 'dossier refusé' }),
      );
      expect(await accountBalance('ksp:service_revenue')).toBe(revenueBefore);
      expect(await prepaidBalance()).toBe(before);
    });
  });

  describe('rapprochement des débits (ADR-048)', () => {
    it('débits ni vérifiés ni remboursés, les plus anciens d’abord ; vérifié une fois, plus relu', async () => {
      const later = new Date(Date.now() + 3_600_000);
      const unchecked = await store.listUncheckedDebits(later, 50);
      expect(unchecked.length).toBeGreaterThan(0);
      expect(unchecked.every((t) => t.kind === 'service_payment' && t.entries.length === 2)).toBe(true);
      for (const debit of unchecked) expect(await store.findReversalOf(debit.id)).toBeNull();
      const [first] = unchecked;
      await store.markDebitChecked(first!.id, 'recorded', new Date());
      await store.markDebitChecked(first!.id, 'refunded', new Date());
      const again = await store.listUncheckedDebits(later, 50);
      expect(again.map((t) => t.id)).not.toContain(first!.id);
      const { rows } = await pool.query('SELECT outcome FROM debit_checks WHERE transaction_id = $1', [
        first!.id,
      ]);
      expect(rows).toEqual([{ outcome: 'recorded' }]);
      expect(await store.listUncheckedDebits(new Date(0), 50)).toEqual([]);
    });
  });

  describe('CDC Nettoyage v2 : crédits et retraits (R-WL-02, R-WL-04)', () => {
    const STAFF_A = '0192f1c4-0000-7000-8000-00000000d001';
    const STAFF_B = '0192f1c4-0000-7000-8000-00000000d002';
    const as = <T>(userId: string, roles: string[], fn: () => Promise<T>, callerService?: string) =>
      runWithContext(
        {
          correlationId: 'c-int-v2',
          ...(callerService ? { callerService } : {}),
          user: {
            userId,
            sessionId: 's-int',
            activeContext: 'personal',
            roles: roles.map((role) => ({ role, scopeType: 'global' as const })),
            mfa: roles.includes('finance_officer'),
            authTime: Math.floor(Date.now() / 1000),
          },
        },
        fn,
      );
    const finance = <T>(userId: string, fn: () => Promise<T>) => as(userId, ['finance_officer'], fn);
    const prepaid = () => store.prepaidSummary(USER as never);
    const envelopes = async (type: string) =>
      (await pool.query('SELECT payload FROM outbox WHERE event_type = $1', [type])).rows.map(
        (row) => row.payload as { version: number; payload: Record<string, unknown> },
      );
    const accountBalance = async (code: string) =>
      Number(
        (await pool.query('SELECT balance FROM ledger_accounts WHERE code = $1', [code])).rows[0].balance,
      );

    it('recharge Mobile Money confirmée : portefeuille crédité, événement v2 avec l’objet visé', async () => {
      const paymentId = '0192f1c4-0000-7000-b000-00000000d0f1';
      const before = (await prepaid()).balance;
      const outcome = await useCases.creditTopUp.execute({
        eventId: '0192f1c4-0000-7000-b000-00000000d001',
        eventType: 'payment.intent.succeeded',
        paymentId,
        subjectId: USER.id,
        customerId: USER.id,
        organizationId: null,
        amount: TOP_UP_AMOUNT,
        target: { service: 'cleaning', objectType: 'cleaning_session', objectId: MISSION_ID, part: null },
      });
      expect(outcome).toBe('recorded');
      expect((await prepaid()).balance).toBe(before + TOP_UP_AMOUNT);
      const event = (await envelopes('wallet.prepaid.credited')).find(
        (e) => e.payload.paymentId === paymentId,
      );
      expect(event).toMatchObject({
        version: 2,
        payload: {
          kind: 'top_up',
          topUpChannel: 'mobile_money_online',
          forObject: {
            service: 'cleaning',
            objectType: 'cleaning_session',
            objectId: MISSION_ID,
            part: null,
          },
        },
      });
    });

    it('crédit d’un service, recharge en espèces validée ou rejetée : écritures v2 acceptées par la base', async () => {
      const before = (await prepaid()).balance;
      const gesture = await as(
        USER.id,
        [],
        () =>
          useCases.creditByService.execute({
            idempotencyKey: `cleaning_claim:${MISSION_ID}`,
            holder: USER,
            amount: xof(1500),
            object: { objectType: 'cleaning_claim', objectId: MISSION_ID, part: '' },
            kind: 'commercial_gesture',
            description: 'Nettoyage — geste commercial',
            relatedTransactionId: '',
          }),
        'cleaning',
      );
      expect(gesture).toMatchObject({ created: true, transaction: { kind: 'service_credit' } });

      const cash = (key: string) =>
        finance(STAFF_A, () =>
          useCases.creditPrepaidWallet.execute({
            idempotencyKey: key,
            holder: USER,
            kind: 'cash_top_up',
            amount: xof(2000),
            reason: 'Recharge en espèces au guichet',
            paymentId: '',
            receiptReference: `REC-${key}`,
          }),
        );
      const pending = await cash('cash-int-0001');
      expect(pending.pendingRequest).toMatchObject({
        status: 'pending_approval',
        receiptReference: 'REC-cash-int-0001',
      });
      const approved = await finance(STAFF_B, () =>
        useCases.approveManualCredit.execute(pending.pendingRequest!.id),
      );
      expect(approved).toMatchObject({
        created: true,
        request: { status: 'approved' },
        transaction: { kind: 'top_up' },
      });

      const other = await cash('cash-int-0002');
      const rejected = await finance(STAFF_A, () =>
        useCases.rejectManualCredit.execute({
          requestId: other.pendingRequest!.id,
          reason: 'Saisie en double',
        }),
      );
      expect(rejected.request).toMatchObject({ status: 'rejected', rejectedBy: STAFF_A });
      expect((await prepaid()).balance).toBe(before + 1500 + 2000);
      const cashEvent = (await envelopes('wallet.prepaid.credited')).find(
        (e) => e.payload.transactionId === approved.transaction.id,
      );
      expect(cashEvent?.payload).toMatchObject({ topUpChannel: 'cash', origin: 'finance' });
    });

    it('retrait : retenu, traité, validé par une autre personne, viré puis soldé ; refus rendu', async () => {
      const before = (await prepaid()).balance;
      const request = (key: string, amount: number) =>
        as(USER.id, ['customer'], () =>
          useCases.requestWithdrawal.execute({
            idempotencyKey: key,
            amount: xof(amount),
            beneficiary: { phone: '+2290197000045', operator: 'mtn', name: 'Awa Dossou' },
          }),
        );
      const { withdrawal } = await request('withdraw-int-0001', 5000);
      expect(await prepaid()).toMatchObject({ balance: before - 5000, withdrawalsInProgress: 5000 });
      expect(await accountBalance('ksp:prepaid_withdrawals_in_transit')).toBe(5000);

      await finance(STAFF_A, () =>
        useCases.processWithdrawal.execute({ withdrawalId: withdrawal.id, note: 'Numéro vérifié' }),
      );
      // La base refuse elle-même une validation par la personne qui a traité.
      const sameProcessor = await pool
        .query('UPDATE wallet_withdrawals SET approved_by = processed_by WHERE id = $1', [withdrawal.id])
        .then(
          () => null,
          (caught: Error) => caught.message,
        );
      expect(sameProcessor).toMatch(/wallet_withdrawals_approval_check/);
      const approved = await finance(STAFF_B, () =>
        useCases.approveWithdrawal.execute({ withdrawalId: withdrawal.id }),
      );
      expect(approved.withdrawal).toMatchObject({ status: 'submitted', beneficiaryPhone: null });
      expect(requests.at(-1)).toMatchObject({
        reference: `wallet_withdrawal:${withdrawal.id}`,
        amount: 5000,
      });

      const settle = (eventId: string) =>
        useCases.settlePayout.execute({
          eventId,
          eventType: 'payment.payout.completed',
          outcome: 'completed',
          paymentPayoutId: approved.withdrawal.paymentPayoutId!,
          issuer: 'wallet',
          reference: `wallet_withdrawal:${withdrawal.id}`,
          amount: 5000,
        });
      expect(await settle('0192f1c4-0000-7000-b000-00000000d101')).toBe('recorded');
      expect(await settle('0192f1c4-0000-7000-b000-00000000d101')).toBe('duplicate');
      expect(await prepaid()).toMatchObject({ balance: before - 5000, withdrawalsInProgress: 0 });
      expect(await accountBalance('ksp:prepaid_withdrawals_in_transit')).toBe(0);

      const second = await request('withdraw-int-0002', 1000);
      const refused = await finance(STAFF_A, () =>
        useCases.rejectWithdrawal.execute({
          withdrawalId: second.withdrawal.id,
          reason: 'Numéro au nom d’un tiers',
        }),
      );
      expect(refused).toMatchObject({
        withdrawal: { status: 'rejected' },
        wallet: { balance: before - 5000, withdrawalsInProgress: 0 },
      });
    });
  });

  describe('grand livre verrouillé par la base (ADR-048)', () => {
    const fails = async (sql: string, params: unknown[] = []) => {
      const error = await pool.query(sql, params).then(
        () => null,
        (caught: Error) => caught,
      );
      expect(error).not.toBeNull();
      return error!.message;
    };
    /** Écriture faite à la main dans une transaction : refusée à la validation si incomplète. */
    const commitFails = async (statements: [string, unknown[]][]) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [sql, params] of statements) await client.query(sql, params);
        const error = await client.query('COMMIT').then(
          () => null,
          (caught: Error) => caught,
        );
        expect(error).not.toBeNull();
        return error!.message;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const insertTransaction = (id: string, amount: number) =>
      [
        `INSERT INTO ledger_transactions (id, kind, caller, reference, holder_type, holder_id, amount,
           description, created_at) VALUES ($1, 'top_up', 'wallet', $2, 'user', $3, $4, 'test', now())`,
        [id, `lock:${id}`, USER.id, amount],
      ] as [string, unknown[]];
    const insertEntry = (transactionId: string, account: string, direction: string, amount: number) =>
      [
        `INSERT INTO ledger_entries (id, transaction_id, account_code, direction, amount, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
        [transactionId, account, direction, amount],
      ] as [string, unknown[]];

    it('solde jamais saisi : seule une écriture le change ; compte ni modifié ni supprimé', async () => {
      expect(
        await fails("UPDATE ledger_accounts SET balance = balance + 1 WHERE code = 'ksp:collections'"),
      ).toMatch(/seulement par une écriture/);
      expect(
        await fails("UPDATE ledger_accounts SET normal_side = 'credit' WHERE code = 'ksp:collections'"),
      ).toMatch(/immuable/);
      expect(await fails("DELETE FROM ledger_accounts WHERE code = 'ksp:commission'")).toMatch(/immuable/);
    });

    it('TRUNCATE refusé sur les comptes, les transactions et les lignes', async () => {
      for (const table of ['ledger_entries', 'ledger_transactions', 'ledger_accounts']) {
        expect(await fails(`TRUNCATE ${table} CASCADE`)).toMatch(/TRUNCATE interdit/);
      }
    });

    it('transaction sans lignes, ou montant incohérent avec ses lignes : refusée à la validation', async () => {
      const empty = '0192f1c4-0000-7000-8000-0000000f0001';
      expect(await commitFails([insertTransaction(empty, 100)])).toMatch(/sans lignes/);
      const wrong = '0192f1c4-0000-7000-8000-0000000f0002';
      expect(
        await commitFails([
          insertTransaction(wrong, 100),
          insertEntry(wrong, 'ksp:prepaid_funds', 'debit', 50),
          insertEntry(wrong, 'ksp:service_revenue', 'credit', 50),
        ]),
      ).toMatch(/incohérent/);
      const rows = await pool.query('SELECT 1 FROM ledger_transactions WHERE id IN ($1, $2)', [empty, wrong]);
      expect(rows.rowCount).toBe(0);
    });

    it('nom du bénéficiaire effacé après la transmission, comme son numéro', async () => {
      const { rows } = await pool.query(
        "SELECT id FROM wallet_payouts WHERE status <> 'pending_submission' LIMIT 1",
      );
      expect(rows).toHaveLength(1);
      expect(
        await fails("UPDATE wallet_payouts SET beneficiary_name = 'SARL Bénin Immo' WHERE id = $1", [
          rows[0].id,
        ]),
      ).toMatch(/wallet_payouts_name_check/);
    });
  });
});
