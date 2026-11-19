import { type AgentStatus } from '../agents/agent';
import {
  type AgendaEntry,
  type ScheduleConflict,
  scheduleConflicts,
  type TargetRef,
  type TravelTime,
} from './agenda';
import { type AssignmentStatus, type EmploymentKind, initialAssignmentStatus } from './assignment-status';
import {
  type DeclaredUnavailability,
  type ExtraAvailability,
  fitsAvailability,
  type LoadExcess,
  loadExcesses,
  overlappingUnavailabilities,
  type WeeklyRange,
} from './availability';
import { type PlanningError, type PlanningErrorCode, planningError } from './errors';
import { type Period } from './time';

/**
 * Contrôles d'une affectation (9.4), communs à la planification manuelle et automatique. Chaque
 * contrôle est évalué et rendu, même quand un autre a déjà échoué : le superviseur voit tous les
 * motifs de refus d'un coup, avec les codes du contrat.
 */
export type CheckName =
  'active' | 'skills' | 'zone' | 'availability' | 'unavailability' | 'conflict' | 'load' | 'team_size';

/** Ordre des contrôles, celui du contrat (CheckResult.check). */
export const CHECK_ORDER: readonly CheckName[] = [
  'active',
  'skills',
  'zone',
  'availability',
  'unavailability',
  'conflict',
  'load',
  'team_size',
];

/** Seuls contrôles contournables, par le superviseur et avec motif (9.4, CheckOverride.check). */
export const OVERRIDABLE_CHECKS = ['zone', 'availability', 'load', 'team_size'] as const;
export type OverridableCheck = (typeof OVERRIDABLE_CHECKS)[number];

const CHECK_CODES: Readonly<Record<CheckName, PlanningErrorCode>> = {
  active: 'CLEANING_AGENT_NOT_ACTIVE',
  skills: 'CLEANING_SKILL_MISSING',
  zone: 'CLEANING_AGENT_OUT_OF_ZONE',
  availability: 'CLEANING_AGENT_UNAVAILABLE',
  unavailability: 'CLEANING_AGENT_ON_LEAVE',
  conflict: 'CLEANING_SCHEDULE_CONFLICT',
  load: 'CLEANING_AGENT_OVERLOADED',
  team_size: 'CLEANING_TEAM_SIZE_MISMATCH',
};

export interface CheckOverride {
  check: OverridableCheck;
  reason: string;
}

/** Agent tel que la planification le voit. */
export interface PlanningAgent {
  agentId: string;
  status: AgentStatus;
  employmentKind: EmploymentKind;
  /** Compétences validées seulement (R-AG-01, validatedSkillCodes). */
  validatedSkills: readonly string[];
  /** Communes de travail. */
  zoneKeys: readonly string[];
  weekly: readonly WeeklyRange[];
  extras: readonly ExtraAvailability[];
  unavailabilities: readonly DeclaredUnavailability[];
  maxHoursPerDay: number;
  maxHoursPerWeek: number;
  /** Affectations de l'agent (les retirées, refusées et expirées sont ignorées). */
  agenda: readonly AgendaEntry[];
}

/** Agent déjà affecté à la cible (affectation en vigueur). */
export interface AssignedAgent {
  agentId: string;
  validatedSkills: readonly string[];
  isLead: boolean;
}

/** Visite ou séance à affecter. */
export interface PlanningTarget {
  target: TargetRef;
  /** Statut de la séance ou de la visite (15.2). */
  status: string;
  placeId: string;
  /** Commune du lieu. */
  communeKey: string;
  start: Date;
  end: Date;
  /** Compétences exigées par les types de la séance (R-CA-09). */
  requiredSkills: readonly string[];
  /** Nombre d'agents prévu au devis ; null pour une visite. */
  expectedTeamSize: number | null;
  assignedAgents: readonly AssignedAgent[];
}

