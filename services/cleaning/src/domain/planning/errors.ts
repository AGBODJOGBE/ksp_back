/**
 * Codes d'erreur des agents et de la planification, recopiés du contrat (cleaning.proto, tableau
 * des erreurs). Le domaine ne dépend pas de @ksp/contracts : l'adaptateur traduit ces motifs en
 * AppError, avec le même code et les mêmes détails.
 */
export type PlanningErrorCode =
  | 'CLEANING_INVALID_TRANSITION'
  | 'CLEANING_VALIDATION_FAILED'
  | 'CLEANING_REASON_REQUIRED'
  | 'CLEANING_AGENT_HAS_ASSIGNMENTS'
  | 'CLEANING_UNAVAILABILITY_CONFLICT'
  | 'CLEANING_AVAILABILITY_IN_USE'
  | 'CLEANING_AGENT_NOT_ACTIVE'
  | 'CLEANING_SKILL_MISSING'
  | 'CLEANING_AGENT_OUT_OF_ZONE'
  | 'CLEANING_AGENT_UNAVAILABLE'
  | 'CLEANING_AGENT_ON_LEAVE'
  | 'CLEANING_SCHEDULE_CONFLICT'
  | 'CLEANING_AGENT_OVERLOADED'
  | 'CLEANING_TEAM_SIZE_MISMATCH'
  | 'CLEANING_TEAM_INACTIVE'
  | 'CLEANING_PROGRAM_SUSPENDED';

/** Motif de refus : code du contrat et détails (details.from, details.reason, details.field…). */
export interface PlanningError {
  code: PlanningErrorCode;
  details: Record<string, unknown>;
}

/** Issue d'une décision du domaine : la valeur retenue, ou tous les motifs de refus. */
export type Decision<T> = { ok: true; value: T } | { ok: false; errors: PlanningError[] };

export function accepted<T>(value: T): Decision<T> {
  return { ok: true, value };
}

export function refused<T>(...errors: PlanningError[]): Decision<T> {
  return { ok: false, errors };
}

export function planningError(code: PlanningErrorCode, details: Record<string, unknown> = {}): PlanningError {
  return { code, details };
}
