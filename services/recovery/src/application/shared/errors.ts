import { AppError } from '@ksp/platform';
import { type Outcome, type RecoveryErrorCode } from '../../domain/outcome';

/** Erreurs du service (en-tête de recovery.proto). Messages en français. */
export const RecoveryErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('RECOVERY_VALIDATION_FAILED', message, { field }),
  settingOutOfBounds: (field: string, message: string) =>
    AppError.invalid('RECOVERY_SETTING_OUT_OF_BOUNDS', message, { field }),
  pricingRuleNotFound: () =>
    AppError.notFound('RECOVERY_PRICING_RULE_NOT_FOUND', 'Cette règle tarifaire est introuvable.'),
  noApplicableRule: (object: string) =>
    AppError.precondition(
      'RECOVERY_PRICING_RULE_INVALID',
      'Aucune règle tarifaire publiée ne s’applique à cette demande.',
      { violations: [`aucune règle ${object} en vigueur`] },
    ),
  amountBelowMinimum: (minimum: number) =>
    AppError.invalid(
      'RECOVERY_AMOUNT_BELOW_MINIMUM',
      `Le montant dû doit atteindre au moins ${formatXof(minimum)}.`,
      { minimum: { amount: minimum, currency: 'XOF' } },
    ),
  keyReused: () =>
    AppError.conflict('RECOVERY_IDEMPOTENCY_KEY_REUSED', 'Cette clé a déjà servi pour une autre opération.'),
  callerForbidden: () =>
    AppError.forbidden('RECOVERY_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à appeler cette méthode."),
  dependencyUnavailable: (service: string) =>
    AppError.unavailable(
      'RECOVERY_DEPENDENCY_UNAVAILABLE',
      'Un service nécessaire est momentanément indisponible. Réessayez avec la même clé.',
      { service },
    ),
} as const;

/** Statut d'erreur de chaque code du domaine (table de l'en-tête de recovery.proto). */
const DOMAIN_ERRORS: Record<RecoveryErrorCode, (message: string) => AppError> = {
  RECOVERY_INVALID_TRANSITION: (m) => AppError.precondition('RECOVERY_INVALID_TRANSITION', m),
  RECOVERY_STAGE_SKIP_NOT_ALLOWED: (m) => AppError.precondition('RECOVERY_STAGE_SKIP_NOT_ALLOWED', m),
  RECOVERY_CREDITOR_APPROVAL_REQUIRED: (m) => AppError.precondition('RECOVERY_CREDITOR_APPROVAL_REQUIRED', m),
  RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED: (m) =>
    AppError.precondition('RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED', m),
  RECOVERY_PRICING_RULE_INVALID: (m) =>
    AppError.precondition('RECOVERY_PRICING_RULE_INVALID', 'Cette règle tarifaire est incomplète.', {
      violations: m.split(' ; '),
    }),
  RECOVERY_PRICING_RULE_CONFLICT: (m) => AppError.precondition('RECOVERY_PRICING_RULE_CONFLICT', m),
  RECOVERY_APPROVAL_BY_REQUESTER: (m) => AppError.forbidden('RECOVERY_APPROVAL_BY_REQUESTER', m),
  RECOVERY_DEBTOR_LOCKED: (m) => AppError.rateLimited('RECOVERY_DEBTOR_LOCKED', m),
  // Même message que la gateway pour un jeton mal formé : aucun indice sur la cause (ADR-061).
  RECOVERY_DEBTOR_LINK_INVALID: () =>
    AppError.notFound('RECOVERY_DEBTOR_LINK_INVALID', 'Ce lien est introuvable ou n’est plus valable.'),
  RECOVERY_DECISION_CLOSED: (m) => AppError.precondition('RECOVERY_DECISION_CLOSED', m),
  // Codes internes du domaine, convertis selon le contrat (outcome.ts).
  RECOVERY_INVALID_AMOUNT: (m) => AppError.invalid('RECOVERY_VALIDATION_FAILED', m, { field: 'amount' }),
  RECOVERY_PLAN_INVALID: (m) => AppError.invalid('RECOVERY_VALIDATION_FAILED', m, { field: 'terms' }),
};

/** Valeur d'un résultat du domaine, ou l'erreur du contrat qui correspond à son refus. */
export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw DOMAIN_ERRORS[outcome.code](outcome.reason);
}

/** Montant en francs CFA lisible : « 25 000 FCFA ». */
export function formatXof(amount: number): string {
  return `${new Intl.NumberFormat('fr-FR').format(amount).replace(/\s/g, ' ')} FCFA`;
}
