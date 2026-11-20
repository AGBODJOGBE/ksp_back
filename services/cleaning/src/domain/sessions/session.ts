import type { ArrivalGeoCheck } from './arrival';
import { ExecutionRuleError } from './errors';
import type { SessionStatus } from './session-status';

/**
 * Séance vue par l'exécution sur le terrain (partie 10) : équipe, arrivée, photos, liste de
 * contrôle, incidents et absence du client. Les photos sont des références du service file.
 */
export const DEFAULT_MAX_PHOTOS_PER_KIND = 10;

export interface AssignedAgent {
  agentId: string;
  isLead: boolean;
}

/** Point de la liste de contrôle (R-EX-09) : désigné par son type et son code (type null : commun). */
export interface ChecklistPoint {
  cleaningTypeCode: string | null;
  code: string;
  label: string;
  checked: boolean;
  checkedAt: Date | null;
}

export type IncidentCategory = 'equipment' | 'access' | 'safety' | 'out_of_scope_request' | 'other';
export type IncidentDecision = 'pending' | 'resumed' | 'rescheduled' | 'cancelled';

export interface Incident {
  id: string;
  category: IncidentCategory;
  note: string;
  photoFileIds: string[];
  reportedBy: string;
  occurredAt: Date;
  decision: IncidentDecision;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/** Cause d'une séance manquée (ReportSessionMissedRequest.cause). */
export type MissedCause = 'customer_absent' | 'access_impossible';

export interface MissedRecord {
  cause: MissedCause;
  missedAt: Date;
  waitStartedAt: Date | null;
  calledAt: Date | null;
  photoFileId: string | null;
}

/** Clôture ou absence enregistrée par le back-office pour l'équipe (R-EX-08). */
export interface StaffClosure {
  closedBy: string;
  reason: string;
  presentAgentIds: string[];
}

export interface FieldSession {
  id: string;
  status: SessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  agents: AssignedAgent[];
  arrivedAt: Date | null;
  arrival: ArrivalGeoCheck | null;
  startedAt: Date | null;
  completedAt: Date | null;
  checklist: ChecklistPoint[];
  beforePhotoFileIds: string[];
  afterPhotoFileIds: string[];
  incidents: Incident[];
  missed: MissedRecord | null;
  signatureFileId: string | null;
  staffClosure: StaffClosure | null;
}

/**
 * R-EX-01 : seuls les agents affectés voient et exécutent la séance (un autre agent reçoit
 * CLEANING_SESSION_NOT_FOUND). R-EQ-03 : le chef d'équipe démarre et clôture. Interprétation : un
 * agent seul sur sa séance en est le chef, qu'il en porte la marque ou non.
 */
export function assertTeamMember(session: Pick<FieldSession, 'agents'>, agentId: string, leadOnly: boolean) {
  const member = session.agents.find((agent) => agent.agentId === agentId);
  if (!member) throw new ExecutionRuleError('CLEANING_SESSION_NOT_FOUND');
  if (leadOnly && !member.isLead && session.agents.length > 1) {
    throw new ExecutionRuleError('CLEANING_TEAM_LEAD_ONLY');
  }
}
