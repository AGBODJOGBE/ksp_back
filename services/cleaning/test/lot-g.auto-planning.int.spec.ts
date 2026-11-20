import { type Pool } from 'pg';
import {
  RunAutoPlanningUseCase,
  ScheduledAutoPlanningUseCase,
} from '../src/application/auto-planning/auto-planning.use-cases';
import {
  ApproveProposalsUseCase,
  ListProposalsUseCase,
} from '../src/application/auto-planning/proposals.use-cases';
import { type CleaningDeps } from '../src/application/deps';
import { travelFromMatrix } from '../src/domain/planning/agenda';
import { PrismaAutoPlanningRepository } from '../src/infrastructure/persistence/auto-planning/prisma-auto-planning.repository';
import { PrismaPlanningRepository } from '../src/infrastructure/persistence/planning/prisma-planning.repository';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { type Clock } from '../src/application/ports';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';
import {
  asStaffWith,
  loadDemo,
  seedAgent,
  seedAssignment,
  seedProgram,
  seedSession,
} from './support/lot-g-seed';

/**
 * Critère du lot G (partie 18) contre un vrai PostgreSQL : « Sur un jeu de 50 séances et 10 agents,
 * l'automatique affecte toutes les séances possibles sans conflit et garde la même équipe d'une
 * séance à l'autre quand elle est libre. » Puis le mode proposition, la validation en un clic et le
 * verrou du passage régulier. Ignoré sans TEST_DATABASE_URL.
 */
const PLANNER = ['cleaning.planning.manage'];
const MINUTE = 60_000;
const DEFAULT_TRAVEL = 30;

/** Deux semaines ouvrées de janvier 2030 (lundi 7 au vendredi 18). */
const DAYS = ['07', '08', '09', '10', '11', '14', '15', '16', '17', '18'].map((d) => `2030-01-${d}`);
const PROGRAMS = [
  { from: '08:00', to: '10:00', size: 2 },
  { from: '08:00', to: '11:00', size: 2 },
  { from: '13:00', to: '15:00', size: 2 },
  { from: '14:00', to: '16:00', size: 1 },
  { from: '17:00', to: '19:00', size: 1 },
];
const at = (day: string, time: string) => `${day}T${time}:00+01:00`;

