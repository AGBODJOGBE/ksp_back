import { type AgendaEntry, type TargetRef, type TravelTime } from '../../domain/planning/agenda';
import { type OverridableCheck, type PlanningTarget } from '../../domain/planning/assignment-check';
import { type AssignmentStatus } from '../../domain/planning/assignment-status';
import { type Period } from '../../domain/planning/time';
import { type Page, type PageRequest } from '../shared/input';
import { type Changes } from '../ports';
import {
  type AgentFilter,
  type AgentPatch,
  type AgentRecord,
  type AgentStatsRecord,
  type NewAgent,
  type PlanningSettings,
  type TeamPatch,
  type TeamRecord,
} from '../agents/agent.ports';

/**
 * Dépôt des agents et de la planification (partie 9). Les écritures passent par `transaction` :
 * l'adaptateur ouvre une transaction, et `lockAgents` y pose le verrou de l'agenda des agents
 * (lignes agents verrouillées dans l'ordre des identifiants, RV-75) avant toute lecture de leur
 * agenda. Une violation de la contrainte assignments_no_overlap remonte en ScheduleOverlapError.
 */

export type AssignmentSource = 'manual' | 'auto';

/** Affectation enregistrée, avec sa cible. */
export interface AssignmentRecord {
  id: string;
  target: TargetRef;
  agentId: string;
  isLead: boolean;
  source: AssignmentSource;
  status: AssignmentStatus;
  respondBefore: Date | null;
  overrides: OverridableCheck[];
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
  /** Début et fin de la cible. */
  start: Date;
  end: Date;
  /** Période occupée, trajet compris. */
  occupiedFrom: Date;
  travelMinutes: number;
  placeId: string;
}

/** Cible vue par la planification, avec ce que portent les événements et le planning. */
export interface TargetRecord extends PlanningTarget {
  /** Numéro du programme (séance) ou de la demande (visite). */
  number: string;
  rank: number | null;
  programId: string | null;
  requestId: string;
  /** Titulaire ou auteur de la demande. */
  customerId: string;
  organizationId: string | null;
  /** Nombre de séances du programme ; null pour une visite. */
  sessionsCount: number | null;
  communeName: string;
  placeTypeName: string;
  cleaningTypes: { id: string; code: string; name: string }[];
  /** Affectations en vigueur. */
  assignments: AssignmentRecord[];
}

export interface NewAssignment {
  id: string;
  target: TargetRef;
  agentId: string;
  isLead: boolean;
  source: AssignmentSource;
  status: AssignmentStatus;
  respondBefore: Date | null;
  occupiedFrom: Date;
  occupiedUntil: Date;
  travelMinutes: number;
  overrides: OverridableCheck[];
  reason: string | null;
  /** null pour la planification automatique (source auto). */
  createdBy: string | null;
  createdAt: Date;
}

export interface NewUnavailability {
  id: string;
  agentId: string;
  kind: 'unavailable';
  start: Date;
  end: Date;
  reason: 'leave' | 'sickness' | 'other';
  note: string | null;
  forced: boolean;
  createdBy: string;
  createdAt: Date;
}

export interface IdempotencyKeyRef {
  actorId: string;
  operation: string;
  key: string;
}

export interface IdempotencyRecord extends IdempotencyKeyRef {
  requestHash: string;
  /** Réponse rendue au premier appel (JSON). */
  response: unknown;
}

export interface PlanningFilter {
  window: Period;
  agentId: string | null;
  teamId: string | null;
  zoneKey: string | null;
  programId: string | null;
}

export interface AssignmentFilter {
  window: Period;
  status: AssignmentStatus | null;
}

/** Affectation d'un agent avec le statut de sa cible (mon planning). */
export interface AgentAssignmentRecord extends AssignmentRecord {
  targetStatus: string;
  placeTypeName: string;
  communeName: string;
}

/** Lectures communes au dépôt et à la transaction. */
export interface PlanningReader {
  agentById(id: string): Promise<AgentRecord | null>;
  agentByUserId(userId: string): Promise<AgentRecord | null>;
  agentsByIds(ids: readonly string[]): Promise<AgentRecord[]>;
  teamById(id: string): Promise<TeamRecord | null>;
  /**
   * Affectations des agents dont la période occupée touche la fenêtre (fin null : sans borne),
   * en vigueur ou non : le domaine lit leur statut effectif.
   */
  agendas(
    agentIds: readonly string[],
    window: { start: Date; end: Date | null },
  ): Promise<Map<string, AgendaEntry[]>>;
  /** Cibles trouvées, dans l'ordre demandé ; une cible inconnue est absente. */
  targets(refs: readonly TargetRef[]): Promise<TargetRecord[]>;
  assignment(id: string): Promise<AssignmentRecord | null>;
  settings(): Promise<PlanningSettings>;
}

