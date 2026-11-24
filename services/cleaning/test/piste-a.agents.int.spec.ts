import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@ksp/platform';
import { ChangeAgentStatusUseCase } from '../src/application/agents/agent-admin.use-cases';
import { CreateAgentUseCase } from '../src/application/agents/agent-creation.use-case';
import { GetAgentIdDocumentUseCase } from '../src/application/agents/agent-id-document.use-case';
import { type AgentDeps } from '../src/application/deps';
import { type StoredPhoto } from '../src/application/ports';
import { asStaff, FakeAgentAccounts, FakeAgentRoles } from '../src/application/testing/planning-fakes';
import { travelFromMatrix } from '../src/domain/planning/agenda';
import { AesGcmFieldCipher } from '../src/infrastructure/crypto/aes-gcm-field-cipher';
import { PrismaPlanningRepository } from '../src/infrastructure/persistence/planning/prisma-planning.repository';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/**
 * Critère de la piste A (agents) contre un vrai PostgreSQL : agent créé par l'admin pour un numéro
 * sans compte, rôle cleaning_agent demandé à identity à la validation et retiré à la désactivation,
 * lecture tracée de la pièce d'identité. identity et file sont simulés par leurs ports. Ignoré sans
 * TEST_DATABASE_URL.
 */
const DEMO = join(__dirname, '..', 'prisma', 'demo', 'demo-data.sql');
const ADMIN = '0192f1c4-0000-7000-8000-00000000ad01';
const PHONE = '+2290197000045';

