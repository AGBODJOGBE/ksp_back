import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { DebtorLinks } from '../src/application/debtor-access/debtor-links.service';
import { CapturingNotifier } from '../src/application/testing/debtor-access.fakes';
import { asService, makeDeps, NOW, rejection } from '../src/application/testing/fakes';
import { createUseCases } from '../src/application/use-cases';
import { contactContext } from '../src/infrastructure/persistence/prisma-case-rows';
import { PrismaDebtorAccessJournal } from '../src/infrastructure/persistence/prisma-debtor-access.journal';
import {
  PrismaDebtorAccessStore,
  PrismaDebtorCaseReader,
} from '../src/infrastructure/persistence/prisma-debtor-access.stores';
import { PrismaSettingsStore } from '../src/infrastructure/persistence/prisma-settings.stores';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';
import { NodeDebtorSecrets } from '../src/infrastructure/security/node-debtor-secrets';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Accès du débiteur contre un vrai PostgreSQL (ADR-061, ADR-050), dans un schéma jetable : un seul
 * lien actif par débiteur malgré des émissions simultanées, essais et envois comptés sous le verrou du
 * lien, sessions et journal de preuve, et seules des empreintes en base (ni jeton, ni code, ni
 * session, ni coordonnée en clair). Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
// Base partagée et suites en parallèle : un aller-retour peut prendre plus que les 5 s par défaut.
jest.setTimeout(60_000);
const CREDITOR = '0192f1c4-0000-7000-8000-00000000c0a1';
const CASE_ID = '0192f1c4-0000-7000-8000-0000000ca5e1';
const OTHER_CASE_ID = '0192f1c4-0000-7000-8000-0000000ca5e2';
const PHONE = '+2290197000145';
const EMAIL = 'debiteur@example.com';

/** Débiteurs du dossier : un par scénario, pour que les liens et les compteurs ne se mêlent pas. */
const DEBTORS = {
  concurrentIssue: '0192f1c4-0000-7000-8000-0000000deb01',
  concurrentAttempts: '0192f1c4-0000-7000-8000-0000000deb02',
  concurrentSends: '0192f1c4-0000-7000-8000-0000000deb03',
  emailOnly: '0192f1c4-0000-7000-8000-0000000deb04',
  journal: '0192f1c4-0000-7000-8000-0000000deb05',
  contacts: '0192f1c4-0000-7000-8000-0000000deb06',
} as const;

/** Secrets de production, avec le compte des comparaisons de codes. */
class CountingSecrets extends NodeDebtorSecrets {
  comparisons = 0;
  override codeMatches(accessId: string, code: string, hash: string): boolean {
    this.comparisons += 1;
    return super.codeMatches(accessId, code, hash);
  }
}

