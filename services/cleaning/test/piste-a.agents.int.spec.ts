import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, BlindIndex } from '@ksp/platform';
import { ChangeAgentStatusUseCase } from '../src/application/agents/agent-admin.use-cases';
import { CreateAgentUseCase } from '../src/application/agents/agent-creation.use-case';
import { GetAgentIdDocumentUseCase } from '../src/application/agents/agent-id-document.use-case';
import { InviteAgentUseCase } from '../src/application/agents/agent-invitation.use-case';
import { SubmitAgentApplicationUseCase } from '../src/application/agents/agent-registration.use-cases';
import { InvitationSendFailedError } from '../src/application/agents/agent.ports';
import { type AgentDeps } from '../src/application/deps';
import { type StoredPhoto } from '../src/application/ports';
import {
  asStaff,
  asUser,
  FakeAgentAccounts,
  FakeAgentRoles,
  FakeInvitationSender,
} from '../src/application/testing/planning-fakes';
import { travelFromMatrix } from '../src/domain/planning/agenda';
import { AesGcmFieldCipher } from '../src/infrastructure/crypto/aes-gcm-field-cipher';
import { BlindIndexPhoneFingerprints } from '../src/infrastructure/crypto/phone-fingerprints';
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
 * lecture tracée de la pièce d'identité ; invitation enregistrée puis envoyée, inscription avec
 * cette invitation. identity, file et notification sont simulés par leurs ports. Ignoré sans
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
  let sender: FakeInvitationSender;
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
    sender = new FakeInvitationSender();
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
      invitations: sender,
      phoneFingerprints: new BlindIndexPhoneFingerprints(
        BlindIndex.fromConfig(undefined, 'test', 'CLEANING_BLIND_INDEX_KEYS'),
      ),
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

  // --- Invitation d'un agent (R-AG-02) ---
  const INVITED_PHONE = '+2290197000046';
  const INVITED_USER = '0192f1c4-0000-7000-8000-00000000a0b1';
  const OTHER_USER = '0192f1c4-0000-7000-8000-00000000a0b2';
  const invite = (idempotencyKey: string, phone = INVITED_PHONE) =>
    asStaff(() => new InviteAgentUseCase(deps).execute({ idempotencyKey, phone }), ADMIN);
  const apply = (idempotencyKey: string, invitationId: string, userId = INVITED_USER) =>
    asUser(
      () =>
        new SubmitAgentApplicationUseCase(deps).execute({
          ...request(idempotencyKey),
          photoFileId: ids.next(),
          idDocumentFrontFileId: ids.next(),
          idDocumentBackFileId: ids.next(),
          invitationId,
        }),
      userId,
    );
  const refused = (reason: string) => ({
    code: 'CLEANING_VALIDATION_FAILED',
    details: { field: 'invitationId', reason },
  });
  let invitationId: string;

  it('invitation : enregistrée chiffrée avant l’envoi ; envoi en échec rejoué sans seconde invitation', async () => {
    sender.failure = AppError.unavailable('NOTIFICATION_UNAVAILABLE', 'indisponible');
    expect(await failure(invite('piste-a-invitation-1'))).toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'NOTIFICATION_UNAVAILABLE',
    });
    expect(await prisma.agentInvitation.count()).toBe(1);
    // notification répond que tous les canaux ont échoué : la tentative suivante prend une autre clé.
    sender.failure = new InvitationSendFailedError();
    expect(await failure(invite('piste-a-invitation-1'))).toMatchObject({ code: 'NOTIFICATION_UNAVAILABLE' });
    sender.failure = null;
    const invitation = await invite('piste-a-invitation-1');
    invitationId = invitation.id;
    expect(invitation.phone).toBe(INVITED_PHONE);
    expect(sender.attempts).toEqual([1, 1, 2]);
    expect(sender.sent).toEqual([
      { invitationId, attempt: 2, phone: INVITED_PHONE, expiresAt: invitation.expiresAt },
    ]);

    const rows = await prisma.agentInvitation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: invitationId,
      createdBy: ADMIN,
      sendAttempts: 2,
      consumedAt: null,
      agentId: null,
    });
    expect(rows[0]!.sentAt).not.toBeNull();
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBe(7 * 24 * 3_600_000);
    // Jamais le numéro en clair : chiffré, et retrouvé par son empreinte à clé.
    expect(rows[0]!.phoneEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain('97000046');

    // Rejouée : même invitation, aucun envoi. Autre clé pour le même numéro : la même, renvoyée.
    expect((await invite('piste-a-invitation-1')).id).toBe(invitationId);
    expect(sender.attempts).toHaveLength(3);
    expect((await invite('piste-a-invitation-2', '+229 97 00 00 46')).id).toBe(invitationId);
    expect(sender.attempts).toEqual([1, 1, 2, 3]);
    expect(await prisma.agentInvitation.count()).toBe(1);
    const trail = await prisma.auditEntry.findMany({ where: { action: 'agent.invited' } });
    expect(trail.map((entry) => [entry.actorId, entry.entityType, entry.entityId])).toEqual([
      [ADMIN, 'agent_invitation', invitationId],
      [ADMIN, 'agent_invitation', invitationId],
    ]);
    expect(JSON.stringify(trail)).not.toContain('97000046');

    // Un numéro dont le compte est déjà agent n'est pas invité.
    expect(await failure(invite('piste-a-invitation-3', PHONE))).toMatchObject({
      kind: 'CONFLICT',
      code: 'CLEANING_AGENT_ALREADY_REGISTERED',
    });
  }, 60_000);

  it('inscription avec l’invitation : source invited, invitation consommée ; réutilisée ou d’un autre numéro : refusée', async () => {
    // La personne invitée a ouvert son compte KSP avec le numéro invité.
    accounts.byPhone.set(INVITED_PHONE, { userId: INVITED_USER, status: 'active' });
    expect(await failure(apply('piste-a-inscription-0', invitationId, OTHER_USER))).toMatchObject(
      refused('invitation_not_found'),
    );
    expect(await prisma.agent.count()).toBe(1);

    const profile = await apply('piste-a-inscription-1', invitationId);
    expect(profile.agent).toMatchObject({ userId: INVITED_USER, status: 'applicant' });
    const invitation = await prisma.agentInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(invitation).toMatchObject({ agentId: profile.agent.id, phoneEncrypted: null });
    expect(invitation.consumedAt).not.toBeNull();
    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'cleaning.agent.applied' } });
    expect(
      events.map((event) => (event.payload as { payload: { source: string } }).payload.source).sort(),
    ).toEqual(['admin_created', 'invited']);

    expect(await failure(apply('piste-a-inscription-2', invitationId, OTHER_USER))).toMatchObject(
      refused('invitation_consumed'),
    );
    expect(await prisma.agent.count()).toBe(2);
  }, 60_000);

  it('invitation expirée : inscription refusée, invitation intacte', async () => {
    const phone = '+2290197000047';
    const userId = '0192f1c4-0000-7000-8000-00000000a0b3';
    const invitation = await invite('piste-a-invitation-4', phone);
    accounts.byPhone.set(phone, { userId, status: 'active' });
    await prisma.agentInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await failure(apply('piste-a-inscription-3', invitation.id, userId))).toMatchObject(
      refused('invitation_expired'),
    );
    expect(await prisma.agent.count()).toBe(2);
    expect(await prisma.agentInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).toMatchObject({
      consumedAt: null,
      agentId: null,
    });
  }, 60_000);
});
