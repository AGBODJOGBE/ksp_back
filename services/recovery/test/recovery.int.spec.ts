import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type StoredPricingRule } from '../src/application/ports';
import { DEFAULT_FULL_SETTINGS } from '../src/application/settings.use-cases';
import { PrismaPricingRuleStore } from '../src/infrastructure/persistence/prisma-pricing-rules.store';
import {
  PrismaCaseObligations,
  PrismaHolidayStore,
  PrismaSettingsStore,
} from '../src/infrastructure/persistence/prisma-settings.stores';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';

/**
 * Intégration contre un vrai PostgreSQL (ADR-060, ADR-063) : migrations du service dans un schéma
 * jetable, journal de preuve en ajout seul (sauf purge déclarée), un seul lien de paiement actif par
 * dossier, coordonnées du débiteur chiffrées en base et retrouvées par leur empreinte, réglages,
 * jours fériés, règles tarifaires et obligations. Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const CREDITOR = '0192f1c4-0000-7000-8000-00000000c001';
const ADMIN = '0192f1c4-0000-7000-8000-00000000ad01';
const CASE_ID = '0192f1c4-0000-7000-8000-0000000ca5e1';
const DEBTOR_ID = '0192f1c4-0000-7000-8000-0000000deb01';

describeWithDatabase('base du recouvrement (PostgreSQL)', () => {
  const schema = `recovery_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;

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
    await prisma.recoveryCase.create({
      data: {
        id: CASE_ID,
        number: 'RC-000001',
        kind: 'b2b',
        status: 'active',
        stage: 'notice',
        creditorType: 'user',
        creditorId: CREDITOR,
        createdByUserId: CREDITOR,
        nature: 'unpaid_invoice',
        principal: 500_000,
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  it('journal de preuve : ajout seul ; suppression permise seulement pendant une purge déclarée', async () => {
    await prisma.evidenceEntry.create({
      data: {
        id: '0192f1c4-0000-7000-8000-0000000e0001',
        caseId: CASE_ID,
        occurredAt: new Date(),
        actorType: 'system',
        action: 'case.notified',
        summary: 'Notification du mandat envoyée',
      },
    });
    await expect(pool.query(`UPDATE evidence_entries SET summary = 'modifié'`)).rejects.toThrow(/ajout seul/);
    await expect(pool.query(`DELETE FROM evidence_entries`)).rejects.toThrow(/ajout seul/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL recovery.evidence_purge = 'on'`);
      const deleted = await client.query(`DELETE FROM evidence_entries`);
      expect(deleted.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('un seul lien de paiement actif par dossier', async () => {
    const request = (id: string) => ({
      id,
      caseId: CASE_ID,
      amount: 50_000,
      status: 'active',
      requestedBy: 'debtor',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await prisma.paymentRequest.create({ data: request('0192f1c4-0000-7000-8000-0000000a0001') });
    await expect(
      prisma.paymentRequest.create({ data: request('0192f1c4-0000-7000-8000-0000000a0002') }),
    ).rejects.toThrow();
    await prisma.paymentRequest.update({
      where: { id: '0192f1c4-0000-7000-8000-0000000a0001' },
      data: { status: 'revoked' },
    });
    await prisma.paymentRequest.create({ data: request('0192f1c4-0000-7000-8000-0000000a0003') });
  });

  it('coordonnées du débiteur chiffrées en base, retrouvées par l’empreinte du téléphone', async () => {
    const personal = new KitPersonalData(
      FieldCipher.fromConfig(undefined, 'test', 'RECOVERY_PII_ENCRYPTION_KEYS'),
      BlindIndex.fromConfig(undefined, 'test', 'RECOVERY_BLIND_INDEX_KEYS'),
    );
    await prisma.debtor.create({
      data: {
        id: DEBTOR_ID,
        caseId: CASE_ID,
        kind: 'person',
        identityEnc: personal.encrypt(JSON.stringify({ lastName: 'Dossou' }), 'debtors.identity'),
        contacts: {
          create: {
            id: '0192f1c4-0000-7000-8000-0000000dc001',
            channel: 'phone',
            valueEnc: personal.encrypt('+2290197000101', 'debtor_contacts.value'),
            valueIndex: personal.phoneIndex('+2290197000101'),
          },
        },
      },
    });
    const raw = await pool.query(
      `SELECT identity_enc, value_enc FROM debtors JOIN debtor_contacts ON debtor_id = debtors.id`,
    );
    expect(JSON.stringify(raw.rows)).not.toContain('Dossou');
    expect(JSON.stringify(raw.rows)).not.toContain('97000101');
    // L'ancienne forme à 8 chiffres donne la même empreinte (ADR-063).
    const found = await prisma.debtorContact.findFirst({
      where: { valueIndex: personal.phoneIndex('+22997000101') },
    });
    expect(found).not.toBeNull();
    expect(personal.decrypt(found!.valueEnc, 'debtor_contacts.value')).toBe('+2290197000101');
  });

  it('réglages, jours fériés, règles tarifaires et obligations', async () => {
    const settings = new PrismaSettingsStore(prisma);
    expect(await settings.load()).toBeNull();
    await settings.save({ ...DEFAULT_FULL_SETTINGS, feePaymentDays: 9 }, ADMIN, new Date());
    expect(((await settings.load())!.values as { feePaymentDays: number }).feePaymentDays).toBe(9);

    const holidays = new PrismaHolidayStore(prisma);
    await holidays.replaceYear(2026, [{ date: '2026-08-01', label: 'Fête de l’indépendance' }]);
    await holidays.replaceYear(2026, [{ date: '2026-01-10', label: 'Fête des religions endogènes' }]);
    expect(await holidays.listYear(2026)).toEqual([
      { date: '2026-01-10', label: 'Fête des religions endogènes' },
    ]);

    const rules = new PrismaPricingRuleStore(prisma);
    const stored: StoredPricingRule = {
      rule: {
        id: '0192f1c4-0000-7000-8000-0000000ae001',
        object: 'recovery_commission',
        mode: { kind: 'by_stage', stageRates: { amicable: 1_000, formal_notice: 1_500, litigation: 2_000 } },
        bounds: { minimum: 5_000, maximum: null },
        target: { offer: 'any', communeKey: null, creditorId: null },
        validFrom: new Date('2026-11-20T00:00:00Z'),
        validUntil: null,
        status: 'draft',
        version: 0,
        createdBy: ADMIN,
        approvedBy: null,
        previousVersionId: null,
      },
      label: 'Commission par étape',
      creditorType: null,
      publishedAt: null,
      archivedAt: null,
      archiveReason: null,
      createdAt: new Date(),
    };
    await rules.insert(stored, 'rule-key-0001');
    expect((await rules.findByIdempotencyKey(ADMIN, 'rule-key-0001'))!.rule.mode).toEqual(stored.rule.mode);
    await rules.publish(
      { ...stored, rule: { ...stored.rule, status: 'published', version: 1 } },
      [],
      new Date(),
    );
    expect((await rules.listByObject('recovery_commission')).map((r) => r.rule.status)).toEqual([
      'published',
    ]);

    const obligations = new PrismaCaseObligations(prisma);
    expect(await obligations.openCases({ type: 'user', id: CREDITOR })).toEqual([{ number: 'RC-000001' }]);
  });
});
