import { requirePermission } from '@ksp/platform';
import { type AutoPlanningResult, runAutoPlanning } from '../../domain/auto-planning/auto-planning';
import { type AutoTarget, planningWindow, runMode, type ZoneModes } from '../../domain/auto-planning/modes';
import { autoPlanningReport } from '../../domain/auto-planning/report';
import { type AutoAgent } from '../../domain/auto-planning/team-choice';
import { type AgendaEntry, type TargetRef } from '../../domain/planning/agenda';
import { type AgentRecord } from '../agents/agent.ports';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type OutboxMessage } from '../ports';
import { requireStaff } from '../shared/access';
import { replayed, writeError } from '../shared/idempotency';
import { idempotencyKey, optionalInstant, requestHash } from '../shared/input';
import { lotGErrors } from '../shared/lot-g.errors';
import {
  agendaWindow,
  audit,
  planningAgent,
  planningContext,
  planningRefusal,
  placesOf,
} from '../planning/assignment-support';
import { announceAssignments } from '../planning/assignment.use-cases';
import { type NewAssignment, type TargetRecord } from '../planning/planning.ports';
import { type AutoPlanningReader, type AutoPlanningTx, type SessionScope } from './auto-planning.ports';

/**
 * Planification automatique (UC-NT-38, UC-NT-45 ; 9.5, R-PL-01 à R-PL-07). Un passage relit sous le
 * verrou de l'agenda des agents actifs (RV-75) les séances « à affecter » de la période, leurs
 * agents et l'historique des programmes, puis écrit propositions ou affectations dans la même
 * transaction que les événements et les traces. Les contrôles sont ceux de la planification
 * manuelle : l'automatique ne force jamais (R-PL-02).
 */

/** Permission des routes de la planification (contrat PlanningAdminService). */
export const PLANNING_PERMISSION = 'cleaning.planning.manage';

/** Acteur des traces d'une tâche automatique (RV-12). */
export const SYSTEM_ACTOR = 'system';

/** Passage rendu (AutoPlanningRun), rejouable à l'identique. */
export interface AutoPlanningRunView {
  id: string;
  mode: 'proposal' | 'automatic';
  from: string;
  to: string;
  assigned: number;
  proposed: number;
  failures: { target: TargetRef; reason: string }[];
  startedAt: string;
}

export interface RunAutoPlanningInput {
  idempotencyKey: string;
  from?: string | null | undefined;
  to?: string | null | undefined;
  zoneKey?: string | null | undefined;
  programId?: string | null | undefined;
}

/** Agent tel que l'automatique le classe : contrôles de 9.4, aptitude de chef et note moyenne. */
export function autoAgent(agent: AgentRecord, agenda: readonly AgendaEntry[]): AutoAgent {
  return {
    ...planningAgent(agent, agenda),
    canLead: agent.canLead,
    ratingAverage: agent.ratingCount > 0 ? agent.ratingSum / agent.ratingCount : null,
  };
}

function autoTarget(record: TargetRecord): AutoTarget {
  return { ...record, programId: record.programId ?? '' };
}

/** Séances et agents actifs d'un passage, avec l'agenda lu autour des séances. */
async function loadPass(
  reader: AutoPlanningReader,
  scope: SessionScope,
): Promise<{ targets: TargetRecord[]; agents: AutoAgent[] }> {
  const [targets, agents] = await Promise.all([reader.sessionsToAssign(scope), reader.activeAgents()]);
  if (!targets.length) return { targets, agents: [] };
  const agendas = await reader.agendas(
    agents.map((a) => a.id),
    agendaWindow(targets),
  );
  return { targets, agents: agents.map((agent) => autoAgent(agent, agendas.get(agent.id) ?? [])) };
}

