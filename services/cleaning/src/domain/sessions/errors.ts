/**
 * Refus motivé d'une règle du lot E (exécution d'une séance, programme, paiement par séance). Le
 * domaine reste pur : il lève cette erreur avec le code du contrat (en-tête de cleaning.proto) et ses
 * `details` ; la couche application la traduit en AppError, avec le message affiché à l'utilisateur.
 */
export type ExecutionErrorCode =
  | 'CLEANING_BALANCE_GUARANTEE_NOT_MET'
  | 'CLEANING_CANCELLATION_TOO_LATE'
  | 'CLEANING_CHECKLIST_INCOMPLETE'
  | 'CLEANING_INSUFFICIENT_BALANCE'
  | 'CLEANING_INVALID_TRANSITION'
  | 'CLEANING_LEAD_TIME_TOO_SHORT'
  | 'CLEANING_NOTHING_TO_PAY'
  | 'CLEANING_PAYMENT_VIA_INVOICE'
  | 'CLEANING_PHOTOS_MISSING'
  | 'CLEANING_PHOTO_LIMIT_REACHED'
  | 'CLEANING_PROGRAM_SUSPENDED'
  | 'CLEANING_REASON_REQUIRED'
  | 'CLEANING_RESCHEDULE_LIMIT_REACHED'
  | 'CLEANING_RESCHEDULE_OVERLAP'
  | 'CLEANING_SECOND_APPROVER_REQUIRED'
  | 'CLEANING_SESSION_NOT_FOUND'
  | 'CLEANING_SESSION_OVERDUE_PAYMENT'
  | 'CLEANING_SESSION_TOO_EARLY'
  | 'CLEANING_SLOT_INVALID'
  | 'CLEANING_TEAM_LEAD_ONLY'
  | 'CLEANING_VALIDATION_FAILED'
  | 'CLEANING_WAIT_TIME_NOT_ELAPSED';

export class ExecutionRuleError extends Error {
  constructor(
    readonly code: ExecutionErrorCode,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'ExecutionRuleError';
  }
}

/** Transition interdite (partie 15.2) : `details.from`, `details.to`, et un motif facultatif. */
export function invalidTransition(from: string, to: string, reason?: string): ExecutionRuleError {
  return new ExecutionRuleError('CLEANING_INVALID_TRANSITION', reason ? { from, to, reason } : { from, to });
}

/** Motif obligatoire absent ou vide (CLEANING_REASON_REQUIRED, details.field). */
export function requireReason(reason: string | null | undefined, field = 'reason'): string {
  const text = reason?.trim() ?? '';
  if (text.length === 0) throw new ExecutionRuleError('CLEANING_REASON_REQUIRED', { field });
  return text;
}

/** Valeur refusée (CLEANING_VALIDATION_FAILED) : champ en cause et raison du contrat. */
export function validationFailed(field: string, reason: string, extra: Record<string, unknown> = {}) {
  return new ExecutionRuleError('CLEANING_VALIDATION_FAILED', { field, reason, ...extra });
}