describeWithDatabase('piste A : agents (PostgreSQL)', () => {
  let db: TestDatabase;
  let prisma: PrismaService;
  let deps: AgentDeps;
  let accounts: FakeAgentAccounts;
  let roles: FakeAgentRoles;
  const ids = new UuidV7Generator();
  const files = { photo: ids.next(), front: ids.next(), back: ids.next() };
  const attached: { fileId: string; ownerId: string }[] = [];

  const stored = (fileId: string): StoredPhoto => ({
    fileId,
    fileName: 'piece.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 120_000,
    uploadedAt: new Date('2026-11-10T09:30:00Z'),
    downloadUrl: `https://files.ksp.test/${fileId}?signature=secret`,
    downloadExpiresAt: new Date('2026-11-23T12:00:00Z'),
  });

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_piste_a');
    prisma = db.prisma;
    const client = await db.pool.connect();
    try {
      await client.query("SET ksp.demo = 'on'");
      await client.query(readFileSync(DEMO, 'utf8'));
    } finally {
      client.release();
    }
    const clock = new SystemClock();
    accounts = new FakeAgentAccounts();
    roles = new FakeAgentRoles();
    deps = {
      planning: new PrismaPlanningRepository(prisma, clock, ids),
      travel: { matrix: async () => travelFromMatrix({}) },
      cipher: AesGcmFieldCipher.fromConfig(undefined, 'test'),
      clock,
      ids,
      people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
      photos: {
        attach: async (input: { fileId: string; ownerId: string }) => {
          attached.push({ fileId: input.fileId, ownerId: input.ownerId });
        },
        remove: async () => undefined,
        list: async () => Object.values(files).map(stored),
      },
      roles,
      accounts,
    } as unknown as AgentDeps;
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );

  const request = (idempotencyKey: string, phone = PHONE) => ({
    idempotencyKey,
    phone,
    firstName: 'Awa',
    lastName: 'Dossou',
    photoFileId: files.photo,
    idDocumentFrontFileId: files.front,
    idDocumentBackFileId: files.back,
    residenceCommuneKey: 'cotonou',
    zoneKeys: ['cotonou'],
    skillCodes: ['indoor_cleaning'],
    weekly: [{ weekday: 'mon', ranges: [{ start: '07:00', end: '13:00' }] }],
    emergencyContact: { name: 'Koffi', phone: '+22997000000' },
    employmentKind: 'employee',
  });
  const create = (idempotencyKey: string, phone?: string) =>
    asStaff(() => new CreateAgentUseCase(deps).execute(request(idempotencyKey, phone)), ADMIN);
  const change = (
    action: 'approve' | 'deactivate',
    agentId: string,
    idempotencyKey: string,
    extra: { reason?: string; validatedSkillCodes?: string[] } = {},
  ) =>
    asStaff(
      () => new ChangeAgentStatusUseCase(deps).execute({ action, agentId, idempotencyKey, ...extra }),
      ADMIN,
    );
  const row = (agentId: string) => prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

  let agentId: string;

  it('l’admin crée un agent pour un numéro sans compte : compte créé chez identity, agent « en vérification »', async () => {
    const profile = await create('piste-a-creation-1');
    agentId = profile.agent.id;
    const account = accounts.byPhone.get(PHONE)!;
    expect(accounts.created).toEqual([account.userId]);
    expect(accounts.ensured).toEqual([{ phone: PHONE, firstName: 'Awa', lastName: 'Dossou' }]);

    const agent = await row(agentId);
    expect(agent).toMatchObject({
      userId: account.userId,
      status: 'under_review',
      displayName: 'Awa Dossou',
      createdBy: ADMIN,
      roleAssignmentId: null,
    });
    // Données personnelles chiffrées : ni les fichiers de la pièce, ni le téléphone en clair.
    expect(agent.idDocumentEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(agent)).not.toContain(files.front);
    expect(JSON.stringify(agent)).not.toContain('97000045');
    expect(attached).toEqual(Object.values(files).map((fileId) => ({ fileId, ownerId: ADMIN })));

    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'cleaning.agent.applied' } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { payload: unknown }).payload).toMatchObject({
      agentId,
      userId: account.userId,
      source: 'admin_created',
      zoneKeys: ['cotonou'],
    });
    expect(JSON.stringify(events)).not.toContain('97000045');
    const trail = await prisma.auditEntry.findMany({ where: { entityId: agentId } });
    expect(trail.map((entry) => [entry.actorId, entry.action, entry.details])).toEqual([
      [ADMIN, 'agent.status_changed', { before: null, after: 'under_review', source: 'admin_created' }],
    ]);
  }, 60_000);

  it('rejouée avec la même clé : même agent ; un second agent pour le même numéro est refusé', async () => {
    expect((await create('piste-a-creation-1')).agent.id).toBe(agentId);
    expect(await failure(create('piste-a-creation-2'))).toMatchObject({
      kind: 'CONFLICT',
      code: 'CLEANING_AGENT_ALREADY_REGISTERED',
    });
    expect(await failure(create('piste-a-creation-3', '+229 97 00 00 45'))).toMatchObject({
      code: 'CLEANING_AGENT_ALREADY_REGISTERED',
    });
    expect(await prisma.agent.count()).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.agent.applied' } })).toBe(1);
  }, 60_000);

  it('identity injoignable à la validation : rien n’est écrit ; puis la validation demande le rôle', async () => {
    roles.failure = AppError.unavailable('IDENTITY_UNAVAILABLE', 'indisponible');
    const approval = { validatedSkillCodes: ['indoor_cleaning'] };
    expect(await failure(change('approve', agentId, 'piste-a-validation', approval))).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
    expect(await row(agentId)).toMatchObject({ status: 'under_review', roleAssignmentId: null });
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.agent.approved' } })).toBe(0);

    roles.failure = null;
    const profile = await change('approve', agentId, 'piste-a-validation', approval);
    expect(profile.agent.status).toBe('active');
    const userId = accounts.byPhone.get(PHONE)!.userId;
    expect(roles.granted).toEqual([{ userId, reason: 'Agent validé' }]);
    expect(await row(agentId)).toMatchObject({
      status: 'active',
      roleAssignmentId: roles.active.get(userId),
    });
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.agent.approved' } })).toBe(1);
  }, 60_000);

  it('lecture de la pièce d’identité : adresses rendues, consultation écrite au journal d’audit', async () => {
    const document = await asStaff(() => new GetAgentIdDocumentUseCase(deps).execute(agentId), ADMIN);
    expect(document.front).toMatchObject({ fileId: files.front, url: stored(files.front).downloadUrl });
    expect(document.back).toMatchObject({ fileId: files.back, url: stored(files.back).downloadUrl });
    const reads = await prisma.auditEntry.findMany({ where: { action: 'agent.id_document_read' } });
    expect(reads.map((entry) => [entry.actorId, entry.entityType, entry.entityId, entry.details])).toEqual([
      [ADMIN, 'agent', agentId, null],
    ]);
    // Ni fichier ni adresse dans le journal.
    expect(JSON.stringify(reads)).not.toContain(files.front);
    expect(JSON.stringify(reads)).not.toContain('files.ksp.test');
  }, 60_000);

  it('désactivation : agent désactivé même si identity est injoignable, rôle retiré au rejeu', async () => {
    const assignmentId = (await row(agentId)).roleAssignmentId!;
    roles.failure = AppError.unavailable('IDENTITY_UNAVAILABLE', 'indisponible');
    const departure = { reason: 'Départ' };
    expect(await failure(change('deactivate', agentId, 'piste-a-desactivation', departure))).toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
    // Jamais « actif sans rôle » : désactivé, attribution encore notée pour le retrait.
    expect(await row(agentId)).toMatchObject({ status: 'deactivated', roleAssignmentId: assignmentId });

    roles.failure = null;
    const profile = await change('deactivate', agentId, 'piste-a-desactivation', departure);
    expect(profile.agent.status).toBe('deactivated');
    expect(roles.revoked).toEqual([{ assignmentId, reason: 'Agent désactivé' }]);
    expect(await row(agentId)).toMatchObject({ status: 'deactivated', roleAssignmentId: null });
    const changes = await prisma.auditEntry.findMany({
      where: { entityId: agentId, action: 'agent.status_changed' },
    });
    expect(changes).toHaveLength(3);
  }, 60_000);
});
