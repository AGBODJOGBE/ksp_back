import { CaseErrors } from '../cases/case-errors';
import { evidenceEntry, stableId, SYSTEM } from '../cases/case-rules';
import { noChanges } from '../cases/ports';
import { type DisputeResponses } from '../debtor-space/dispute-responses';
import { type DisputeRecord } from '../money/money.ports';
import { type AmicableDeps, type DecisionRecord, noAmicableChanges } from './amicable.ports';
import { AmicableErrors, decisionRequested } from './amicable-rules';

/**
 * Réponse du créancier à une contestation du débiteur (R-PR-02, UC-RC-07) : une décision
 * `dispute_response` par contestation, d'identifiant dérivé de la contestation (une seule, même
 * rejouée), demandée à son ouverture jusqu'à l'échéance de la contestation (10 jours, réglable). Le
 * créancier répond une fois, avec ses pièces (AnswerDecision) ; sans réponse à l'échéance, la tâche
 * l'expire et le juriste décide quand même ; tranchée avant, la demande est close.
 */
export const disputeResponseId = (disputeId: string) => stableId('recovery-dispute-response', disputeId);

/** Réponse du créancier lue dans sa décision : texte, pièces, date. */
export interface DisputeAnswer {
  comment: string | null;
  fileIds: string[];
  answeredAt: Date;
}

/**
 * Contestation présentée : statut `creditor_answered` (et date de réponse) une fois la décision
 * répondue, tant que le juriste n'a pas tranché ; réponse du créancier jointe.
 */
export interface AnsweredDispute {
  dispute: DisputeRecord;
  answer: DisputeAnswer | null;
}

export function answeredDispute(dispute: DisputeRecord, decision: DecisionRecord | null): AnsweredDispute {
  if (decision?.status !== 'answered' || !decision.answer) return { dispute, answer: null };
  const answeredAt = decision.decidedAt ?? decision.requestedAt;
  return {
    dispute:
      dispute.status === 'open'
        ? { ...dispute, status: 'creditor_answered', creditorAnsweredAt: answeredAt }
        : dispute,
    answer: { comment: decision.answer.comment, fileIds: decision.answer.fileIds, answeredAt },
  };
}

/** Contestations d'un dossier avec la réponse du créancier (fiche du dossier). */
export async function disputesWithAnswers(
  deps: Pick<AmicableDeps, 'amicable'>,
  disputes: readonly DisputeRecord[],
): Promise<AnsweredDispute[]> {
  const answered: AnsweredDispute[] = [];
  for (const dispute of disputes) {
    answered.push(answeredDispute(dispute, await deps.amicable.decision(disputeResponseId(dispute.id))));
  }
  return answered;
}

/** Contestation portée par une décision `dispute_response`, avec sa réponse ; null pour une autre décision. */
export async function decisionDispute(
  deps: Pick<AmicableDeps, 'money'>,
  decision: DecisionRecord,
): Promise<AnsweredDispute | null> {
  const disputeId = decision.payload.disputeId;
  if (decision.kind !== 'dispute_response' || !disputeId) return null;
  const dispute = (await deps.money.disputes(decision.caseId)).find(
    (candidate) => candidate.id === disputeId,
  );
  return dispute ? answeredDispute(dispute, decision) : null;
}

/**
 * Réponse refusée si la contestation est déjà tranchée (la demande aurait dû être close à la
 * résolution) : `RECOVERY_DECISION_CLOSED`.
 */
export async function requireDisputeOpen(
  deps: Pick<AmicableDeps, 'money'>,
  decision: DecisionRecord,
): Promise<void> {
  const answered = await decisionDispute(deps, decision);
  if (answered && answered.dispute.status !== 'open' && answered.dispute.status !== 'creditor_answered') {
    throw AmicableErrors.decisionClosed(answered.dispute.status);
  }
}

export class AmicableDisputeResponses implements DisputeResponses {
  constructor(private readonly deps: AmicableDeps) {}

  /**
   * Décision demandée au créancier, échéance = celle de la contestation ; `recovery.decision.requested`
   * le prévient. Une demande restée ouverte d'une contestation précédente (clôture manquée) est close
   * dans la même écriture : une seule réponse attendue par dossier.
   */
  async requested(input: { caseId: string; disputeId: string }): Promise<void> {
    const id = disputeResponseId(input.disputeId);
    if (await this.deps.amicable.decision(id)) return;
    const record = await this.deps.cases.find(input.caseId);
    const dispute = (await this.deps.money.disputes(input.caseId)).find(
      (candidate) => candidate.id === input.disputeId,
    );
    if (!record || !dispute || dispute.status !== 'open') return;
    const now = this.deps.clock.now();
    const decision: DecisionRecord = {
      id,
      caseId: record.id,
      kind: 'dispute_response',
      status: 'pending',
      payload: { disputeId: dispute.id },
      requestedBy: null,
      requestedAt: dispute.openedAt,
      expiresAt: dispute.creditorAnswerDueAt,
      decidedAt: null,
      decidedBy: null,
      answer: null,
    };
    const amicable = noAmicableChanges();
    const leftover = await this.deps.amicable.pendingDecision(record.id, 'dispute_response');
    if (leftover && leftover.id !== id) {
      amicable.decisions.push({
        row: { ...leftover, status: 'expired', decidedAt: now },
        expected: 'pending',
      });
    }
    amicable.decisions.push({ row: decision, expected: null });
    const changes = noChanges();
    changes.events.push(decisionRequested(record, decision));
    const outcome = await this.deps.amicable.commit({
      touch: { caseId: record.id, at: now },
      changes,
      amicable,
    });
    // Écrite en même temps par un autre appel (même identifiant) : rien à refaire. Sinon, la demande
    // rejouée (même clé) la refera.
    if (outcome !== 'saved' && !(await this.deps.amicable.decision(id))) {
      throw CaseErrors.concurrentUpdate(record.status);
    }
  }

  /** Contestation tranchée par le juriste : la demande encore ouverte est close (expirée), tracée. */
  async settled(input: { caseId: string; disputeId: string }): Promise<void> {
    const decision = await this.deps.amicable.decision(disputeResponseId(input.disputeId));
    if (!decision || decision.caseId !== input.caseId || decision.status !== 'pending') return;
    const now = this.deps.clock.now();
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, { id: input.caseId }, now, SYSTEM, {
        action: 'decision.closed',
        kind: 'decision',
        summary: 'Contestation tranchée par le juriste : la réponse du créancier n’est plus attendue',
      }),
    );
    const amicable = noAmicableChanges();
    amicable.decisions.push({ row: { ...decision, status: 'expired', decidedAt: now }, expected: 'pending' });
    await this.deps.amicable.commit({ touch: { caseId: input.caseId, at: now }, changes, amicable });
  }
}
