import { type AgentSkillStatus, type AgentStatus } from '../../domain/agents/agent';
import { type EmploymentKind } from '../../domain/planning/assignment-status';
import {
  type DeclaredUnavailability,
  type ExtraAvailability,
  type WeeklyRange,
} from '../../domain/planning/availability';

/**
 * Agents, disponibilités et équipes (partie 9.1 à 9.3) tels que les cas d'usage les lisent et les
 * écrivent. Les données personnelles (pièce d'identité, personne à prévenir, Mobile Money) restent
 * chiffrées dans l'enregistrement ; seul le cas d'usage qui les rend les déchiffre (FieldCipher).
 */

export interface UnavailabilityRecord extends DeclaredUnavailability {
  note: string | null;
  forced: boolean;
  createdBy: string;
  createdAt: Date;
}

export interface AgentSkillRecord {
  code: string;
  name: string;
  status: AgentSkillStatus;
}

export interface AgentRecord {
  id: string;
  userId: string;
  status: AgentStatus;
  employmentKind: EmploymentKind;
  /** « Prénom Nom » recopié pour le planning (nom et prénom restent dans identity). */
  displayName: string;
  photoFileId: string | null;
  homeCommuneKey: string;
  idDocumentEncrypted: string | null;
  emergencyContactEncrypted: string | null;
  mobileMoneyEncrypted: string | null;
  maxHoursDay: number;
  maxHoursWeek: number;
  canLead: boolean;
  ratingSum: number;
  ratingCount: number;
  statusReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  skills: AgentSkillRecord[];
  zoneKeys: string[];
  weekly: WeeklyRange[];
  extras: ExtraAvailability[];
  /** À venir et en cours. */
  unavailabilities: UnavailabilityRecord[];
}

/** Activité d'un agent (R-AG-04), sans montants. */
export interface AgentStatsRecord {
  sessionsCompleted: number;
  visitsCompleted: number;
  /** Heures réalisées dans la semaine et le mois en cours (heure de Porto-Novo). */
  hoursThisWeek: number;
  hoursThisMonth: number;
  openClaims: number;
}

export type AgentSort = 'lastName' | '-createdAt' | '-ratingAverage';

export interface AgentFilter {
  status: AgentStatus | null;
  zoneKey: string | null;
  /** Compétence validée. */
  skillCode: string | null;
  /** Nom (affiché) ; le téléphone reste dans identity. */
  q: string | null;
  sort: AgentSort;
}

export interface NewAgent {
  id: string;
  userId: string;
  status: AgentStatus;
  employmentKind: EmploymentKind;
  displayName: string;
  photoFileId: string | null;
  homeCommuneKey: string;
  idDocumentEncrypted: string | null;
  emergencyContactEncrypted: string | null;
  mobileMoneyEncrypted: string | null;
  maxHoursDay: number;
  maxHoursWeek: number;
  createdBy: string | null;
  createdAt: Date;
}

/** Champs modifiables ; absents : inchangés. */
export interface AgentPatch {
  status?: AgentStatus;
  statusReason?: string | null;
  reviewedBy?: string;
  reviewedAt?: Date;
  employmentKind?: EmploymentKind;
  homeCommuneKey?: string;
  emergencyContactEncrypted?: string | null;
  maxHoursDay?: number;
  maxHoursWeek?: number;
  updatedAt: Date;
}

export interface TeamMemberRecord {
  agentId: string;
  displayName: string;
  status: AgentStatus;
}

export interface TeamRecord {
  id: string;
  name: string;
  leadAgentId: string;
  active: boolean;
  createdAt: Date;
  members: TeamMemberRecord[];
}

export interface TeamPatch {
  name?: string;
  leadAgentId?: string;
  active?: boolean;
  updatedAt: Date;
}

/** Réglages de la planification (partie 16.1). */
export interface PlanningSettings {
  defaultTravelMinutes: number;
  assignmentResponseHours: number;
  defaultMaxHoursDay: number;
  defaultMaxHoursWeek: number;
}

/** Le compte a déjà un profil d'agent (index unique agents.user_id). */
export class AgentAlreadyRegisteredError extends Error {
  override readonly name = 'AgentAlreadyRegisteredError';
}

/** Version attendue dépassée : un autre appel a modifié l'enregistrement entre-temps. */
export class ConcurrentUpdateError extends Error {
  override readonly name = 'ConcurrentUpdateError';
}
