import { type PlanningMode } from '../../domain/auto-planning/modes';
import { type ProgramHistory, type ScoreWeights } from '../../domain/auto-planning/score';
import { type AssignmentState } from '../../domain/planning/assignment-status';
import { type Period } from '../../domain/planning/time';
import { type AgentRecord } from '../agents/agent.ports';
import { type Page, type PageRequest } from '../shared/input';
import {
  type AssignmentRecord,
  type PlanningReader,
  type PlanningRepository,
  type PlanningTx,
  type TargetRecord,
} from '../planning/planning.ports';

/**
 * Dépôt de la planification automatique (lot G, 9.5). Il prolonge celui de la planification
 * manuelle : mêmes lectures, même verrou de l'agenda (RV-75), mêmes écritures d'affectations.
 */

/** Réglages lus par un passage (partie 16.1). */
export interface AutoPlanningSettings {
  defaultMode: PlanningMode;
  horizonDays: number;
  weights: ScoreWeights;
}

export interface SessionScope {
  /** Période semi-ouverte : une séance compte si son début y tombe. */
  window: Period;
  zoneKey: string | null;
  programId: string | null;
}

/** Proposition en attente de validation, avec le nom de l'agent. */
export interface ProposalRecord extends AssignmentRecord {
  agentName: string;
  communeKey: string;
}

/** Validation d'une proposition : statut de l'affectation enregistrée (R-PL-08) et agenda recalculé. */
export interface ProposalApprovalRow extends AssignmentState {
  id: string;
  occupiedFrom: Date;
  occupiedUntil: Date;
  travelMinutes: number;
  approvedBy: string;
  approvedAt: Date;
}

export interface AutoPlanningReader extends PlanningReader {
  autoPlanningSettings(): Promise<AutoPlanningSettings>;
  /** Mode de chaque zone (null : réglage général). */
  zoneModes(): Promise<Record<string, PlanningMode | null>>;
  programExists(id: string): Promise<boolean>;
  /** Séances « à affecter » dont le début tombe dans la période, dans l'ordre chronologique. */
  sessionsToAssign(scope: SessionScope): Promise<TargetRecord[]>;
  /** Agents actifs : les seuls candidats possibles (R-PL-02). */
  activeAgents(): Promise<AgentRecord[]>;
  /** Historique des programmes pour la continuité (R-PL-03) ; un programme sans historique est absent. */
  programHistories(programIds: readonly string[]): Promise<Map<string, ProgramHistory>>;
}

export interface AutoPlanningTx extends PlanningTx, AutoPlanningReader {
  /**
   * Verrou consultatif du passage régulier (pg_try_advisory_xact_lock) : faux si une autre réplique
   * le tient, sans attendre. Levé à la fin de la transaction.
   */
  tryRunLock(): Promise<boolean>;
  /** Faux si l'affectation n'est plus « proposed » (validée ou retirée entre-temps). */
  approveProposal(row: ProposalApprovalRow): Promise<boolean>;
}

export interface AutoPlanningRepository extends AutoPlanningReader, Pick<PlanningRepository, 'idempotency'> {
  transaction<T>(work: (tx: AutoPlanningTx) => Promise<T>): Promise<T>;
  /** Propositions en vigueur (statut « proposed »), les plus proches d'abord. */
  proposals(filter: { zoneKey: string | null }, page: PageRequest): Promise<Page<ProposalRecord>>;
}
