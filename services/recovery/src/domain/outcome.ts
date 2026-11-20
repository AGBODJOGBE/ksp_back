/**
 * Résultat d'une règle du domaine : la valeur, ou un refus avec son code d'erreur. La couche
 * application traduit le refus en `AppError` (le domaine ne dépend pas du kit technique).
 *
 * Les codes sont ceux du contrat `ksp.recovery.v1` (en-tête de recovery.proto), sauf deux codes
 * internes que l'interface convertit :
 * - `RECOVERY_INVALID_AMOUNT` → `RECOVERY_PAYMENT_AMOUNT_INVALID` pour un paiement (montant nul ou
 *   au-delà du dû), `RECOVERY_VALIDATION_FAILED` (details.field) pour une saisie ;
 * - `RECOVERY_PLAN_INVALID` → `RECOVERY_VALIDATION_FAILED` (conditions d'échéancier incohérentes).
 */
export type RecoveryErrorCode =
  | 'RECOVERY_INVALID_TRANSITION'
  | 'RECOVERY_STAGE_SKIP_NOT_ALLOWED'
  | 'RECOVERY_CREDITOR_APPROVAL_REQUIRED'
  | 'RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED'
  | 'RECOVERY_PRICING_RULE_INVALID'
  | 'RECOVERY_PRICING_RULE_CONFLICT'
  | 'RECOVERY_APPROVAL_BY_REQUESTER'
  | 'RECOVERY_DEBTOR_LOCKED'
  | 'RECOVERY_DEBTOR_LINK_INVALID'
  | 'RECOVERY_DECISION_CLOSED'
  // Codes internes, convertis par l'interface (voir ci-dessus).
  | 'RECOVERY_INVALID_AMOUNT'
  | 'RECOVERY_PLAN_INVALID';

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: RecoveryErrorCode; reason: string };

export function success<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function refusal<T = never>(code: RecoveryErrorCode, reason: string): Outcome<T> {
  return { ok: false, code, reason };
}
