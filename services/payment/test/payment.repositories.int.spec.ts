import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type PaymentIntent } from '../src/domain/payment-intent';
import {
  PrismaPaymentRepository,
  PrismaProviderNotificationLog,
} from '../src/infrastructure/persistence/prisma-payment.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : migrations du service dans un schéma jetable, puis
 * idempotence par (payeur, clé) sous envois simultanés, contrôle de version et événement écrit dans
 * la même transaction que le changement d'état, écarts de montant non traités (ADR-032). Ignoré sans
 * TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
const MISSION = '0192f1c4-0000-7000-8000-00000000b001';

describeWithDatabase('dépôts payment (PostgreSQL)', () => {
  const schema = `payment_test_${Date.now()}`;
  const ids = new UuidV7Generator();
  let pool: Pool;
  let prisma: PrismaService;
  let payments: PrismaPaymentRepository;

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
    payments = new PrismaPaymentRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  const draft = (key: string, overrides: Partial<PaymentIntent> = {}): PaymentIntent => {
    const now = new Date();
    return {
      id: ids.next(),
      subject: { type: 'cleaning_mission', id: MISSION, part: 'deposit', reference: null },
      amount: 15000,
      customerId: CUSTOMER,
      organizationId: null,
      paymentLinkId: null,
      status: 'pending',
      provider: 'fedapay',
      providerTransactionId: null,
      providerReference: null,
      checkoutUrl: null,
      idempotencyKey: key,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      completedAt: null,
      lastCheckedAt: null,
      mismatchResolution: null,
      version: 0,
      ...overrides,
    };
  };

  it('même clé envoyée deux fois en même temps : un seul paiement', async () => {
    const results = await Promise.all([
      payments.create(draft('key-concurrent')),
      payments.create(draft('key-concurrent')),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.intent.id).toBe(results[1]!.intent.id);
  });

  it('changement d’état : version contrôlée, événement dans l’outbox dans la même transaction', async () => {
    const { intent } = await payments.create(draft('key-save'));
    const withCheckout = {
      ...intent,
      providerTransactionId: '104571',
      checkoutUrl: 'https://process.fedapay.com/t',
    };
    expect(await payments.save(withCheckout, [])).toBe(true);
    expect(await payments.save(withCheckout, [])).toBe(false); // version périmée
    const stored = (await payments.findByTransaction('fedapay', '104571'))!;
    const succeeded = { ...stored, status: 'succeeded' as const, completedAt: new Date() };
    expect(
      await payments.save(succeeded, [
        {
          type: 'payment.intent.succeeded',
          payload: {
            paymentId: stored.id,
            subjectType: 'cleaning_mission',
            subjectId: MISSION,
            part: 'deposit',
            subjectReference: null,
            customerId: CUSTOMER,
            organizationId: null,
            amount: { amount: 15000, currency: 'XOF' },
            provider: 'fedapay',
            method: 'mobile_money_online',
            providerReference: null,
            succeededAt: new Date().toISOString(),
          },
        },
      ]),
    ).toBe(true);
    const outbox = await pool.query('SELECT event_type FROM outbox');
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['payment.intent.succeeded']);
    expect((await payments.findById(stored.id))!.status).toBe('succeeded');
  });

  it('paiement en attente réutilisable, listes filtrées, rapprochement', async () => {
    const { intent } = await payments.create(
      draft('key-open', {
        subject: { type: 'cleaning_mission', id: MISSION, part: 'balance', reference: null },
      }),
    );
    const open = await payments.findOpen({
      customerId: CUSTOMER,
      subjectType: 'cleaning_mission',
      subjectId: MISSION,
      part: 'balance',
      now: new Date(),
    });
    expect(open?.id).toBe(intent.id);
    const mine = await payments.list(
      { customerId: CUSTOMER, organizationId: null, status: 'pending' },
      { limit: 10, cursor: null },
    );
    expect(mine.items.map((p) => p.id)).toContain(intent.id);
    const pendingWindow = {
      checkedBefore: new Date(),
      createdBefore: new Date(Date.now() + 60_000),
      limit: 50,
    };
    const window = { checkedBefore: new Date(), lateSince: new Date(Date.now() - 24 * 3_600_000), limit: 50 };
    expect((await payments.listPendingToReconcile(pendingWindow)).map((p) => p.id)).toContain(intent.id);

    // Réussite tardive : un paiement expiré avec transaction reste relu pendant la fenêtre, pas après.
    const late = await payments.create(
      draft('key-late', {
        subject: { type: 'billing_invoice', id: MISSION, part: null, reference: 'FAC-2026-000001' },
      }),
    );
    const expired = {
      ...late.intent,
      status: 'expired' as const,
      failureReason: 'expired' as const,
      providerTransactionId: '777',
      completedAt: new Date(Date.now() - 3_600_000),
    };
    expect(await payments.save(expired, [])).toBe(true);
    expect((await payments.listClosedToReconcile(window)).map((p) => p.id)).toContain(late.intent.id);
    const afterWindow = { ...window, lateSince: new Date() };
    expect((await payments.listClosedToReconcile(afterWindow)).map((p) => p.id)).not.toContain(
      late.intent.id,
    );
  });

  it('une seule page en attente par objet dû et par lien, même sous envois simultanés (ADR-048)', async () => {
    const subjectId = ids.next();
    const subject = (part: 'deposit' | 'balance') => ({
      type: 'cleaning_mission' as const,
      id: subjectId,
      part,
      reference: null,
    });
    const [a, b] = await Promise.all([
      payments.create(draft('key-one-1', { subject: subject('deposit') })),
      payments.create(draft('key-one-2', { subject: subject('balance'), customerId: ids.next() })),
    ]);
    const created = [a, b].filter((r) => r.created);
    const refused = [a, b].find((r) => !r.created);
    expect(created).toHaveLength(1);
    expect(refused).toMatchObject({ conflict: 'open_checkout', intent: { id: created[0]!.intent.id } });
    expect((await payments.findPendingForSubject({ subjectType: 'cleaning_mission', subjectId }))?.id).toBe(
      created[0]!.intent.id,
    );
    // Close, elle libère l'objet.
    const closed = { ...created[0]!.intent, status: 'cancelled' as const, completedAt: new Date() };
    expect(await payments.save(closed, [])).toBe(true);
    expect((await payments.create(draft('key-one-3', { subject: subject('balance') }))).created).toBe(true);

    // Recharges : nouvel argent, plusieurs pages possibles pour un même titulaire.
    const holder = ids.next();
    const topUp = (key: string) =>
      payments.create(
        draft(key, { subject: { type: 'wallet_top_up', id: holder, part: null, reference: null } }),
      );
    expect((await topUp('key-top-1')).created).toBe(true);
    expect((await topUp('key-top-2')).created).toBe(true);

    // Lien de paiement : un seul essai en attente.
    const linkId = ids.next();
    await pool.query(
      `INSERT INTO payment_links (id, token_hash, issuer, idempotency_key, subject_type, subject_id, reference,
         beneficiary_name, description, amount, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'recovery', $3, 'recovery_installment', $4, 'REC-1', 'SARL', 'Échéance', 25000,
         now() + interval '7 days', now(), now())`,
      [linkId, `hash-${linkId}`, `link-${linkId}`, ids.next()],
    );
    const attempt = (key: string) =>
      payments.create(
        draft(key, {
          subject: { type: 'recovery_installment', id: ids.next(), part: null, reference: 'REC-1' },
          customerId: null,
          paymentLinkId: linkId,
        }),
      );
    const [x, y] = await Promise.all([attempt('key-link-1'), attempt('key-link-2')]);
    expect([x, y].filter((r) => r.created)).toHaveLength(1);
    expect([x, y].find((r) => !r.created)).toMatchObject({ conflict: 'open_checkout' });
  });

  it('plus de 50 paiements clos à relire : le paiement en attente est toujours sélectionné, jamais relus d’abord', async () => {
    for (let n = 0; n < 55; n += 1) {
      const { intent: closed } = await payments.create(
        draft(`key-closed-${n}`, {
          subject: { type: 'cleaning_mission', id: ids.next(), part: 'deposit', reference: null },
        }),
      );
      expect(
        await payments.save(
          {
            ...closed,
            status: 'expired',
            failureReason: 'expired',
            providerTransactionId: `closed-${n}`,
            completedAt: new Date(Date.now() - 60_000),
            // Les plus récemment relus en fin de liste ; les autres jamais relus.
            lastCheckedAt: n < 5 ? new Date(Date.now() - 3_600_000 + n * 1000) : null,
          },
          [],
        ),
      ).toBe(true);
    }
    const { intent: waiting } = await payments.create(
      draft('key-waiting', {
        subject: { type: 'cleaning_mission', id: ids.next(), part: 'deposit', reference: null },
        createdAt: new Date(Date.now() - 5 * 60_000),
      }),
    );
    const pending = await payments.listPendingToReconcile({
      checkedBefore: new Date(),
      createdBefore: new Date(),
      limit: 50,
    });
    expect(pending.map((p) => p.id)).toContain(waiting.id);
    const closed = await payments.listClosedToReconcile({
      checkedBefore: new Date(),
      lateSince: new Date(Date.now() - 24 * 3_600_000),
      limit: 50,
    });
    expect(closed).toHaveLength(50);
    expect(closed.every((p) => p.status !== 'pending')).toBe(true);
    // Jamais relus d'abord : les 5 déjà relus n'arrivent qu'en fin de liste (au plus).
    const firstChecked = closed.findIndex((p) => p.lastCheckedAt !== null);
    expect(firstChecked === -1 || closed.slice(firstChecked).every((p) => p.lastCheckedAt !== null)).toBe(
      true,
    );
  });

  it('paiements réussis d’un objet, quels que soient le payeur et la part', async () => {
    const subjectId = ids.next();
    const subject = (part: 'deposit' | 'balance') => ({
      type: 'cleaning_mission' as const,
      id: subjectId,
      part,
      reference: null,
    });
    // Une page en attente à la fois par objet (ADR-048) : chacune réglée avant la suivante.
    const succeed = async (key: string, part: 'deposit' | 'balance', customerId = CUSTOMER) => {
      const created = await payments.create(draft(key, { subject: subject(part), customerId }));
      expect(created.created).toBe(true);
      const intent = { ...created.intent, status: 'succeeded' as const, completedAt: new Date() };
      expect(await payments.save(intent, [])).toBe(true);
      return created;
    };
    const ok = await succeed('key-succ-1', 'deposit');
    const other = await succeed('key-succ-2', 'balance', ids.next());
    await payments.create(draft('key-succ-3', { subject: subject('deposit') }));
    const succeeded = await payments.listSucceeded({ subjectType: 'cleaning_mission', subjectId });
    expect(succeeded.map((payment) => payment.id).sort()).toEqual([ok.intent.id, other.intent.id].sort());
    expect(succeeded.every((payment) => payment.succeededAt instanceof Date)).toBe(true);
    expect(await payments.listSucceeded({ subjectType: 'billing_invoice', subjectId })).toEqual([]);
  });

  it('écarts de montant non traités d’un objet, quels que soient le payeur et la part ; traitement enregistré', async () => {
    const subjectId = ids.next();
    const subject = (part: 'deposit' | 'balance') => ({
      type: 'cleaning_mission' as const,
      id: subjectId,
      part,
      reference: null,
    });
    // Une page en attente à la fois par objet (ADR-048) : chacune close avant la suivante.
    const mismatch = async (key: string, part: 'deposit' | 'balance', customerId = CUSTOMER) => {
      const created = await payments.create(draft(key, { subject: subject(part), customerId }));
      expect(created.created).toBe(true);
      const intent = { ...created.intent, status: 'amount_mismatch' as const, completedAt: new Date() };
      expect(await payments.save(intent, [])).toBe(true);
      return created;
    };
    const first = await mismatch('key-mis-1', 'deposit');
    const other = await mismatch('key-mis-2', 'balance', ids.next());
    await payments.create(draft('key-mis-3', { subject: subject('deposit') }));
    const unresolved = await payments.listUnresolvedMismatches({
      subjectType: 'cleaning_mission',
      subjectId,
    });
    expect(unresolved).toEqual([first.intent.id, other.intent.id].sort());
    expect(await payments.listUnresolvedMismatches({ subjectType: 'billing_invoice', subjectId })).toEqual(
      [],
    );

    const stored = (await payments.findById(first.intent.id))!;
    expect(stored.mismatchResolution).toBeNull();
    const resolution = {
      resolvedAt: new Date('2026-11-05T10:00:00.000Z'),
      resolvedBy: CUSTOMER,
      note: 'Remboursé au client.',
      idempotencyKey: 'res-key-0001',
    };
    expect(await payments.save({ ...stored, mismatchResolution: resolution }, [])).toBe(true);
    expect((await payments.findById(stored.id))!).toMatchObject({
      status: 'amount_mismatch',
      mismatchResolution: resolution,
    });
    expect(await payments.listUnresolvedMismatches({ subjectType: 'cleaning_mission', subjectId })).toEqual([
      other.intent.id,
    ]);

    const page = { limit: 100, cursor: null };
    const underReview = await payments.list({ subjectId, underReview: true }, page);
    expect(underReview.items.map((p) => p.id)).toEqual([other.intent.id]);
    const others = await payments.list({ subjectId, underReview: false }, page);
    expect(others.items).toHaveLength(2);
    expect(others.items.map((p) => p.id)).toContain(stored.id);
    expect((await payments.list({ subjectId, status: 'pending', underReview: true }, page)).items).toEqual(
      [],
    );
  });

  it('traitement d’écart refusé par la base pour un autre statut, ou une note vide ou trop longue', async () => {
    const { intent } = await payments.create(draft('key-mis-check'));
    const resolution = {
      resolvedAt: new Date(),
      resolvedBy: CUSTOMER,
      note: 'Remboursé.',
      idempotencyKey: null,
    };
    await expect(payments.save({ ...intent, mismatchResolution: resolution }, [])).rejects.toThrow();
    const mismatch = { ...intent, status: 'amount_mismatch' as const };
    await expect(
      payments.save({ ...mismatch, mismatchResolution: { ...resolution, note: '' } }, []),
    ).rejects.toThrow();
    await expect(
      payments.save({ ...mismatch, mismatchResolution: { ...resolution, note: 'x'.repeat(501) } }, []),
    ).rejects.toThrow();
  });

  it('montant nul refusé par la base', async () => {
    await expect(payments.create(draft('key-zero', { amount: 0 }))).rejects.toThrow();
  });

  it('journal des notifications', async () => {
    await new PrismaProviderNotificationLog(prisma).record({
      id: ids.next(),
      provider: 'fedapay',
      eventName: 'transaction.approved',
      providerEventId: '77',
      providerTransactionId: '104571',
      paymentId: null,
      outcome: 'unknown_transaction',
      receivedAt: new Date(),
    });
    const rows = await pool.query('SELECT outcome FROM provider_notifications');
    expect(rows.rows).toEqual([{ outcome: 'unknown_transaction' }]);
  });
});
