import { type Outcome, refusal, success } from './outcome';

/**
 * Contestation du débiteur (R-PR-02 ; message `Dispute` du contrat) : elle suspend le dossier ; le
 * créancier a 10 jours pour répondre avec ses pièces ; le juriste décide de reprendre (contestation
 * rejetée), de corriger le montant ou de clôturer (contestation fondée). Sans réponse du créancier dans
 * le délai, le juriste décide quand même, averti du silence.
 */
export type DisputeReason =
  'already_paid' | 'wrong_amount' | 'service_not_rendered' | 'wrong_person' | 'other';

export type DisputeStatus = 'open' | 'creditor_answered' | 'upheld' | 'rejected' | 'amount_corrected';

/** Suite décidée par le juriste (`ResolveDisputeRequest.resolution`). */
export type DisputeResolution = 'resume' | 'correct_amount' | 'close';

export interface Dispute {
  reason: DisputeReason;
  status: DisputeStatus;
  openedAt: Date;
  creditorAnswerDueAt: Date;
  /** Le créancier n'a pas répondu dans le délai (information du juriste). */
  creditorSilent: boolean;
}

const OPEN: ReadonlySet<DisputeStatus> = new Set(['open', 'creditor_answered']);

export function isOpen(dispute: Dispute): boolean {
  return OPEN.has(dispute.status);
}

export function openDispute(reason: DisputeReason, now: Date, answerDays: number): Dispute {
  return {
    reason,
    status: 'open',
    openedAt: now,
    creditorAnswerDueAt: new Date(now.getTime() + answerDays * 86_400_000),
    creditorSilent: false,
  };
}

/** Réponse du créancier avec ses pièces (décision `dispute_response`) : la suite revient au juriste. */
export function creditorAnswered(dispute: Dispute): Outcome<Dispute> {
  if (dispute.status !== 'open') {
    return refusal('RECOVERY_DECISION_CLOSED', 'La contestation n’attend plus la réponse du créancier');
  }
  return success({ ...dispute, status: 'creditor_answered' });
}

/** Délai du créancier écoulé sans réponse : la contestation reste ouverte pour le juriste, silence noté. */
export function noteCreditorSilence(dispute: Dispute, now: Date): Dispute {
  if (dispute.status !== 'open' || now < dispute.creditorAnswerDueAt) return dispute;
  return { ...dispute, creditorSilent: true };
}

const RESOLUTION_STATUS: Record<DisputeResolution, DisputeStatus> = {
  resume: 'rejected',
  correct_amount: 'amount_corrected',
  close: 'upheld',
};

/**
 * Suite du juriste. « Reprendre » et « corriger » rendent le dossier actif ; « clôturer » le clôt
 * (motif `dispute_upheld`). Le juriste peut trancher avant la réponse du créancier.
 */
export function resolveDispute(dispute: Dispute, resolution: DisputeResolution): Outcome<Dispute> {
  if (!isOpen(dispute)) return refusal('RECOVERY_DECISION_CLOSED', 'Contestation déjà tranchée');
  return success({ ...dispute, status: RESOLUTION_STATUS[resolution] });
}
