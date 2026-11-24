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
  /**
   * Attribution du rôle cleaning_agent chez identity (R-AG-01) : posée quand l'agent devient actif,
   * gardée pendant une suspension, effacée une fois le rôle retiré après la désactivation. Null :
   * l'agent n'a pas de rôle attribué par le service.
   */
  roleAssignmentId: string | null;
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
  /** Attribution du rôle cleaning_agent chez identity ; null : rôle retiré. */
  roleAssignmentId?: string | null;
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

// --- Piste A (agents) --------------------------------------------------------------------------

/**
 * Rôle cleaning_agent chez identity (GrantRole et RevokeRole, R-AG-01 ; ADR-057, décision 8) : la
 * seule attribution faite par un service, avec son jeton de service. Les deux appels sont
 * idempotents : attribuer rend l'attribution active du compte quand elle existe déjà ; retirer une
 * attribution déjà retirée, ou inconnue d'identity, est sans effet. identity injoignable : AppError
 * IDENTITY_UNAVAILABLE (UNAVAILABLE) ; ses refus (compte inconnu ou pas actif, rôle désactivé) sont
 * transmis tels quels.
 */
export interface AgentRoles {
  grant(input: { userId: string; reason: string }): Promise<{ assignmentId: string }>;
  revoke(input: { assignmentId: string; reason: string }): Promise<void>;
}

/** Compte KSP d'un agent chez identity : jamais son numéro ni son nom. */
export interface AgentAccount {
  userId: string;
  /** État du compte chez identity : `active`, ou `pending_verification` avant sa première connexion. */
  status: string;
  /** Le compte vient d'être créé par cet appel. */
  created: boolean;
}

/**
 * Compte KSP d'un agent créé par l'admin (identity.EnsureUserByPhone, R-AG-02) : identity rend le
 * compte du numéro, ou le crée « en attente de vérification » avec le prénom et le nom reçus ; il
 * contrôle et normalise le numéro. Appel idempotent : rejoué, il rend le même compte. identity
 * injoignable : AppError IDENTITY_UNAVAILABLE (UNAVAILABLE) ; ses refus (numéro ou nom mal formé,
 * compte suspendu ou supprimé) sont transmis tels quels.
 */
export interface AgentAccounts {
  ensureByPhone(input: { phone: string; firstName: string; lastName: string }): Promise<AgentAccount>;
  /**
   * Compte d'un numéro, sans le créer (identity.FindUserByPhone) : null s'il n'y en a pas, ou s'il
   * est supprimé. Sert à refuser l'invitation d'un numéro déjà agent, et à vérifier qu'une invitation
   * vise bien le compte qui s'inscrit.
   */
  findByPhone(phone: string): Promise<Pick<AgentAccount, 'userId' | 'status'> | null>;
}

/**
 * Invitation d'un agent par l'admin (R-AG-02). Le numéro invité reste chiffré ; son empreinte, qui
 * retrouve l'invitation en cours d'un numéro, ne sort pas du dépôt.
 */
export interface InvitationRecord {
  id: string;
  /** Numéro invité, chiffré ; null une fois l'invitation consommée. */
  phoneEncrypted: string | null;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  /** Dernier envoi réussi ; null : envoi à faire ou à refaire. */
  sentAt: Date | null;
  /** Envois terminés, réussis ou refusés par notification : le suivant porte le numéro suivant. */
  sendAttempts: number;
  consumedAt: Date | null;
  /** Agent créé par l'inscription qui a consommé l'invitation. */
  agentId: string | null;
}

export interface NewInvitation {
  id: string;
  phoneEncrypted: string;
  phoneFingerprint: string;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Empreinte à clé du numéro invité (HMAC, clé du coffre à secrets) : la même pour toutes les formes
 * d'un même numéro, jamais un simple condensé que l'on retrouverait en essayant les numéros.
 */
export interface PhoneFingerprints {
  invitationPhone(phone: string): string;
}

/**
 * Envoi de l'invitation au numéro invité (notification.SendNotification, modèle
 * `cleaning.agent_invitation`, WhatsApp puis SMS). `attempt` numérote les envois d'une invitation :
 * notification rejoue la réponse d'une clé déjà vue, un envoi refusé ne se retente donc qu'avec le
 * numéro suivant. notification injoignable : AppError NOTIFICATION_UNAVAILABLE (UNAVAILABLE), l'envoi
 * se rejoue avec le même numéro. Envoi refusé par tous les canaux : InvitationSendFailedError.
 */
export interface InvitationSender {
  send(input: { invitationId: string; attempt: number; phone: string; expiresAt: Date }): Promise<void>;
}

/** notification a répondu que l'envoi a échoué sur tous les canaux : cette tentative est terminée. */
export class InvitationSendFailedError extends Error {
  override readonly name = 'InvitationSendFailedError';
}
