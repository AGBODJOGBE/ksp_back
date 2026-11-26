import { AppError } from '@ksp/platform';
import { changeStatus } from '../../domain/case';
import { type Clock, type FullSettings, type IdGenerator, type WalletGateway } from '../ports';
import { formatXof, unwrap } from '../shared/errors';
import { CaseErrors } from './case-errors';
import { amountDue, computeScore, evidenceEntry, SYSTEM } from './case-rules';
import { persist } from './case-writes';
import { type CaseRepository, type EvidenceActor, noChanges, type RecoveryCaseRecord } from './ports';

/**
 * Argent des frais de dossier (R-SD-04, ADR-060, décision du responsable sur le débit unique) :
 * - paiement : un seul débit du portefeuille prépayé du créancier, pour la totalité des frais (objet
 *   `recovery_case_fee`, libellé « Frais de dossier RC-000123 » : billing en tire le reçu) ;
 * - dossier refusé ou classé faute de complément : ce débit est remboursé en entier, puis le forfait
 *   d'étude est débité à part (objet `recovery_study_fee`).
 * Chaque appel à wallet a sa clé, propre au dossier : il se rejoue sans doublon, et la tâche des
 * échéances reprend une étape qui n'a pas abouti. Aucune donnée personnelle dans les libellés.
 */
export interface FeeDeps {
  cases: CaseRepository;
  wallet: WalletGateway;
  clock: Clock;
  ids: IdGenerator;
}

export const caseFeeKey = (caseId: string) => `recovery:case-fee:${caseId}`;
export const studyFeeKey = (caseId: string) => `recovery:study-fee:${caseId}`;

/** Refus métier de wallet (solde, clé…), par opposition à une panne : la demande n'a rien débité. */
export function isRefusal(error: unknown): error is AppError {
  return error instanceof AppError && error.kind !== 'UNAVAILABLE' && error.kind !== 'DEADLINE_EXCEEDED';
}

/** Solde insuffisant chez wallet → erreur du contrat, avec le montant manquant. */
export function translateRefusal(error: AppError): AppError {
  if (error.code !== 'WALLET_INSUFFICIENT_FUNDS') return error;
  const details = error.details as { missing?: { amount?: number }; balance?: { amount?: number } };
  return CaseErrors.insufficientFunds(Number(details.missing?.amount ?? 0), details.balance?.amount ?? null);
}

/**
 * Paiement des frais d'un dossier « frais à payer » : débit unique, puis envoi en examen
 * (`recovery.case.submitted`), score calculé (R-SD-07). La demande de débit est marquée avant
 * l'appel : sans réponse de wallet, la tâche des échéances la rapproche avant de supprimer le
 * dossier. Solde insuffisant : RECOVERY_INSUFFICIENT_FUNDS, rien n'est débité, marque levée.
 */
export async function payCaseFee(
  deps: FeeDeps,
  record: RecoveryCaseRecord,
  settings: FullSettings,
  actor: EvidenceActor,
): Promise<RecoveryCaseRecord> {
  const now = deps.clock.now();
  let current = record;
  let transactionId: string | null = null;
  if (current.fee.amount > 0) {
    if (current.fee.debitAttemptedAt === null) {
      current = await persist(
        deps.cases,
        { ...current, fee: { ...current.fee, debitAttemptedAt: now } },
        noChanges(),
        { now },
      );
    }
    try {
      const debit = await deps.wallet.debit({
        holder: current.creditor,
        amount: current.fee.amount,
        objectType: 'recovery_case_fee',
        objectId: current.id,
        idempotencyKey: caseFeeKey(current.id),
        description: `Frais de dossier ${current.number}`,
      });
      transactionId = debit.transactionId;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      await persist(
        deps.cases,
        { ...current, fee: { ...current.fee, debitAttemptedAt: null } },
        noChanges(),
        {
          now,
        },
      );
      throw translateRefusal(error);
    }
  }
  const submitted = unwrap(changeStatus(current, 'under_review'));
  const paid: RecoveryCaseRecord = {
    ...current,
    status: submitted.status,
    submittedAt: now,
    fee: { ...current.fee, paidAt: now, debitTransactionId: transactionId, debitAttemptedAt: null },
  };
  const next = { ...paid, score: computeScore(paid, settings, now) };
  const changes = noChanges();
  changes.evidence.push(
    evidenceEntry(deps.ids, next, now, actor, {
      action: 'fee.paid',
      kind: 'payment',
      summary: `Frais de dossier payés par le portefeuille : ${formatXof(next.fee.amount)}`,
      amount: next.fee.amount,
    }),
    evidenceEntry(deps.ids, next, now, actor, {
      action: 'case.submitted',
      kind: 'status_changed',
      summary: 'Dossier envoyé à KSP pour l’examen de recevabilité',
    }),
  );
  changes.events.push({
    type: 'recovery.case.submitted',
    payload: {
      caseId: next.id,
      caseNumber: next.number,
      creditor: next.creditor,
      kind: next.kind,
      amountDue: { amount: amountDue(next), currency: 'XOF' },
      source: next.source,
      submittedAt: now.toISOString(),
    },
  });
  const outcome = await deps.cases.save(next, changes);
  if (outcome === 'saved') return { ...next, version: current.version + 1 };
  // Écriture concurrente : un rejeu a déjà enregistré le paiement, sinon le débit est rendu aussitôt.
  const latest = await deps.cases.find(current.id);
  if (latest?.fee.paidAt) return latest;
  if (transactionId) {
    await deps.wallet.refund({
      debitTransactionId: transactionId,
      reason: `Dossier ${current.number} modifié`,
    });
  }
  throw CaseErrors.concurrentUpdate(current.status);
}

