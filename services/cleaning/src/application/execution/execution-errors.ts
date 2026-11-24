import { AppError } from '@ksp/platform';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import { type ExecutionErrorCode, ExecutionRuleError } from '../../domain/sessions/errors';
import { cleaningErrors } from '../shared/errors';

/**
 * Erreurs du lot E (tableau des erreurs de cleaning.proto). Les refus du domaine
 * (ExecutionRuleError) gardent leur code et leurs détails ; seuls la nature (statut gRPC) et le
 * message affiché à l'utilisateur sont ajoutés ici.
 */
type Kind = 'invalid' | 'notFound' | 'forbidden' | 'conflict' | 'precondition';

const RULES: Readonly<Record<ExecutionErrorCode, [Kind, string]>> = {
  CLEANING_BALANCE_GUARANTEE_NOT_MET: [
    'precondition',
    'Le solde du wallet ne couvre pas la séance : rechargez-le avant le démarrage.',
  ],
  CLEANING_CANCELLATION_TOO_LATE: ['precondition', 'Moins de 24 h avant la séance : contactez le support.'],
  CLEANING_CHECKLIST_INCOMPLETE: ['precondition', 'La liste de contrôle n’est pas complète.'],
  CLEANING_INSUFFICIENT_BALANCE: ['precondition', 'Le solde du wallet est insuffisant.'],
  CLEANING_INVALID_TRANSITION: ['precondition', 'Cette action n’est pas possible dans l’état actuel.'],
  CLEANING_LEAD_TIME_TOO_SHORT: ['precondition', 'La nouvelle date est trop proche.'],
  CLEANING_NOTHING_TO_PAY: ['precondition', 'Il n’y a rien à payer pour cette séance.'],
  CLEANING_PAYMENT_VIA_INVOICE: [
    'precondition',
    'Cette séance est réglée par la facture mensuelle de l’organisation.',
  ],
  CLEANING_PHOTOS_MISSING: ['precondition', 'Une photo est encore nécessaire.'],
  CLEANING_PHOTO_LIMIT_REACHED: ['precondition', 'Le nombre maximal de photos est atteint.'],
  CLEANING_PROGRAM_SUSPENDED: ['precondition', 'Le programme est suspendu.'],
  CLEANING_REASON_REQUIRED: ['invalid', 'Le motif est obligatoire.'],
  CLEANING_RESCHEDULE_LIMIT_REACHED: ['precondition', 'Les reports de ce mois sont épuisés.'],
  CLEANING_RESCHEDULE_OVERLAP: ['conflict', 'Ce créneau chevauche une autre séance du programme.'],
  CLEANING_SECOND_APPROVER_REQUIRED: [
    'forbidden',
    'La validation doit être faite par une autre personne que l’auteur de la demande.',
  ],
  CLEANING_SESSION_NOT_FOUND: ['notFound', 'Séance introuvable.'],
  CLEANING_SESSION_OVERDUE_PAYMENT: [
    'precondition',
    'Une séance précédente est en retard de paiement : la séance ne peut pas démarrer.',
  ],
  CLEANING_SESSION_TOO_EARLY: ['precondition', 'Il est trop tôt pour marquer l’arrivée.'],
  CLEANING_SLOT_INVALID: ['invalid', 'Ce créneau n’est pas valable.'],
  CLEANING_TEAM_LEAD_ONLY: ['forbidden', 'Cette action est réservée au chef d’équipe.'],
  CLEANING_VALIDATION_FAILED: ['invalid', 'Requête invalide.'],
  CLEANING_WAIT_TIME_NOT_ELAPSED: [
    'precondition',
    'L’attente réglée avant de déclarer le client absent n’est pas écoulée.',
  ],
};

export function ruleAppError(error: ExecutionRuleError): AppError {
  const [kind, message] = RULES[error.code];
  return AppError[kind](error.code, message, { ...error.details });
}

/** Refus du domaine et conflits d'écriture → erreurs du contrat ; le reste passe tel quel. */
export function executionError(error: unknown): unknown {
  if (error instanceof ExecutionRuleError) return ruleAppError(error);
  if (error instanceof ConcurrentUpdateError) return cleaningErrors.concurrentUpdate();
  return error;
}

/** Exécute une décision du domaine et traduit ses refus. */
export async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw executionError(error);
  }
}

export const executionErrors = {
  programNotFound: () => AppError.notFound('CLEANING_PROGRAM_NOT_FOUND', 'Programme introuvable.'),
  sessionNotFound: () => AppError.notFound('CLEANING_SESSION_NOT_FOUND', 'Séance introuvable.'),
  ratingAlreadyGiven: () =>
    AppError.conflict('CLEANING_RATING_ALREADY_GIVEN', 'Cette séance a déjà été notée.'),
  callerForbidden: () =>
    AppError.forbidden('CLEANING_CALLER_FORBIDDEN', 'Méthode réservée à un autre service.'),
  orgRoleRequired: () =>
    AppError.forbidden('AUTH_FORBIDDEN', 'Votre rôle dans l’organisation ne permet pas cette action.'),
};