describeWithDatabase('critère du lot G : planification automatique (PostgreSQL)', () => {
  let db: TestDatabase;
  let pool: Pool;
  let prisma: PrismaService;
  let deps: CleaningDeps;
  const ids = new UuidV7Generator();
  const clock: Clock = { now: () => new Date('2030-01-01T08:00:00+01:00') };
  const agents: string[] = [];
  const programs: { programId: string; placeId: string; sessionIds: string[] }[] = [];
  /** Équipe habituelle du programme 2, venue à sa séance réalisée de la semaine précédente. */
  let regular: string[] = [];

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_g_auto');
    pool = db.pool;
    prisma = db.prisma;
    await loadDemo(pool);
    await pool.query("UPDATE cleaning_settings SET default_planning_mode = 'automatic' WHERE id = 1");
    for (let i = 0; i < 10; i += 1) {
      agents.push(
        await seedAgent(pool, {
          name: `Agent ${i}`,
          canLead: i % 2 === 0,
          rating: 3 + (i % 3),
          // Un membre de l'équipe habituelle du programme 2 est en congé le mercredi 9.
          leaves: i === 3 ? [{ start: at(DAYS[2]!, '00:00'), end: at(DAYS[2]!, '23:59') }] : [],
        }),
      );
    }
    for (const program of PROGRAMS) {
      const seeded = await seedProgram(pool, {
        teamSize: program.size,
        sessions: DAYS.map((day) => ({ start: at(day, program.from), end: at(day, program.to) })),
      });
      programs.push(seeded);
    }
    // Séance réalisée du programme 2 la semaine précédente, faite par les agents 0 et 3 (les moins
    // bien notés : sans la continuité, d'autres seraient choisis).
    regular = [agents[0]!, agents[3]!];
    const done = await seedSession(pool, {
      programId: programs[1]!.programId,
      rank: 11,
      start: at('2030-01-04', '08:00'),
      end: at('2030-01-04', '11:00'),
      status: 'completed',
    });
    for (const agentId of regular) {
      await seedAssignment(pool, {
        sessionId: done,
        agentId,
        start: at('2030-01-04', '08:00'),
        end: at('2030-01-04', '11:00'),
        isLead: agentId === agents[0],
      });
    }
    deps = {
      planning: new PrismaPlanningRepository(prisma, clock, ids),
      autoPlanning: new PrismaAutoPlanningRepository(prisma, clock, ids),
      travel: { matrix: async () => travelFromMatrix({}) },
      clock,
      ids,
      people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
    } as unknown as CleaningDeps;
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const run = (input: { zoneKey?: string; programId?: string; to?: string } = {}) =>
    asStaffWith(PLANNER, () =>
      new RunAutoPlanningUseCase(deps).execute({
        idempotencyKey: `passage-${ids.next()}`,
        from: at(DAYS[0]!, '00:00'),
        to: at('2030-01-19', '00:00'),
        ...input,
      }),
    );

  it('50 séances, 10 agents : toutes affectées, sans conflit, même équipe quand elle est libre', async () => {
    const sessionIds = programs.flatMap((p) => p.sessionIds);
    expect(sessionIds).toHaveLength(50);
    expect(agents).toHaveLength(10);

    const report = await run();
    expect(report).toMatchObject({ mode: 'automatic', failures: [] });
    expect(await prisma.session.count({ where: { id: { in: sessionIds }, status: 'assigned' } })).toBe(50);

    const rows = await prisma.assignment.findMany({
      where: { sessionId: { in: sessionIds }, status: 'confirmed' },
      include: { session: { include: { program: true } } },
    });
    expect(report.assigned).toBe(rows.length);
    // Taille d'équipe respectée, un chef apte pour une équipe de plusieurs agents.
    for (const program of programs) {
      for (const sessionId of program.sessionIds) {
        const team = rows.filter((r) => r.sessionId === sessionId);
        expect(team).toHaveLength(team[0]!.session!.program.teamSize);
        expect(team.filter((r) => r.isLead)).toHaveLength(team.length > 1 ? 1 : 0);
        expect(team.every((r) => r.source === 'auto' && r.createdBy === null)).toBe(true);
      }
    }

    // Aucun conflit, trajet compris (oracle indépendant des contrôles).
    const byAgent = new Map<string, typeof rows>();
    for (const row of rows) byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
    for (const list of byAgent.values()) {
      const sorted = list.sort(
        (a, b) => a.session!.scheduledStart.getTime() - b.session!.scheduledStart.getTime(),
      );
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1]!.session!;
        const next = sorted[i]!.session!;
        const travel = prev.program.placeId === next.program.placeId ? 0 : DEFAULT_TRAVEL;
        expect(prev.scheduledEnd.getTime() + travel * MINUTE).toBeLessThanOrEqual(
          next.scheduledStart.getTime(),
        );
      }
    }

    // Même équipe d'une séance à l'autre quand elle est libre.
    const teamOf = (sessionId: string) =>
      rows
        .filter((r) => r.sessionId === sessionId)
        .map((r) => r.agentId)
        .sort();
    for (const [index, program] of programs.entries()) {
      const reference = index === 1 ? [...regular].sort() : teamOf(program.sessionIds[0]!);
      program.sessionIds.forEach((sessionId, day) => {
        if (index === 1 && day === 2) return;
        expect([index, day, teamOf(sessionId)]).toEqual([index, day, reference]);
      });
    }
    // Le membre en congé est remplacé ce jour-là seulement ; l'équipe habituelle revient le lendemain.
    expect(teamOf(programs[1]!.sessionIds[2]!)).toContain(agents[0]);
    expect(teamOf(programs[1]!.sessionIds[2]!)).not.toContain(agents[3]);

    // Événements : un récapitulatif par programme, et les traces du passage.
    expect(await prisma.outboxEvent.count({ where: { eventType: 'cleaning.sessions.batch_assigned' } })).toBe(
      5,
    );
    expect(await prisma.auditEntry.count({ where: { action: 'planning.auto_run' } })).toBe(1);

    // Un second passage ne déplace rien (R-PL-07).
    const again = await run();
    expect(again).toMatchObject({ assigned: 0, proposed: 0, failures: [] });
  }, 120_000);

  it('mode proposition : propositions listées, validées en un clic ; la séance devient planifiée', async () => {
    await pool.query("UPDATE cleaning_settings SET default_planning_mode = 'proposal' WHERE id = 1");
    const program = await seedProgram(pool, {
      sessions: [{ start: at('2030-01-21', '08:00'), end: at('2030-01-21', '10:00') }],
    });
    const report = await run({ programId: program.programId, to: at('2030-02-01', '00:00') });
    expect(report).toMatchObject({ mode: 'proposal', proposed: 1, assigned: 0 });
    const session = await prisma.session.findUniqueOrThrow({ where: { id: program.sessionIds[0]! } });
    expect(session.status).toBe('to_assign');

    const list = await asStaffWith(PLANNER, () => new ListProposalsUseCase(deps).execute({}));
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ status: 'proposed', source: 'auto', createdBy: null });

    const batch = await asStaffWith(PLANNER, () =>
      new ApproveProposalsUseCase(deps).execute({
        idempotencyKey: `validation-${ids.next()}`,
        assignmentIds: [list.items[0]!.id],
      }),
    );
    expect(batch.assignments).toMatchObject([{ status: 'confirmed', source: 'auto' }]);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('assigned');
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: list.items[0]!.id } });
    expect(row.approvedBy).not.toBeNull();

    // Déjà validée : ignorée, signalée.
    await expect(
      asStaffWith(PLANNER, () =>
        new ApproveProposalsUseCase(deps).execute({
          idempotencyKey: `validation-${ids.next()}`,
          assignmentIds: [list.items[0]!.id],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_INVALID_TRANSITION' });
  }, 60_000);

  it('permission cleaning.planning.manage exigée ; programme inconnu', async () => {
    await expect(
      asStaffWith([], () =>
        new RunAutoPlanningUseCase(deps).execute({ idempotencyKey: 'passage-sans-droit' }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    await expect(run({ programId: ids.next() })).rejects.toMatchObject({
      code: 'CLEANING_PROGRAM_NOT_FOUND',
    });
  }, 60_000);

  it('passage régulier : deux répliques en même temps, un seul passage', async () => {
    await pool.query(
      "UPDATE cleaning_settings SET default_planning_mode = 'automatic', planning_horizon_days = 60 WHERE id = 1",
    );
    const program = await seedProgram(pool, {
      sessions: [{ start: at('2030-01-22', '08:00'), end: at('2030-01-22', '10:00') }],
    });
    const runs = await Promise.all([
      new ScheduledAutoPlanningUseCase(deps).execute(),
      new ScheduledAutoPlanningUseCase(deps).execute(),
    ]);
    // L'une affecte la séance ; l'autre trouve le verrou tenu (null) ou passe après, sans rien à faire.
    expect(runs.filter((r) => r !== null && r.assigned > 0)).toMatchObject([
      { assigned: 1, mode: 'automatic' },
    ]);
    expect(runs.filter((r) => r === null || r.assigned === 0)).toHaveLength(1);
    expect(await prisma.assignment.count({ where: { sessionId: program.sessionIds[0]! } })).toBe(1);
    expect(
      await prisma.auditEntry.count({ where: { action: 'planning.auto_run', actorId: 'system' } }),
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
