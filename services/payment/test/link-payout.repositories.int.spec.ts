import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type PaymentLink } from '../src/domain/payment-link';
import { type PaymentIntent } from '../src/domain/payment-intent';
import { type Payout } from '../src/domain/payout';
import { HmacLinkTokens } from '../src/infrastructure/links/hmac-link-tokens';
import {
  PrismaPaymentLinkRepository,
  PrismaPayoutRepository,
} from '../src/infrastructure/persistence/prisma-link-payout.repositories';
import { PrismaPaymentRepository } from '../src/infrastructure/persistence/prisma-payment.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL (ADR-040, ADR-041) : migrations du service dans un schéma
 * jetable, lien retrouvé par l'empreinte de son jeton, idempotence par (émetteur, clé) sous envois
 * simultanés, essai de paiement sans payeur rattaché au lien (contrainte « payeur ou lien »),
 * reversement et son événement écrits dans la même transaction. Ignoré sans TEST_DATABASE_URL.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const INSTALLMENT = '0192f1c4-0000-7000-8000-0000000e0001';

describeWithDatabase('dépôts des liens et reversements (PostgreSQL)', () => {
  const schema = `payment_links_test_${Date.now()}`;
  const ids = new UuidV7Generator();
  const tokens = new HmacLinkTokens('integration-test-secret-0123456789abcdef');
  let pool: Pool;
  let prisma: PrismaService;
  let links: PrismaPaymentLinkRepository;
  let payouts: PrismaPayoutRepository;
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
    links = new PrismaPaymentLinkRepository(prisma);
    payouts = new PrismaPayoutRepository(prisma);
    payments = new PrismaPaymentRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  const linkDraft = (key: string, subjectId = INSTALLMENT): PaymentLink => {
    const now = new Date();
    return {
      id: ids.next(),
      issuer: 'recovery',
      idempotencyKey: key,
      subjectType: 'recovery_installment',
      subjectId,
      reference: 'REC-2026-000123 E2',
      beneficiaryName: 'SARL Bénin Immo',
      description: 'Échéance 2 sur 6',
      amount: 25000,
      dueDate: '2026-11-30',
      payerName: null,
      payerPhone: '+2290197000045',
      expiresAt: new Date(now.getTime() + 86_400_000),
      revokedAt: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
  };

  it('lien retrouvé par l’empreinte de son jeton ; création idempotente sous envois simultanés', async () => {
    const drafts = [linkDraft('link-key-0001'), linkDraft('link-key-0001')];
    const results = await Promise.all(
      drafts.map((draft) => links.create(draft, tokens.hash(tokens.issue(draft.id)))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const kept = results.find((r) => r.created)!.link;
    expect(results.every((r) => r.link.id === kept.id)).toBe(true);
    expect((await links.findByTokenHash(tokens.hash(tokens.issue(kept.id))))?.id).toBe(kept.id);
    expect(await links.findByTokenHash(tokens.hash('x'.repeat(43)))).toBeNull();
    const { rows } = await pool.query('SELECT * FROM payment_links');
    expect(JSON.stringify(rows)).not.toContain(tokens.issue(kept.id));
    // Révocation sous contrôle de version.
    const revoked = { ...kept, revokedAt: new Date(), revokedReason: 'soldé', updatedAt: new Date() };
    expect(await links.save(revoked)).toBe(true);
    expect(await links.save(revoked)).toBe(false);
  });

  it('types d’objet du paiement par compte refusés par la base', async () => {
    const draft = { ...linkDraft('link-key-0002'), subjectType: 'billing_invoice' };
    await expect(links.create(draft, 'h'.repeat(64))).rejects.toThrow();
  });

  it('essai de paiement d’un lien : sans payeur, idempotent par (lien, clé) ; payeur ou lien obligatoire', async () => {
    const { link } = await links.create(
      linkDraft('link-key-0003', '0192f1c4-0000-7000-8000-0000000e0003'),
      'a'.repeat(64),
    );
    const now = new Date();
    const attempt = (key: string, overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
      id: ids.next(),
      subject: { type: link.subjectType, id: link.subjectId, part: null, reference: link.reference },
      amount: link.amount,
      customerId: null,
      organizationId: null,
      paymentLinkId: link.id,
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
      receivedAmount: null,
      version: 0,
      ...overrides,
    });
    const results = await Promise.all([
      payments.create(attempt('pay-key-0001')),
      payments.create(attempt('pay-key-0001')),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await payments.findByLinkKey(link.id, 'pay-key-0001'))?.customerId).toBeNull();
    expect(await payments.listForLink(link.id)).toHaveLength(1);
    await expect(payments.create(attempt('pay-key-0002', { paymentLinkId: null }))).rejects.toThrow();
  });

  it('reversement : idempotent, issue et événement dans la même transaction, version contrôlée', async () => {
    const now = new Date();
    const draft = (): Payout => ({
      id: ids.next(),
      issuer: 'wallet',
      idempotencyKey: 'wallet-payout-0001',
      reference: ids.next(),
      amount: 22500,
      beneficiary: { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' },
      status: 'requested',
      provider: 'manual',
      providerPayoutId: null,
      providerReference: null,
      failureCode: null,
      failureReason: null,
      settledBy: null,
      settlementKey: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      completedAt: null,
      failedAt: null,
      lastCheckedAt: null,
      version: 0,
    });
    const results = await Promise.all([payouts.create(draft()), payouts.create(draft())]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const payout = results[0]!.payout;
    const completed: Payout = { ...payout, status: 'completed', providerReference: 'REF', completedAt: now };
    const event = {
      type: 'payment.payout.completed' as const,
      payload: {
        payoutId: payout.id,
        issuer: 'wallet',
        reference: payout.reference,
        amount: { amount: 22500, currency: 'XOF' as const },
        provider: 'manual' as const,
        providerReference: 'REF',
        completedAt: now.toISOString(),
      },
    };
    expect(await payouts.save(completed, [event])).toBe(true);
    expect(await payouts.save(completed, [event])).toBe(false);
    const { rows } = await pool.query(
      "SELECT event_type FROM outbox WHERE event_type LIKE 'payment.payout.%'",
    );
    expect(rows).toEqual([{ event_type: 'payment.payout.completed' }]);
    // Une issue « terminé » sans date est refusée par la base.
    await expect(
      payouts.save({ ...completed, version: completed.version + 1, completedAt: null }, []),
    ).rejects.toThrow();
  });
});