/** Lignes à écrire : une affectation « auto » par agent retenu, sans auteur (created_by null). */
function autoRows(deps: Pick<CleaningDeps, 'ids'>, result: AutoPlanningResult, now: Date): NewAssignment[] {
  return result.proposals.flatMap((proposal) =>
    proposal.assignments.map((assignment) => ({
      id: deps.ids.next(),
      target: proposal.target,
      agentId: assignment.agentId,
      isLead: assignment.isLead,
      source: 'auto' as const,
      status: assignment.status,
      respondBefore: assignment.respondBefore,
      occupiedFrom: assignment.occupied.start,
      occupiedUntil: assignment.occupied.end,
      travelMinutes: assignment.travelMinutes,
      overrides: [],
      reason: null,
      createdBy: null,
      createdAt: now,
    })),
  );
}

export interface PassRequest {
  scope: SessionScope;
  now: Date;
  /** Compte du superviseur ; null pour le passage régulier (acteur `system`). */
  actorId: string | null;
  /** Passage régulier : verrou consultatif, rien n'est fait si une autre réplique le tient. */
  exclusive: boolean;
  /** Réponse à garder dans la transaction (requête idempotente). */
  remember?: (tx: AutoPlanningTx, view: AutoPlanningRunView) => Promise<void>;
}

/**
 * Passage complet : lecture hors transaction pour la matrice des trajets, puis tout est relu et
 * décidé sous le verrou des agents actifs. Rend null si le verrou consultatif est déjà tenu.
 */
export async function runPass(
  deps: Pick<CleaningDeps, 'autoPlanning' | 'travel' | 'ids'>,
  request: PassRequest,
): Promise<AutoPlanningRunView | null> {
  const { scope, now } = request;
  const repository = deps.autoPlanning;
  const before = await loadPass(repository, scope);
  const travel = await deps.travel.matrix(placesOf(before.targets, before.agents));
  const lockIds = (await repository.activeAgents()).map((a) => a.id);
  const runId = deps.ids.next();
  const actor = request.actorId ?? SYSTEM_ACTOR;
  try {
    return await repository.transaction(async (tx) => {
      if (request.exclusive && !(await tx.tryRunLock())) return null;
      await tx.lockAgents(lockIds);
      const locked = new Set(lockIds);
      const pass = await loadPass(tx, scope);
      const settings = await tx.autoPlanningSettings();
      const modes: ZoneModes = { defaultMode: settings.defaultMode, byZone: await tx.zoneModes() };
      const histories = await tx.programHistories([
        ...new Set(pass.targets.flatMap((t) => (t.programId ? [t.programId] : []))),
      ]);
      const result = runAutoPlanning({
        targets: pass.targets.map(autoTarget),
        // Un agent activé après la première lecture n'est pas verrouillé : il attend le passage suivant.
        agents: pass.agents.filter((a) => locked.has(a.agentId)),
        programHistory: Object.fromEntries(histories),
        scope: { window: scope.window, zoneKey: scope.zoneKey, programId: scope.programId },
        modes,
        weights: settings.weights,
        context: await planningContext(tx, travel, now),
      });
      const report = autoPlanningReport(result, scope.window, now);
      const rows = autoRows(deps, result, now);
      if (rows.length) await tx.insertAssignments(rows);
      const automatic = new Set(
        result.proposals.filter((p) => p.mode === 'automatic').map((p) => `${p.target.kind}:${p.target.id}`),
      );
      const applied = rows.filter((row) => automatic.has(`${row.target.kind}:${row.target.id}`));
      const events: OutboxMessage[] = applied.length
        ? (await announceAssignments(deps, tx, applied, now)).events
        : [];
      const view: AutoPlanningRunView = {
        id: runId,
        mode: runMode(
          [...result.proposals, ...result.failures].map((p) => p.mode),
          modes,
          scope.zoneKey,
        ),
        from: report.from.toISOString(),
        to: report.to.toISOString(),
        assigned: report.assigned,
        proposed: report.proposed,
        failures: report.failures.map((f) => ({ target: f.target, reason: f.reason })),
        startedAt: report.startedAt.toISOString(),
      };
      const traces: AuditEntry[] = [
        ...rows.map((row) =>
          audit(actor, 'assignment.created', 'assignment', row.id, now, {
            target: row.target,
            agentId: row.agentId,
            status: row.status,
            isLead: row.isLead,
            source: 'auto',
          }),
        ),
        audit(actor, 'planning.auto_run', 'auto_planning_run', runId, now, {
          mode: view.mode,
          from: view.from,
          to: view.to,
          assigned: view.assigned,
          proposed: view.proposed,
          failures: view.failures.length,
          supervisorAlert: report.supervisorAlert,
        }),
      ];
      await tx.write({ events, audit: traces });
      if (request.remember) await request.remember(tx, view);
      return view;
    });
  } catch (error) {
    throw writeError(error, lockIds);
  }
}

