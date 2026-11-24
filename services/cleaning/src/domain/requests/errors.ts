/**
 * Refus motivé d'une règle du domaine (lot C). Le domaine reste pur : il lève cette erreur avec le
 * code du contrat (en-tête de cleaning.proto) et ses `details` ; la couche application la traduit
 * en AppError, avec le message affiché à l'utilisateur.
 */
export type RuleErrorCode =
  | 'AUTH_FORBIDDEN'
  | 'CLEANING_CANCELLATION_TOO_LATE'
  | 'CLEANING_INVALID_TRANSITION'
  | 'CLEANING_LEAD_TIME_TOO_SHORT'
  | 'CLEANING_NOTHING_TO_PAY'
  | 'CLEANING_ORGANIZATION_SUSPENDED'
  | 'CLEANING_ORGANIZATION_UNPAID_INVOICES'
  | 'CLEANING_PHOTO_LIMIT_REACHED'
  | 'CLEANING_PRICE_NOT_POSITIVE'
  | 'CLEANING_PRICE_NOT_SET'
  | 'CLEANING_QUOTE_APPROVAL_REQUIRED'
  | 'CLEANING_QUOTE_EXPIRED'
  | 'CLEANING_REASON_REQUIRED'
  | 'CLEANING_SCHEDULE_EMPTY'
  | 'CLEANING_SECOND_APPROVER_REQUIRED'
  | 'CLEANING_SLOT_INVALID'
  | 'CLEANING_TOO_MANY_OPEN_REQUESTS'
  | 'CLEANING_VALIDATION_FAILED'
  | 'CLEANING_VISIT_FEE_UNPAID'
  | 'CLEANING_VISIT_TOO_EARLY';

/** Motifs facultatifs de CLEANING_INVALID_TRANSITION retenus par le contrat (RV-01). */
export type InvalidTransitionReason = 'commune_change_locked';

export class DomainRuleError extends Error {
  constructor(
    readonly code: RuleErrorCode,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code);
    this.name = 'DomainRuleError';
  }
}

/**
 * Transition interdite (partie 15.2) : `details.from` et `details.to`. Une action qui ne change pas
 * l'état (enregistrer le retenu, transmettre un devis) donne le même statut des deux côtés.
 */
export function invalidTransition(
  from: string,
  to: string,
  reason?: InvalidTransitionReason,
): DomainRuleError {
  return new DomainRuleError('CLEANING_INVALID_TRANSITION', reason ? { from, to, reason } : { from, to });
}

/** Motif obligatoire absent ou vide (CLEANING_REASON_REQUIRED, details.field). */
export function requireReason(reason: string | null | undefined, field = 'reason'): string {
  const text = reason?.trim() ?? '';
  if (text.length === 0) throw new DomainRuleError('CLEANING_REASON_REQUIRED', { field });
  return text;
}
