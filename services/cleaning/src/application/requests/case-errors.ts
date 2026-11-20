import { AppError } from '@ksp/platform';
import { DomainRuleError, type RuleErrorCode } from '../../domain/requests/errors';

/**
 * Erreurs du dossier (lot C : lieux, demande, frais de visite, visite, constat, devis), au tableau des
 * erreurs de cleaning.proto. Les refus du domaine (DomainRuleError) gardent leur code et leurs
 * détails ; seule la nature (statut gRPC) et le message affiché sont ajoutés ici.
 */
export const caseErrors = {
  placeNotFound: () => AppError.notFound('CLEANING_PLACE_NOT_FOUND', 'Ce lieu est introuvable.'),
  requestNotFound: () => AppError.notFound('CLEANING_REQUEST_NOT_FOUND', 'Cette demande est introuvable.'),
  quoteNotFound: () => AppError.notFound('CLEANING_QUOTE_NOT_FOUND', 'Ce devis est introuvable.'),
  visitNotFound: () => AppError.notFound('CLEANING_VISIT_NOT_FOUND', 'Cette visite est introuvable.'),
  /** R-ZN-01, R-DM-01 : hors de tout contour, ou commune hors des zones actives. */
  zoneNotCovered: (
    reason: 'outside_boundaries' | 'commune_not_served',
    commune: { key: string; name: string } | null,
  ) =>
    AppError.precondition(
      'CLEANING_ZONE_NOT_COVERED',
      reason === 'outside_boundaries'
        ? 'Cette position est hors des communes du Bénin.'
        : "Cette commune n'est pas encore desservie.",
      { reason, communeKey: commune?.key ?? null, communeName: commune?.name ?? null },
    ),
  placeLocationMissing: () =>
    AppError.precondition(
      'CLEANING_PLACE_LOCATION_MISSING',
      'La position de ce lieu a été effacée : indiquez-la à nouveau.',
    ),
  /** Paiement par le wallet demandé, solde insuffisant (R-WL-05) : details.missing (Money). */
  insufficientBalance: (missing: number) =>
    AppError.precondition(
      'CLEANING_INSUFFICIENT_BALANCE',
      'Votre solde ne suffit pas : payez par Mobile Money.',
      { missing: { amount: missing, currency: 'XOF' } },
    ),
  callerForbidden: () =>
    AppError.forbidden('CLEANING_CALLER_FORBIDDEN', 'Méthode réservée à un autre service.'),
};

const MESSAGES: Readonly<Record<RuleErrorCode, string>> = {
  AUTH_FORBIDDEN: 'Votre rôle dans cette organisation ne permet pas cette action.',
  CLEANING_CANCELLATION_TOO_LATE: 'Moins de 24 h avant : passez par le support.',
  CLEANING_INVALID_TRANSITION: "Cette action n'est pas possible dans l'état actuel du dossier.",
  CLEANING_LEAD_TIME_TOO_SHORT: 'Cette date est trop proche.',
  CLEANING_NOTHING_TO_PAY: "Il n'y a rien à payer.",
  CLEANING_ORGANIZATION_SUSPENDED: 'Cette organisation est suspendue par KSP.',
  CLEANING_ORGANIZATION_UNPAID_INVOICES:
    "Des factures impayées de l'organisation bloquent l'acceptation d'un devis.",
  CLEANING_PHOTO_LIMIT_REACHED: 'Le nombre maximal de photos est atteint.',
  CLEANING_PRICE_NOT_POSITIVE: "Le prix d'une séance doit rester strictement positif.",
  CLEANING_PRICE_NOT_SET: "Une offre « sur devis » n'a pas encore de prix.",
  CLEANING_QUOTE_APPROVAL_REQUIRED: "Cette remise doit d'abord être validée par un admin.",
  CLEANING_QUOTE_EXPIRED: 'Ce devis a expiré.',
  CLEANING_REASON_REQUIRED: 'Le motif est obligatoire.',
  CLEANING_SCHEDULE_EMPTY: 'Ce programme ne donne aucune date de séance.',
  CLEANING_SECOND_APPROVER_REQUIRED: "L'auteur du devis ne valide pas sa propre remise.",
  CLEANING_SLOT_INVALID: 'Ce créneau est invalide.',
  CLEANING_TOO_MANY_OPEN_REQUESTS: 'Vous avez déjà le nombre maximal de demandes ouvertes.',
  CLEANING_VALIDATION_FAILED: 'La requête est invalide.',
  CLEANING_VISIT_FEE_UNPAID: 'Les frais de visite ne sont pas payés.',
  CLEANING_VISIT_TOO_EARLY: "L'heure de la visite n'est pas encore arrivée.",
};

const INVALID: readonly RuleErrorCode[] = [
  'CLEANING_VALIDATION_FAILED',
  'CLEANING_REASON_REQUIRED',
  'CLEANING_SLOT_INVALID',
];
const FORBIDDEN: readonly RuleErrorCode[] = ['AUTH_FORBIDDEN', 'CLEANING_SECOND_APPROVER_REQUIRED'];

/** Refus du domaine → AppError, même code et mêmes détails. */
export function ruleAppError(error: DomainRuleError): AppError {
  const details = { ...error.details };
  if (INVALID.includes(error.code)) return AppError.invalid(error.code, MESSAGES[error.code], details);
  if (FORBIDDEN.includes(error.code)) return AppError.forbidden(error.code, MESSAGES[error.code], details);
  return AppError.precondition(error.code, MESSAGES[error.code], details);
}

/** Traduit un refus du domaine levé par `work` ; toute autre erreur passe telle quelle. */
export function translated(error: unknown): unknown {
  return error instanceof DomainRuleError ? ruleAppError(error) : error;
}

/** Exécute une décision du domaine (synchrone) en traduisant ses refus. */
export function decide<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw translated(error);
  }
}
