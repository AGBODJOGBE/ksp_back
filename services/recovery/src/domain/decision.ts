import { addDaysToInstant } from './calendar';
import { type Outcome, refusal, success } from './outcome';
import { type RecoverySettings } from './settings';

/**
 * Décisions demandées au créancier (UC-RC-06, 07 ; message `Decision` du contrat) : échéancier hors
 * barème, remise au-delà du barème, passage à l'huissier ou au judiciaire (devis et provision), réponse
 * à une contestation, saut d'étape tracé (R-PR-03). Une décision se prend une fois, avant son échéance.
 */
export type DecisionKind =
  | 'plan_off_scale'
  | 'settlement_discount'
  | 'bailiff_escalation'
  | 'litigation_escalation'
  | 'dispute_response'
  | 'stage_skip';

export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'answered' | 'expired';

export interface Decision {
  kind: DecisionKind;
  status: DecisionStatus;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Délai de chaque décision : 3 jours pour un hors-barème ou une remise (R-EC-01), 15 pour une étape
 * payante et pour un saut d'étape (R-PR-04), 10 pour répondre à une contestation (R-PR-02).
 */
export function decisionDays(kind: DecisionKind, settings: RecoverySettings): number {
  switch (kind) {
    case 'plan_off_scale':
    case 'settlement_discount':
      return settings.planCreditorApprovalDays;
    case 'dispute_response':
      return settings.disputeAnswerDays;
    default:
      return settings.creditorApprovalDays;
  }
}

export function openDecision(kind: DecisionKind, now: Date, settings: RecoverySettings): Decision {
  return {
    kind,
    status: 'pending',
    createdAt: now,
    expiresAt: addDaysToInstant(now, decisionDays(kind, settings)),
  };
}

/** Réponse du créancier : accord ou refus ; une contestation reçoit une réponse (`answered`). */
export type DecisionAnswer = 'approve' | 'reject' | 'answer';

/** Prise d'une décision ; déjà prise ou échue : `RECOVERY_DECISION_CLOSED`. */
export function answerDecision(decision: Decision, answer: DecisionAnswer, now: Date): Outcome<Decision> {
  if (decision.status !== 'pending' || now >= decision.expiresAt) {
    return refusal('RECOVERY_DECISION_CLOSED', 'Décision déjà prise ou expirée');
  }
  if ((decision.kind === 'dispute_response') !== (answer === 'answer')) {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Réponse sans rapport avec la décision');
  }
  const status: DecisionStatus =
    answer === 'approve' ? 'approved' : answer === 'reject' ? 'rejected' : 'answered';
  return success({ ...decision, status });
}

/**
 * Suite d'une décision restée sans réponse : refus (échéancier, remise, saut d'étape), abandon du
 * dossier pour une étape payante (R-PR-04, motif `abandoned_by_creditor`), décision du juriste pour une
 * contestation (R-PR-02).
 */
export type ExpiryEffect = 'refused' | 'abandon_case' | 'legal_officer_decides';

export function expireDecision(
  decision: Decision,
  now: Date,
): { decision: Decision; effect: ExpiryEffect } | null {
  if (decision.status !== 'pending' || now < decision.expiresAt) return null;
  const effect: ExpiryEffect =
    decision.kind === 'bailiff_escalation' || decision.kind === 'litigation_escalation'
      ? 'abandon_case'
      : decision.kind === 'dispute_response'
        ? 'legal_officer_decides'
        : 'refused';
  return { decision: { ...decision, status: 'expired' }, effect };
}