export interface PlanningContext {
  now: Date;
  travel: TravelTime;
  /** Temps de trajet si le calcul est indisponible (réglage, 30 min par défaut, R-ZN-02). */
  defaultTravelMinutes: number;
  /** Délai de réponse d'un indépendant (réglage, 12 h par défaut, R-PL-08). */
  assignmentResponseHours: number;
}

export interface CheckResult {
  check: CheckName;
  passed: boolean;
  overridable: boolean;
  /** Contrôle en échec, contourné avec motif. */
  overridden: boolean;
  missingSkills: string[];
  conflicts: ScheduleConflict[];
  unavailabilities: DeclaredUnavailability[];
  loadExcesses: LoadExcess[];
}

/** Contrôles d'un agent pour une cible, et ce qu'il faut écrire s'il est retenu. */
export interface AgentCheck {
  agentId: string;
  target: TargetRef;
  /** Tous les contrôles passent ou sont contournés. */
  passed: boolean;
  results: CheckResult[];
  /** Trajet compté avant la cible et période occupée (assignments.travel_minutes, occupied_*). */
  travelMinutes: number;
  occupied: Period;
  /** Contrôles effectivement contournés pour cet agent (assignments.overrides). */
  overridesUsed: OverridableCheck[];
  /** Statut de l'affectation à créer (R-PL-08). */
  status: AssignmentStatus;
  respondBefore: Date | null;
}

export type AssignmentWarning = 'team_size_short' | 'team_lead_missing';

export interface TargetCheck {
  target: TargetRef;
  passed: boolean;
  /** Tous les motifs de refus ; vide si la cible est acceptée. */
  errors: PlanningError[];
  warnings: AssignmentWarning[];
  /** Agents retenus pour la cible, dans l'ordre demandé. */
  agentIds: string[];
  /** Chef d'équipe à marquer parmi les agents retenus ; null s'il n'y en a pas à créer. */
  leadAgentId: string | null;
  agentChecks: AgentCheck[];
  /** Membres d'une équipe écartés (R-EQ-02), avec leurs contrôles. */
  signaled: AgentCheck[];
}

function result(
  check: CheckName,
  passed: boolean,
  overrides: ReadonlySet<CheckName>,
  extra: Partial<CheckResult> = {},
): CheckResult {
  const overridable = (OVERRIDABLE_CHECKS as readonly CheckName[]).includes(check);
  return {
    check,
    passed,
    overridable,
    overridden: !passed && overridable && overrides.has(check),
    missingSkills: [],
    conflicts: [],
    unavailabilities: [],
    loadExcesses: [],
    ...extra,
  };
}

const settled = (r: CheckResult) => r.passed || r.overridden;

/**
 * Période contrôlée contre les indisponibilités déclarées : la période occupée, trajet compris.
 * Interprétation prudente : l'agent en congé ne peut pas non plus se mettre en route.
 */
export function unavailabilityWindow(occupied: Period): Period {
  return occupied;
}

/** Statuts depuis lesquels une cible reçoit des agents ; cible et statut d'arrivée (15.2). */
const ASSIGNABLE: Readonly<Record<TargetRef['kind'], { from: readonly string[]; to: string }>> = {
  session: { from: ['to_assign', 'assigned'], to: 'assigned' },
  visit: { from: ['scheduled'], to: 'scheduled' },
};

/**
 * Cible affectable : séance à affecter ou déjà planifiée, visite planifiée ; jamais une cible dont
 * le début est passé (R-PL-10). Interprétation prudente : un début égal à maintenant est passé.
 */
export function targetPreconditions(target: PlanningTarget, now: Date): PlanningError[] {
  const { from, to } = ASSIGNABLE[target.target.kind];
  const errors: PlanningError[] = [];
  if (target.target.kind === 'session' && target.status === 'suspended') {
    errors.push(planningError('CLEANING_PROGRAM_SUSPENDED'));
  } else if (!from.includes(target.status)) {
    errors.push(planningError('CLEANING_INVALID_TRANSITION', { from: target.status, to }));
  }
  if (target.start <= now) {
    errors.push(
      planningError('CLEANING_INVALID_TRANSITION', { from: target.status, to, reason: 'target_in_past' }),
    );
  }
  return errors;
}

