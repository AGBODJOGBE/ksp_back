import { ExecutionRuleError } from '../sessions/errors';
import { effectivePaymentStatus, type SessionPaymentStatus } from './payment-status';

/**
 * Conditions de paiement au démarrage d'une séance de particulier (StartSession) : une séance en
 * retard bloque la suivante (R-PP-04) ; la garantie de solde, si l'admin l'active, exige un solde
 * qui couvre la séance (R-PP-05).
 */
export const DEFAULT_BALANCE_GUARANTEE = false;

export interface ProgramPaymentLine {
  sessionId: string;
  paymentStatus: SessionPaymentStatus | null;
  dueBy: Date | null;
}

export interface StartPaymentContext {
  payerKind: 'individual';
  /** Séances du programme, avec leur paiement (la séance à démarrer comprise ou non). */
  programSessions: readonly ProgramPaymentLine[];
  balanceGuarantee: boolean;
  /** Solde disponible du wallet du client. */
  balance: number;
  /** Montant attendu de la séance (prix moins les frais de visite qui lui restent à déduire). */
  expectedAmount: number;
}

/**
 * Interprétation prudente de « la séance suivante ne peut pas démarrer » : toute autre séance du
 * programme en retard (statut lu d'après l'heure) bloque le démarrage, quel que soit le seuil de
 * suspension, et jusqu'au paiement du retard.
 */
export function overdueSessionsBlockingStart(
  sessionId: string,
  programSessions: readonly ProgramPaymentLine[],
  now: Date,
): string[] {
  return programSessions
    .filter((line) => line.sessionId !== sessionId)
    .filter((line) => effectivePaymentStatus(line.paymentStatus, line.dueBy, now) === 'overdue')
    .map((line) => line.sessionId);
}

/** `context` null : séance d'entreprise, réglée par la facture mensuelle (partie 11.2). */
export function assertPaymentAllowsStart(
  sessionId: string,
  context: StartPaymentContext | null,
  now: Date,
): void {
  if (context === null) return;
  const overdue = overdueSessionsBlockingStart(sessionId, context.programSessions, now);
  if (overdue.length > 0) {
    throw new ExecutionRuleError('CLEANING_SESSION_OVERDUE_PAYMENT', { sessionIds: overdue });
  }
  if (context.balanceGuarantee && context.balance < context.expectedAmount) {
    throw new ExecutionRuleError('CLEANING_BALANCE_GUARANTEE_NOT_MET', { amountDue: context.expectedAmount });
  }
}
