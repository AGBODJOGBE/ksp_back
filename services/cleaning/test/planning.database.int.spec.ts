import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AppError } from '@ksp/platform';
import { type Pool } from 'pg';
import { ChangeAgentStatusUseCase } from '../src/application/agents/agent-admin.use-cases';
import { SubmitAgentApplicationUseCase } from '../src/application/agents/agent-registration.use-cases';
import { AvailabilityUseCases } from '../src/application/agents/availability.use-cases';
import { type AgentDeps } from '../src/application/deps';
import {
  CreateAssignmentsUseCase,
  RemoveAssignmentUseCase,
} from '../src/application/planning/assignment.use-cases';
import { ScheduleOverlapError } from '../src/application/planning/planning.ports';
import { PlanningViewUseCases } from '../src/application/planning/planning-view.use-cases';
import { travelFromMatrix } from '../src/domain/planning/agenda';
import { asStaff, asUser, FakeAgentRoles } from '../src/application/testing/planning-fakes';
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
 * Lot D contre un vrai PostgreSQL : verrou de l'agenda, contrainte assignments_no_overlap, cycle
 * de vie d'un agent, disponibilités. Les séances cibles (lot E) sont créées en SQL dans le jeu
 * d'essai. Ignoré sans TEST_DATABASE_URL.
 */
const DEMO = join(__dirname, '..', 'prisma', 'demo', 'demo-data.sql');
const SUPERVISORS = ['0192f1c4-0000-7000-8000-00000000b001', '0192f1c4-0000-7000-8000-00000000b002'];