export interface PlanningTx extends PlanningReader {
  /** Verrou de l'agenda : agents verrouillés dans l'ordre des identifiants (RV-75). */
  lockAgents(ids: readonly string[]): Promise<void>;
  insertAgent(agent: NewAgent): Promise<void>;
  /** Refuse (ConcurrentUpdateError) si la version a changé. */
  updateAgent(id: string, expectedVersion: number, patch: AgentPatch): Promise<void>;
  replaceSkills(
    agentId: string,
    skills: readonly { code: string; status: 'declared' | 'validated' | 'rejected' }[],
    by: string | null,
    at: Date,
  ): Promise<void>;
  replaceZones(agentId: string, zoneKeys: readonly string[]): Promise<void>;
  replaceWeekly(
    agentId: string,
    ranges: readonly { weekday: number; startMinute: number; endMinute: number }[],
    by: string,
    at: Date,
  ): Promise<void>;
  replaceExtras(
    agentId: string,
    extras: readonly { id: string; start: Date; end: Date }[],
    by: string,
    at: Date,
  ): Promise<void>;
  insertUnavailability(row: NewUnavailability): Promise<void>;
  /** Faux si l'indisponibilité n'existe pas pour cet agent. */
  deleteUnavailability(agentId: string, id: string): Promise<boolean>;
  insertTeam(
    team: { id: string; name: string; leadAgentId: string; createdAt: Date },
    memberIds: readonly string[],
  ): Promise<void>;
  updateTeam(id: string, patch: TeamPatch, memberIds: readonly string[] | null): Promise<void>;
  insertAssignments(rows: readonly NewAssignment[]): Promise<void>;
  /** Retrait (statut removed) ; removedBy null pour le système. */
  removeAssignments(
    ids: readonly string[],
    removal: { by: string | null; reason: string; at: Date },
  ): Promise<void>;
  respondAssignment(id: string, status: 'confirmed' | 'declined', at: Date): Promise<void>;
  /** Chef d'équipe d'une cible : retirer l'ancien avant de marquer le nouveau (index unique). */
  setLead(id: string, isLead: boolean): Promise<void>;
  setSessionStatus(sessionId: string, status: 'to_assign' | 'assigned', at: Date): Promise<void>;
  write(changes: Changes): Promise<void>;
  /** Réponse d'une requête idempotente, dans la transaction de l'action. */
  remember(record: IdempotencyRecord): Promise<void>;
}

export interface PlanningRepository extends PlanningReader {
  transaction<T>(work: (tx: PlanningTx) => Promise<T>): Promise<T>;
  idempotency(ref: IdempotencyKeyRef): Promise<{ requestHash: string; response: unknown } | null>;
  listAgents(filter: AgentFilter, page: PageRequest): Promise<Page<AgentRecord>>;
  agentStats(agentIds: readonly string[], now: Date): Promise<Map<string, AgentStatsRecord>>;
  listTeams(filter: { active: boolean | null }, page: PageRequest): Promise<Page<TeamRecord>>;
  /** Compétences inconnues ou désactivées parmi les codes. */
  missingSkills(codes: readonly string[]): Promise<string[]>;
  /** Zones inconnues ou désactivées parmi les clés. */
  missingZones(keys: readonly string[]): Promise<string[]>;
  agentAssignments(
    agentId: string,
    filter: AssignmentFilter,
    page: PageRequest,
  ): Promise<Page<AgentAssignmentRecord>>;
  /** Cibles de la période selon les filtres, dans l'ordre chronologique. */
  planning(filter: PlanningFilter): Promise<TargetRecord[]>;
  /** Visites planifiées sans agent et séances à affecter ou sans équipe complète, les plus proches d'abord. */
  unassigned(filter: { zoneKey: string | null; now: Date }, page: PageRequest): Promise<Page<TargetRecord>>;
}

/** Contrainte assignments_no_overlap violée : un autre appel a pris l'agent sur la période. */
export class ScheduleOverlapError extends Error {
  override readonly name = 'ScheduleOverlapError';
}

/**
 * Temps de trajet entre lieux (R-ZN-02), calculés par geo (DistanceMatrix, profil voiture) avant la
 * transaction. Un couple absent de la matrice vaut « calcul indisponible » : le domaine applique la
 * valeur par défaut des réglages. Jamais d'erreur.
 */
export interface TravelTimes {
  matrix(placeIds: readonly string[]): Promise<TravelTime>;
}