function individualCheck(
  agent: PlanningAgent,
  target: PlanningTarget,
  overrides: ReadonlySet<CheckName>,
  context: PlanningContext,
): Omit<AgentCheck, 'passed' | 'overridesUsed'> {
  const period = { start: target.start, end: target.end };
  const agenda = agent.agenda.filter(
    (entry) => !(entry.target.kind === target.target.kind && entry.target.id === target.target.id),
  );
  const schedule = scheduleConflicts(
    { target: target.target, placeId: target.placeId, start: target.start, end: target.end },
    agenda,
    context.travel,
    context.defaultTravelMinutes,
    context.now,
  );
  const leave = overlappingUnavailabilities(unavailabilityWindow(schedule.occupied), agent.unavailabilities);
  const load = loadExcesses(period, agenda, agent, context.now);
  return {
    agentId: agent.agentId,
    target: target.target,
    results: [
      result('active', agent.status === 'active', overrides),
      result('zone', agent.zoneKeys.includes(target.communeKey), overrides),
      result('availability', fitsAvailability(period, agent.weekly, agent.extras), overrides),
      result('unavailability', leave.length === 0, overrides, { unavailabilities: leave }),
      result('conflict', schedule.conflicts.length === 0, overrides, { conflicts: schedule.conflicts }),
      result('load', load.length === 0, overrides, { loadExcesses: load }),
    ],
    travelMinutes: schedule.travelMinutes,
    occupied: schedule.occupied,
    ...initialAssignmentStatus(agent.employmentKind, context.now, context.assignmentResponseHours),
  };
}

function finish(check: Omit<AgentCheck, 'passed' | 'overridesUsed'>): AgentCheck {
  const results = [...check.results].sort(
    (a, b) => CHECK_ORDER.indexOf(a.check) - CHECK_ORDER.indexOf(b.check),
  );
  return {
    ...check,
    results,
    passed: results.every(settled),
    overridesUsed: results.filter((r) => r.overridden).map((r) => r.check as OverridableCheck),
  };
}

/**
 * Contrôle d'une cible pour des agents désignés (mode « agents ») ou les membres d'une équipe
 * (mode « team », R-EQ-02 : seuls les membres qui passent leurs contrôles individuels sont retenus,
 * les autres sont signalés). Compétences et taille d'équipe se jugent sur l'équipe réunie : agents
 * déjà affectés et agents retenus.
 */