describeWithDatabase('planification du lot D (PostgreSQL)', () => {
  let db: TestDatabase;
  const ids = new UuidV7Generator();
  let pool: Pool;
  let prisma: PrismaService;
  let deps: AgentDeps;
  const sessions: Record<'s1' | 's2' | 's3', string> = { s1: ids.next(), s2: ids.next(), s3: ids.next() };

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_d');
    pool = db.pool;
    prisma = db.prisma;
    const client = await pool.connect();
    try {
      await client.query("SET ksp.demo = 'on'");
      await client.query(readFileSync(DEMO, 'utf8'));
    } finally {
      client.release();
    }
    await seedSessions(pool, sessions);
    const clock = new SystemClock();
    deps = {
      planning: new PrismaPlanningRepository(prisma, clock, ids),
      travel: { matrix: async () => travelFromMatrix({}) },
      cipher: AesGcmFieldCipher.fromConfig(undefined, 'test'),
      clock,
      ids,
      people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
      photos: { attach: async () => undefined, remove: async () => undefined, list: async () => [] },
      // Piste A : rôle cleaning_agent attribué par identity à la validation (R-AG-01).
      roles: new FakeAgentRoles(),
    } as unknown as AgentDeps;
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );

  /** Agent inscrit puis validé, disponible tous les jours, compétence validée ou non. */
  async function activeAgent(validated: string[] = ['indoor_cleaning']): Promise<string> {
    const userId = ids.next();
    const profile = await asUser(
      () =>
        new SubmitAgentApplicationUseCase(deps).execute({
          idempotencyKey: `inscription-${userId}`,
          firstName: 'Awa',
          lastName: 'Dossou',
          photoFileId: ids.next(),
          idDocumentFrontFileId: ids.next(),
          idDocumentBackFileId: ids.next(),
          residenceCommuneKey: 'cotonou',
          zoneKeys: ['cotonou'],
          skillCodes: ['indoor_cleaning'],
          weekly: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({
            weekday,
            ranges: [{ start: '00:00', end: '24:00' }],
          })),
          emergencyContact: { name: 'Koffi', phone: '+22997000000' },
          employmentKind: 'employee',
        }),
      userId,
    );
    const change = (action: 'review' | 'approve') =>
      asStaff(
        () =>
          new ChangeAgentStatusUseCase(deps).execute({
            action,
            agentId: profile.agent.id,
            idempotencyKey: `${action}-${profile.agent.id}`,
            validatedSkillCodes: validated,
          }),
        SUPERVISORS[0],
      );
    await change('review');
    await change('approve');
    return profile.agent.id;
  }

  const assign = (agentId: string, session: string, supervisor: string) =>
    asStaff(
      () =>
        new CreateAssignmentsUseCase(deps).execute({
          idempotencyKey: `affectation-${ids.next()}`,
          targets: [{ kind: 'session', id: session }],
          agentIds: [agentId],
          overrides: [],
        }),
      supervisor,
    );

  it('critère du lot D : deux superviseurs, même agent, deux séances qui se chevauchent : une seule passe', async () => {
    const agentId = await activeAgent();
    const results = await Promise.allSettled([
      assign(agentId, sessions.s1, SUPERVISORS[0]!),
      assign(agentId, sessions.s2, SUPERVISORS[1]!),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected!.reason).toMatchObject({ code: 'CLEANING_SCHEDULE_CONFLICT', kind: 'CONFLICT' });
    expect(await prisma.assignment.count({ where: { agentId, status: 'confirmed' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.session.assigned' } })).toBe(1);
  }, 60_000);

  it('critère du lot D : un agent sans la compétence est refusé', async () => {
    const agentId = await activeAgent([]);
    expect(await failure(assign(agentId, sessions.s3, SUPERVISORS[0]!))).toMatchObject({
      code: 'CLEANING_SKILL_MISSING',
    });
    expect(await prisma.assignment.count({ where: { agentId } })).toBe(0);
  }, 60_000);

  it('la contrainte d’exclusion remonte en ScheduleOverlapError, sans rien écrire', async () => {
    const agentId = await activeAgent();
    const row = (session: string) => ({
      id: ids.next(),
      target: { kind: 'session' as const, id: session },
      agentId,
      isLead: false,
      source: 'manual' as const,
      status: 'confirmed' as const,
      respondBefore: null,
      occupiedFrom: new Date('2030-01-07T08:00:00Z'),
      occupiedUntil: new Date('2030-01-07T10:00:00Z'),
      travelMinutes: 0,
      overrides: [],
      reason: null,
      createdBy: SUPERVISORS[0]!,
      createdAt: new Date(),
    });
    await expect(
      deps.planning.transaction((tx) => tx.insertAssignments([row(sessions.s1), row(sessions.s2)])),
    ).rejects.toBeInstanceOf(ScheduleOverlapError);
    expect(await prisma.assignment.count({ where: { agentId } })).toBe(0);
  }, 60_000);

  it('verrou de l’agenda pris dans l’ordre des identifiants : pas d’interblocage', async () => {
    const [a, b] = [await activeAgent(), await activeAgent()];
    const hold = (order: string[]) =>
      deps.planning.transaction(async (tx) => {
        await tx.lockAgents(order);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return order[0];
      });
    await expect(Promise.all([hold([a!, b!]), hold([b!, a!])])).resolves.toEqual([a, b]);
  }, 60_000);

  it('retrait, indisponibilité forcée, suspension : l’agenda se libère, la séance repasse à affecter', async () => {
    const agentId = await activeAgent();
    const batch = await assign(agentId, sessions.s3, SUPERVISORS[0]!);
    expect(await prisma.session.findUniqueOrThrow({ where: { id: sessions.s3 } })).toMatchObject({
      status: 'assigned',
    });
    await asStaff(() =>
      new RemoveAssignmentUseCase(deps).execute({
        assignmentId: batch.assignments[0]!.id,
        idempotencyKey: `retrait-${agentId}`,
        reason: 'Échange',
      }),
    );
    expect(await prisma.session.findUniqueOrThrow({ where: { id: sessions.s3 } })).toMatchObject({
      status: 'to_assign',
    });

    await assign(agentId, sessions.s3, SUPERVISORS[0]!);
    const leave = {
      agentId,
      idempotencyKey: `conge-${agentId}`,
      start: '2030-01-08T00:00:00Z',
      end: '2030-01-09T00:00:00Z',
      kind: 'leave',
    };
    expect(await failure(asStaff(() => new AvailabilityUseCases(deps).declareFor(leave)))).toMatchObject({
      code: 'CLEANING_UNAVAILABILITY_CONFLICT',
    });
    const view = await asStaff(() =>
      new AvailabilityUseCases(deps).declareFor({
        ...leave,
        idempotencyKey: `force-${agentId}`,
        force: true,
      }),
    );
    expect(view.unavailabilities).toEqual([expect.objectContaining({ forced: true, reason: 'leave' })]);
    expect(await prisma.assignment.count({ where: { agentId, status: 'confirmed' } })).toBe(0);
    expect(
      await prisma.auditEntry.count({ where: { action: 'agent.unavailability_forced', entityId: agentId } }),
    ).toBe(1);

    const suspended = await asStaff(() =>
      new ChangeAgentStatusUseCase(deps).execute({
        action: 'suspend',
        agentId,
        idempotencyKey: `suspension-${agentId}`,
        reason: 'Absences',
      }),
    );
    expect(suspended.agent.status).toBe('suspended');
    const planning = await asStaff(() =>
      new PlanningViewUseCases(deps).planning({ from: '2030-01-06T00:00:00Z', to: '2030-01-13T00:00:00Z' }),
    );
    expect(planning.items.map((i) => i.target.id)).toEqual(expect.arrayContaining(Object.values(sessions)));
  }, 60_000);

  it('validation : événement cleaning.agent.approved dans l’outbox, compétences validées', async () => {
    const agentId = await activeAgent();
    const events = await prisma.outboxEvent.findMany({ where: { eventType: 'cleaning.agent.approved' } });
    expect(events.map((e) => (e.payload as { payload: { agentId: string } }).payload.agentId)).toContain(
      agentId,
    );
    expect(await prisma.agentSkill.findMany({ where: { agentId } })).toEqual([
      expect.objectContaining({
        skillCode: 'indoor_cleaning',
        status: 'validated',
        reviewedBy: SUPERVISORS[0],
      }),
    ]);
  }, 60_000);
});

/**
 * Jeu d'essai : un lieu, une demande acceptée, un devis, un programme de Cotonou et trois séances
 * « à affecter » : s1 et s2 se chevauchent le lundi 7 janvier 2030, s3 le lendemain.
 */
async function seedSessions(pool: Pool, sessions: Record<'s1' | 's2' | 's3', string>): Promise<void> {
  const ids = new UuidV7Generator();
  const [place, request, quote, program, owner] = [
    ids.next(),
    ids.next(),
    ids.next(),
    ids.next(),
    ids.next(),
  ];
  const { rows } = await pool.query<{ offer_id: string; place_type_id: string }>(
    'SELECT id AS offer_id, place_type_id FROM offers LIMIT 1',
  );
  const { offer_id: offerId, place_type_id: placeTypeId } = rows[0]!;
  await pool.query(
    `INSERT INTO places (id, owner_kind, owner_id, place_type_id, name, gps_encrypted, landmark_encrypted, commune_key, created_by, created_at, updated_at)
     VALUES ($1, 'user', $2, $3, 'Maison', 'x', 'x', 'cotonou', $2, now(), now())`,
    [place, owner, placeTypeId],
  );
  await pool.query(
    `INSERT INTO cleaning_requests (id, owner_kind, owner_id, submitted_by, place_id, place_type_id, commune_key, gps_encrypted, landmark_encrypted, status, declared_values, schedule_plan, visit_slots, created_at, updated_at)
     VALUES ($1, 'user', $2, $2, $3, $4, 'cotonou', 'x', 'x', 'accepted', '{}', '{}', '[{}]', now(), now())`,
    [request, owner, place, placeTypeId],
  );
  await pool.query('INSERT INTO request_items (request_id, offer_id) VALUES ($1, $2)', [request, offerId]);
  await pool.query(
    `INSERT INTO quotes (id, request_id, version, lines, session_price, sessions_count, total, team_size, duration_minutes, schedule_plan, created_by, created_at)
     VALUES ($1, $2, 1, '[]', 10000, 3, 30000, 1, 120, '{}', $3, now())`,
    [quote, request, owner],
  );
  await pool.query(
    `INSERT INTO programs (id, request_id, quote_id, owner_kind, owner_id, payer_kind, place_id, commune_key, session_price, team_size, duration_minutes, schedule_plan, created_at, updated_at)
     VALUES ($1, $2, $3, 'user', $4, 'individual', $5, 'cotonou', 10000, 1, 120, '{}', now(), now())`,
    [program, request, quote, owner, place],
  );
  const slots: [string, number, string, string][] = [
    [sessions.s1, 1, '2030-01-07T08:00:00Z', '2030-01-07T10:00:00Z'],
    [sessions.s2, 2, '2030-01-07T09:00:00Z', '2030-01-07T11:00:00Z'],
    [sessions.s3, 3, '2030-01-08T08:00:00Z', '2030-01-08T10:00:00Z'],
  ];
  for (const [id, rank, start, end] of slots) {
    await pool.query(
      `INSERT INTO sessions (id, program_id, rank, commune_key, scheduled_start, scheduled_end, price, created_at, updated_at)
       VALUES ($1, $2, $3, 'cotonou', $4, $5, 10000, now(), now())`,
      [id, program, rank, start, end],
    );
  }
}