/** Motif du remboursement (relevé du portefeuille), sans donnée personnelle. */
function refundReason(record: RecoveryCaseRecord): string {
  return record.rejectionReason === 'incomplete'
    ? `Dossier ${record.number} classé faute de complément`
    : `Dossier ${record.number} refusé`;
}

const refundDue = (record: RecoveryCaseRecord) =>
  record.fee.debitTransactionId !== null && record.fee.refundedAt === null;
const studyFeeDue = (record: RecoveryCaseRecord) =>
  record.fee.refundedAt !== null && record.fee.studyFee > 0 && record.fee.studyFeeChargedAt === null;

/** Remboursement ou forfait d'étude encore à passer sur un dossier refusé. */
export function feeSettlementPending(record: RecoveryCaseRecord): boolean {
  return record.status === 'rejected' && (refundDue(record) || studyFeeDue(record));
}

/**
 * Règlement des frais d'un dossier refusé (4.4) : remboursement du débit entier, puis débit du forfait
 * d'étude ; chaque étape est enregistrée (journal de preuve) dès qu'elle aboutit. Une étape en échec
 * (wallet indisponible, solde insuffisant pour le forfait) reste à faire : la tâche des échéances la
 * reprend avec la même clé. Rend le dossier à jour et l'erreur éventuelle, sans la lever.
 */
export async function settleRejectedFee(
  deps: FeeDeps,
  record: RecoveryCaseRecord,
): Promise<{ record: RecoveryCaseRecord; error: unknown }> {
  let current = record;
  try {
    if (refundDue(current)) {
      const refund = await deps.wallet.refund({
        debitTransactionId: current.fee.debitTransactionId!,
        reason: refundReason(current),
      });
      const now = deps.clock.now();
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(deps.ids, current, now, SYSTEM, {
          action: 'fee.refunded',
          kind: 'payment',
          summary: `Frais de dossier remboursés au portefeuille : ${formatXof(current.fee.amount)}`,
          amount: current.fee.amount,
        }),
      );
      current = await persist(
        deps.cases,
        { ...current, fee: { ...current.fee, refundTransactionId: refund.transactionId, refundedAt: now } },
        changes,
        { now },
      );
    }
    if (studyFeeDue(current)) {
      const debit = await deps.wallet.debit({
        holder: current.creditor,
        amount: current.fee.studyFee,
        objectType: 'recovery_study_fee',
        objectId: current.id,
        idempotencyKey: studyFeeKey(current.id),
        description: `Forfait d'étude du dossier ${current.number}`,
      });
      const now = deps.clock.now();
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(deps.ids, current, now, SYSTEM, {
          action: 'fee.study_fee_charged',
          kind: 'payment',
          summary: `Forfait d’étude retenu : ${formatXof(current.fee.studyFee)}`,
          amount: current.fee.studyFee,
        }),
      );
      current = await persist(
        deps.cases,
        {
          ...current,
          fee: { ...current.fee, studyFeeTransactionId: debit.transactionId, studyFeeChargedAt: now },
        },
        changes,
        { now },
      );
    }
    return { record: current, error: null };
  } catch (error) {
    return { record: current, error };
  }
}