export function checkTarget(input: {
  target: PlanningTarget;
  agents: readonly PlanningAgent[];
  mode: 'agents' | 'team';
  /** Chef de l'équipe (mode « team »). */
  teamLeadId: string | null;
  /** Chef d'équipe demandé (obligatoire au-delà d'un agent, R-EQ-03). */
  leadAgentId: string | null;
  overrides: readonly CheckOverride[];
  context: PlanningContext;
}): TargetCheck {
  const { target, context } = input;
  const errors = targetPreconditions(target, context.now);
  const overrides = new Set<CheckName>(input.overrides.filter((o) => o.reason.trim()).map((o) => o.check));
  const assignedIds = new Set(target.assignedAgents.map((a) => a.agentId));
  const unique = input.agents.filter((a, i) => input.agents.findIndex((b) => b.agentId === a.agentId) === i);
  if (input.mode === 'agents' && unique.some((a) => assignedIds.has(a.agentId))) {
    errors.push(planningError('CLEANING_VALIDATION_FAILED', { field: 'agentIds', reason: 'duplicate' }));
  }
  const candidates = unique
    .filter((a) => input.mode === 'agents' || !assignedIds.has(a.agentId))
    .map((agent) => ({ agent, check: individualCheck(agent, target, overrides, context) }));
  const kept =
    input.mode === 'agents' ? candidates : candidates.filter((c) => c.check.results.every(settled));
  const signaled = candidates.filter((c) => !kept.includes(c)).map((c) => finish(c.check));
  if (!kept.length) {
    errors.push(planningError('CLEANING_VALIDATION_FAILED', { field: 'agentIds', reason: 'required' }));
  }

  const team = [...target.assignedAgents, ...kept.map((c) => c.agent)];
  const covered = new Set(team.flatMap((member) => member.validatedSkills));
  const missingSkills = target.requiredSkills.filter((skill) => !covered.has(skill));
  const teamSize = assignedIds.size + kept.length;
  const sizeMatches = target.expectedTeamSize === null || teamSize === target.expectedTeamSize;
  const agentChecks = kept.map((c) =>
    finish({
      ...c.check,
      results: [
        ...c.check.results,
        result('skills', missingSkills.length === 0, overrides, { missingSkills }),
        result('team_size', sizeMatches, overrides),
      ],
    }),
  );

  const warnings: AssignmentWarning[] = [];
  const lead = chooseLead(
    input,
    kept.map((c) => c.agent.agentId),
    teamSize,
    errors,
    warnings,
  );
  for (const check of CHECK_ORDER) {
    const failing = agentChecks.filter((a) => a.results.some((r) => r.check === check && !settled(r)));
    if (!failing.length) continue;
    const details: Record<string, unknown> = { checks: failing };
    if (check === 'team_size') details.expected = target.expectedTeamSize;
    errors.push(planningError(CHECK_CODES[check], details));
  }
  if (!sizeMatches && overrides.has('team_size') && teamSize < (target.expectedTeamSize ?? 0)) {
    warnings.unshift('team_size_short');
  }
  return {
    target: target.target,
    passed: errors.length === 0,
    errors,
    warnings,
    agentIds: kept.map((c) => c.agent.agentId),
    leadAgentId: lead,
    agentChecks,
    signaled,
  };
}

/**
 * Chef d'équipe (R-EQ-03) :
 * - un chef déjà en place sur la cible suffit ; en désigner un second est refusé (comme l'index
 *   unique assignments_session_lead_idx) ;
 * - agents désignés : au-delà d'un agent, le chef demandé doit être l'un d'eux ;
 * - équipe : le chef demandé, sinon celui de l'équipe ; s'il est écarté, l'affectation passe avec
 *   l'alerte team_lead_missing (AssignmentBatch.warnings).
 */
function chooseLead(
  input: {
    target: PlanningTarget;
    mode: 'agents' | 'team';
    teamLeadId: string | null;
    leadAgentId: string | null;
  },
  keptIds: readonly string[],
  teamSize: number,
  errors: PlanningError[],
  warnings: AssignmentWarning[],
): string | null {
  const hasLead = input.target.assignedAgents.some((a) => a.isLead);
  if (input.mode === 'agents') {
    if (input.leadAgentId !== null && hasLead) {
      errors.push(planningError('CLEANING_VALIDATION_FAILED', { field: 'leadAgentId', reason: 'duplicate' }));
      return null;
    }
    if (input.leadAgentId !== null && keptIds.includes(input.leadAgentId)) return input.leadAgentId;
    if (input.leadAgentId !== null || (teamSize > 1 && !hasLead)) {
      errors.push(planningError('CLEANING_VALIDATION_FAILED', { field: 'leadAgentId', reason: 'required' }));
    }
    return null;
  }
  if (hasLead) return null;
  const wanted = input.leadAgentId ?? input.teamLeadId;
  if (wanted !== null && keptIds.includes(wanted)) return wanted;
  if (teamSize > 1) warnings.push('team_lead_missing');
  return null;
}