/** Période et filtres d'un passage demandé (RunAutoPlanning) ou régulier. */
export async function passScope(
  reader: AutoPlanningReader,
  input: { from: Date | null; to: Date | null; zoneKey: string | null; programId: string | null; now: Date },
): Promise<SessionScope> {
  const settings = await reader.autoPlanningSettings();
  const window = planningWindow({
    now: input.now,
    from: input.from,
    to: input.to,
    horizonDays: settings.horizonDays,
  });
  if (!window.ok) throw planningRefusal(window.errors);
  return { window: window.value, zoneKey: input.zoneKey, programId: input.programId };
}

/** Lancer un passage depuis le back-office (bouton « Planifier automatiquement »). */
export class RunAutoPlanningUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: RunAutoPlanningInput): Promise<AutoPlanningRunView> {
    const actorId = requireStaff();
    const zoneKey = input.zoneKey || null;
    requirePermission(PLANNING_PERMISSION, zoneKey ?? undefined);
    const key = idempotencyKey(input.idempotencyKey);
    const from = optionalInstant(input.from, 'from');
    const to = optionalInstant(input.to, 'to');
    const programId = input.programId || null;
    const hash = requestHash({ from, to, zoneKey, programId });
    const ref = { actorId, operation: 'planning.auto_run', key };
    const replay = await replayed<AutoPlanningRunView>(this.deps.autoPlanning, ref, hash);
    if (replay) return replay;
    if (programId && !(await this.deps.autoPlanning.programExists(programId))) {
      throw lotGErrors.programNotFound();
    }
    const now = this.deps.clock.now();
    const scope = await passScope(this.deps.autoPlanning, { from, to, zoneKey, programId, now });
    const view = await runPass(this.deps, {
      scope,
      now,
      actorId,
      exclusive: false,
      remember: (tx, response) => tx.remember({ ...ref, requestHash: hash, response }),
    });
    return view!;
  }
}

/**
 * Passage régulier (UC-NT-45, R-PL-01 « chaque nuit », horizon glissant des réglages) : acteur
 * `system`, verrou consultatif contre un passage simultané d'une autre réplique. Rend null quand
 * l'autre réplique tient le verrou.
 */
export class ScheduledAutoPlanningUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<AutoPlanningRunView | null> {
    const now = this.deps.clock.now();
    const scope = await passScope(this.deps.autoPlanning, {
      from: null,
      to: null,
      zoneKey: null,
      programId: null,
      now,
    });
    return runPass(this.deps, { scope, now, actorId: null, exclusive: true });
  }
}

/**
 * Déclencheur « acceptation d'un devis » (R-PL-01), à appeler après la création du programme, hors
 * de sa transaction : seules les séances de l'horizon des réglages (14 jours par défaut) sont
 * planifiées ; les suivantes le sont par les passages réguliers (décision du responsable).
 */
export async function planNewProgram(
  deps: CleaningDeps,
  programId: string,
): Promise<AutoPlanningRunView | null> {
  const now = deps.clock.now();
  const scope = await passScope(deps.autoPlanning, { from: null, to: null, zoneKey: null, programId, now });
  return runPass(deps, { scope, now, actorId: null, exclusive: false });
}