describeWithDatabase('accès du débiteur (PostgreSQL)', () => {
  const schema = `recovery_debtor_test_${Date.now()}`;
  const personal = new KitPersonalData(
    FieldCipher.fromConfig(undefined, 'test', 'RECOVERY_PII_ENCRYPTION_KEYS'),
    BlindIndex.fromConfig(undefined, 'test', 'RECOVERY_BLIND_INDEX_KEYS'),
  );
  let pool: Pool;
  let prisma: PrismaService;
  let store: PrismaDebtorAccessStore;
  let reader: PrismaDebtorCaseReader;
  let secrets: CountingSecrets;
  let notifier: CapturingNotifier;
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  let links: DebtorLinks;

  const gateway = <T>(fn: () => Promise<T>) => asService('gateway', fn);
  const open = (token: string) => gateway(() => useCases.openDebtorAccess.execute({ token }));
  const sendCode = (token: string) => gateway(() => useCases.sendDebtorAccessCode.execute({ token }));
  const verify = (token: string, code: string) =>
    gateway(() => useCases.verifyDebtorAccessCode.execute({ token, code }));
  const resolve = (sessionToken: string) =>
    gateway(() => useCases.resolveDebtorSession.execute({ sessionToken }));
  const endSession = (sessionToken: string) =>
    gateway(() => useCases.endDebtorSession.execute({ sessionToken }));
  const issue = (debtorId: string) => links.issue({ caseId: CASE_ID, debtorId });
  const wrongCode = () => (notifier.lastCode() === '000000' ? '111111' : '000000');
  const contact = (id: string, channel: 'phone' | 'email', value: string, extra: object = {}) => ({
    id,
    channel,
    valueEnc: personal.encrypt(value, contactContext(id)),
    valueIndex: channel === 'phone' ? personal.phoneIndex(value) : personal.emailIndex(value),
    ...extra,
  });

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
    for (const [id, number] of [
      [CASE_ID, 'RC-000101'],
      [OTHER_CASE_ID, 'RC-000102'],
    ] as const) {
      await prisma.recoveryCase.create({
        data: {
          id,
          number,
          kind: 'b2c',
          status: 'active',
          stage: 'notice',
          creditorType: 'organization',
          creditorId: CREDITOR,
          createdByUserId: CREDITOR,
          nature: 'unpaid_invoice',
          principal: 150_000,
        },
      });
    }
    for (const [index, debtorId] of Object.values(DEBTORS).entries()) {
      const suffix = String(index + 1).padStart(2, '0');
      const contacts =
        debtorId === DEBTORS.emailOnly
          ? [contact(`0192f1c4-0000-7000-8000-0000000dc0${suffix}`, 'email', EMAIL)]
          : [contact(`0192f1c4-0000-7000-8000-0000000dc0${suffix}`, 'phone', PHONE, { isPrimary: true })];
      await prisma.debtor.create({
        data: {
          id: debtorId,
          caseId: CASE_ID,
          kind: 'person',
          identityEnc: personal.encrypt(JSON.stringify({ lastName: 'Dossou' }), 'debtors.identity'),
          contacts: { create: contacts },
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(() => {
    store = new PrismaDebtorAccessStore(prisma);
    reader = new PrismaDebtorCaseReader(prisma);
    secrets = new CountingSecrets('secret-de-test-des-codes-0123456789');
    notifier = new CapturingNotifier();
    deps = makeDeps({
      settings: new PrismaSettingsStore(prisma),
      personalData: personal,
      ids: new UuidV7Generator(),
      notifier,
      directory: {
        usersByIds: async () => [],
        organizationsByIds: async (ids) =>
          ids.map((organizationId) => ({ organizationId, displayName: 'SARL Bénin Propre' })),
      },
      debtorAccess: {
        store,
        reader,
        journal: new PrismaDebtorAccessJournal(prisma),
        secrets,
        baseUrl: 'https://ksp.bj/recouvrement',
      },
    });
    useCases = createUseCases(deps);
    links = new DebtorLinks(deps);
  });

  it('émissions simultanées : un seul lien actif ; seule l’empreinte du jeton est en base', async () => {
    const issued = await Promise.all(Array.from({ length: 5 }, () => issue(DEBTORS.concurrentIssue)));
    const active = await prisma.debtorAccess.findMany({
      where: { debtorId: DEBTORS.concurrentIssue, revokedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(issued.filter((link) => !link.renewed)).toHaveLength(1);
    const opened = await Promise.allSettled(issued.map((link) => open(link.token)));
    expect(opened.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const raw = JSON.stringify((await pool.query('SELECT * FROM debtor_accesses')).rows);
    for (const link of issued) expect(raw).not.toContain(link.token);
    expect(active[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('essais simultanés : jamais plus de 5 comparaisons, puis accès bloqué une heure (ADR-050)', async () => {
    const { token, accessId } = await issue(DEBTORS.concurrentAttempts);
    await sendCode(token);
    const wrong = wrongCode();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => verify(token, wrong)));
    const codes = results.map((result) =>
      result.status === 'rejected' ? (result.reason as { code: string }).code : 'ok',
    );
    expect(secrets.comparisons).toBe(5);
    expect(codes.filter((code) => code === 'RECOVERY_DEBTOR_CODE_INVALID')).toHaveLength(4);
    expect(codes.filter((code) => code === 'RECOVERY_DEBTOR_LOCKED')).toHaveLength(16);
    const row = await prisma.debtorAccess.findUniqueOrThrow({ where: { id: accessId } });
    expect(row).toMatchObject({ failedAttempts: 5, lockedUntil: new Date(NOW.getTime() + 3_600_000) });
    expect(
      await prisma.evidenceEntry.count({ where: { refId: accessId, action: 'debtor_access_locked' } }),
    ).toBe(1);
  });

  it('demandes de code simultanées : un seul code part ; seule son empreinte HMAC est en base', async () => {
    const { token, accessId } = await issue(DEBTORS.concurrentSends);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => sendCode(token)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .map((result) => (result as PromiseRejectedResult).reason.code),
    ).toEqual(Array(9).fill('RECOVERY_DEBTOR_CODE_TOO_SOON'));
    expect(notifier.sent).toHaveLength(1);
    const row = await prisma.debtorAccess.findUniqueOrThrow({ where: { id: accessId } });
    expect(row).toMatchObject({ codesSentCount: 1, codeSentAt: NOW });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(notifier.lastCode());
  });

  it('session : ouverte par le bon code, fermée, révoquée au renouvellement ; empreinte seule en base', async () => {
    const { token } = await issue(DEBTORS.emailOnly);
    await expect(open(token)).resolves.toMatchObject({
      creditorName: 'SARL Bénin Propre',
      contactMasked: 'd***@example.com',
    });
    await expect(sendCode(token)).resolves.toMatchObject({ channel: 'email' });
    expect(notifier.sent[0]).toMatchObject({ channel: 'email', phone: null, email: EMAIL });
    const { sessionToken } = await verify(token, notifier.lastCode());
    await expect(resolve(sessionToken)).resolves.toMatchObject({
      caseId: CASE_ID,
      debtorId: DEBTORS.emailOnly,
    });
    expect(JSON.stringify((await pool.query('SELECT * FROM debtor_sessions')).rows)).not.toContain(
      sessionToken,
    );
    await endSession(sessionToken);
    expect((await rejection(resolve(sessionToken))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');

    // Une nouvelle ouverture demande un nouveau code, une minute au moins après le précédent.
    deps.clock.current = new Date(NOW.getTime() + 120_000);
    await sendCode(token);
    const second = (await verify(token, notifier.lastCode())).sessionToken;
    await expect(resolve(second)).resolves.toBeDefined();
    await issue(DEBTORS.emailOnly);
    expect((await rejection(resolve(second))).code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
    expect((await rejection(open(token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
  });

  it('journal de preuve : chaque action de l’accès, sans coordonnée ni secret', async () => {
    const link = await issue(DEBTORS.journal);
    await open(link.token);
    await sendCode(link.token);
    const code = notifier.lastCode();
    await rejection(verify(link.token, wrongCode()));
    const { sessionToken } = await verify(link.token, code);
    await endSession(sessionToken);
    const { rows } = await pool.query(
      `SELECT actor_type, actor_id, action, channel, summary, ref_type, ref_id FROM evidence_entries
       WHERE ref_id = $1 ORDER BY occurred_at, created_at, id`,
      [link.accessId],
    );
    expect(rows.map((row) => [row.action, row.actor_type, row.actor_id])).toEqual([
      ['debtor_link_issued', 'system', null],
      ['debtor_link_opened', 'debtor', DEBTORS.journal],
      ['debtor_code_sent', 'system', null],
      ['debtor_code_verified', 'debtor', DEBTORS.journal],
      ['debtor_session_ended', 'debtor', DEBTORS.journal],
    ]);
    expect(rows.every((row) => row.ref_type === 'debtor_access')).toBe(true);
    const written = JSON.stringify(rows);
    for (const secret of [PHONE, '97000145', EMAIL, link.token, code, sessionToken]) {
      expect(written).not.toContain(secret);
    }
  });

  it('lecture : dossier du débiteur, coordonnées valables la principale d’abord ; révocation par dossier', async () => {
    await expect(reader.caseDebtor(CASE_ID, DEBTORS.contacts)).resolves.toEqual({
      caseNumber: 'RC-000101',
      caseStatus: 'active',
      creditor: { type: 'organization', id: CREDITOR },
      closedAt: null,
    });
    await expect(reader.caseDebtor(OTHER_CASE_ID, DEBTORS.contacts)).resolves.toBeNull();
    await prisma.debtorContact.createMany({
      data: [
        { ...contact('0192f1c4-0000-7000-8000-0000000dc101', 'email', EMAIL), debtorId: DEBTORS.contacts },
        {
          ...contact('0192f1c4-0000-7000-8000-0000000dc102', 'phone', '+2290197000999'),
          debtorId: DEBTORS.contacts,
          valid: false,
        },
      ],
    });
    const contacts = await reader.contacts(DEBTORS.contacts);
    expect(contacts.map((item) => item.channel)).toEqual(['phone', 'email']);
    expect(personal.decrypt(contacts[0]!.valueEnc, contacts[0]!.context!)).toBe(PHONE);

    await expect(
      store.issue({
        id: '0192f1c4-0000-7000-8000-0000000ac999',
        caseId: OTHER_CASE_ID,
        debtorId: DEBTORS.contacts,
        tokenHash: 'f'.repeat(64),
        link: { issuedAt: NOW, expiresAt: NOW, revokedAt: null },
      }),
    ).resolves.toBeNull();
    const { token } = await issue(DEBTORS.contacts);
    await expect(links.revoke({ caseId: CASE_ID, debtorId: DEBTORS.contacts })).resolves.toEqual({
      revoked: 1,
    });
    expect((await rejection(open(token))).code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
  });
});
