import { Logger } from '@nestjs/common';
import { payVisitFee, type VisitFee } from '../../domain/requests/visit-fee';
import { DomainRuleError } from '../../domain/requests/errors';
import { type CleaningDeps } from '../deps';
import { type OutboxMessage } from '../ports';
import { holderOf } from './customer';
import { audit, caseParty, catalogNames, iso, money, saveCase } from './case-support';
import { type CaseRecord, type WalletOperationRecord } from './requests.ports';

/**
 * Argent des frais de visite (R-FV-02, R-FV-06, ADR-055, 15.4). Une opération envoyée au wallet est
 * enregistrée « en cours » dans la transaction de la décision, puis envoyée, puis son issue est
 * enregistrée ; une opération restée en cours (panne) est rejouée avec la même clé par la tâche des
 * échéances (RV-80, RV-81). Clés : débit « cleaning_visit_fee:<demande>:<rang> », suivie de
 * « :<tentative> » à partir de la deuxième ; remboursement « cleaning_visit_fee_refund:<frais> »,
 * jamais versé deux fois.
 */
const logger = new Logger('VisitFeeMoney');

export const SYSTEM_ACTOR = 'system';

/** Les tentatives précédentes d'un débit refusé (solde insuffisant) n'ont rien pris. */
export function newDebit(
  deps: CleaningDeps,
  record: CaseRecord,
  fee: VisitFee,
  previous: readonly WalletOperationRecord[],
  actorId: string | null,
  now: Date,
): WalletOperationRecord {
  const attempt =
    previous
      .filter((op) => op.kind === 'debit' && op.visitFeeId === fee.id)
      .reduce((max, op) => Math.max(max, op.attempt), 0) + 1;
  const base = `cleaning_visit_fee:${record.request.id}:${fee.rank}`;
  return {
    id: deps.ids.next(),
    kind: 'debit',
    purpose: 'visit_fee',
    idempotencyKey: attempt === 1 ? base : `${base}:${attempt}`,
    attempt,
    holder: record.request.owner,
    amount: fee.amount,
    label: `Nettoyage — frais de visite ${record.request.number}`.slice(0, 200),
    requestId: record.request.id,
    visitFeeId: fee.id,
    status: 'pending',
    walletTransactionId: null,
    failureCode: null,
    createdBy: actorId,
    createdAt: now,
    completedAt: null,
  };
}

/** Remboursement intégral au wallet de frais débités (R-FV-06) ; null s'il n'y a rien à rendre. */
export function newRefund(
  deps: CleaningDeps,
  record: CaseRecord,
  fee: VisitFee,
  operations: readonly WalletOperationRecord[],
  actorId: string | null,
  now: Date,
): WalletOperationRecord | null {
  const debit = operations.find(
    (op) => op.kind === 'debit' && op.visitFeeId === fee.id && op.status === 'succeeded',
  );
  if (!debit?.walletTransactionId) return null;
  if (operations.some((op) => op.kind === 'credit' && op.visitFeeId === fee.id)) return null;
  return {
    ...debit,
    id: deps.ids.next(),
    kind: 'credit',
    purpose: 'visit_fee_refund',
    idempotencyKey: `cleaning_visit_fee_refund:${fee.id}`,
    attempt: 1,
    label: `Nettoyage — remboursement des frais de visite ${record.request.number}`.slice(0, 200),
    status: 'pending',
    walletTransactionId: debit.walletTransactionId,
    failureCode: null,
    createdBy: actorId,
    createdAt: now,
    completedAt: null,
  };
}

export type DebitOutcome =
  | { status: 'succeeded'; walletTransactionId: string }
  | { status: 'failed'; failureCode: string }
  | { status: 'unknown' };

/** Codes de wallet définitifs : le débit n'a rien pris, l'opération est close « échouée ». */
const FINAL_DEBIT_FAILURES = ['WALLET_INSUFFICIENT_FUNDS', 'WALLET_DEBIT_REFUNDED', 'WALLET_NOT_FOUND'];

/** Envoie le débit ; une panne laisse l'opération « en cours », rejouée plus tard. */
export async function sendDebit(deps: CleaningDeps, op: WalletOperationRecord): Promise<DebitOutcome> {
  try {
    const debit = await deps.wallet.debit({
      idempotencyKey: op.idempotencyKey,
      holder: holderOf(op.holder),
      amount: op.amount,
      object: { objectType: 'cleaning_request', objectId: op.requestId, part: 'visit_fee' },
      description: op.label,
    });
    return { status: 'succeeded', walletTransactionId: debit.transactionId };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && FINAL_DEBIT_FAILURES.includes(code))
      return { status: 'failed', failureCode: code };
    logger.warn(`Débit des frais de visite resté en cours (${typeof code === 'string' ? code : 'erreur'})`);
    return { status: 'unknown' };
  }
}

/** Envoie un remboursement « en cours » puis enregistre son issue ; une panne le laisse en cours. */
export async function sendRefund(deps: CleaningDeps, op: WalletOperationRecord, now: Date): Promise<void> {
  try {
    await deps.wallet.refund({ transactionId: op.walletTransactionId as string, reason: op.label });
    await deps.cases.completeWalletOperation(
      op.id,
      { status: 'succeeded', walletTransactionId: op.walletTransactionId, failureCode: null },
      now,
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    logger.warn(
      `Remboursement des frais de visite resté en cours (${typeof code === 'string' ? code : 'erreur'})`,
    );
  }
}

/** Envoie les remboursements décidés dans une transaction, après son engagement. */
export async function sendRefunds(
  deps: CleaningDeps,
  ops: readonly WalletOperationRecord[],
  now: Date,
): Promise<void> {
  for (const op of ops) if (op.kind === 'credit') await sendRefund(deps, op, now);
}

/**
 * Issue d'un débit de frais de visite, relue sur le dossier à jour. Réussi : frais payés, demande
 * « visite à planifier », événement `visit_fee_paid` (et `request.submitted` pour le débit de
 * l'envoi, R-FV-02). Échoué : l'opération est close, la demande attend le paiement. Une demande
 * close entre-temps (frais impayés à l'échéance) : le débit est aussitôt remboursé (rien n'est dû).
 */
export async function applyDebitOutcome(
  deps: CleaningDeps,
  op: WalletOperationRecord,
  outcome: DebitOutcome,
  now: Date,
): Promise<CaseRecord | null> {
  if (outcome.status === 'unknown') return null;
  const record = await deps.cases.findCase(op.requestId);
  if (!record) return null;
  const fee = record.fees.find((item) => item.id === op.visitFeeId);
  const announce = fee?.rank === 1 && op.attempt === 1;
  const events: OutboxMessage[] = announce
    ? [await submittedEvent(deps, record, outcome.status === 'succeeded')]
    : [];
  const completion = {
    status: outcome.status,
    walletTransactionId: outcome.status === 'succeeded' ? outcome.walletTransactionId : null,
    failureCode: outcome.status === 'failed' ? outcome.failureCode : null,
  };
  if (outcome.status === 'failed' || !fee) {
    const done = await deps.cases.completeWalletOperation(op.id, completion, now);
    if (done && events.length) {
      await saveCase(deps, record, record.request.version, { changes: { events, audit: [] } });
    }
    return record;
  }
  let paid: ReturnType<typeof payVisitFee> | null = null;
  try {
    paid = payVisitFee(fee, record.request.status, now);
  } catch (error) {
    if (!(error instanceof DomainRuleError)) throw error;
  }
  const done = await deps.cases.completeWalletOperation(op.id, completion, now);
  if (!done) return record;
  if (!paid) {
    // Débit arrivé sur une demande qui n'attend plus ces frais : rendu aussitôt (R-FV-06).
    const refund = newRefund(deps, record, { ...fee, status: 'paid' }, [{ ...op, ...completion }], null, now);
    if (refund) {
      await saveCase(deps, record, record.request.version, {
        changes: {
          events,
          audit: [
            audit(SYSTEM_ACTOR, 'money.visit_fee_refunded', 'visit_fee', fee.id, now, { amount: fee.amount }),
          ],
        },
        walletOperations: [refund],
      });
      await sendRefund(deps, refund, now);
    }
    return record;
  }
  const next: CaseRecord = {
    ...record,
    request: { ...record.request, status: paid.requestStatus, updatedAt: now },
    fees: record.fees.map((item) => (item.id === fee.id ? paid.fee : item)),
  };
  events.push({
    type: 'cleaning.request.visit_fee_paid',
    payload: {
      ...caseParty(record.request),
      visitFeeId: fee.id,
      rank: fee.rank,
      amount: money(fee.amount),
      invoiceId: null,
      paidAt: iso(now),
    },
  });
  return saveCase(deps, next, record.request.version, {
    changes: {
      events,
      audit: [
        audit(op.createdBy ?? SYSTEM_ACTOR, 'money.visit_fee_debited', 'visit_fee', fee.id, now, {
          amount: fee.amount,
          requestId: record.request.id,
        }),
      ],
    },
  });
}

export async function submittedEvent(
  deps: CleaningDeps,
  record: CaseRecord,
  paid: boolean,
): Promise<OutboxMessage> {
  const fee = record.fees.find((item) => item.rank === 1);
  const names = await catalogNames(deps, record.request.placeTypeId, record.request.cleaningTypeIds);
  return {
    type: 'cleaning.request.submitted',
    payload: {
      ...caseParty(record.request),
      placeTypeId: record.request.placeTypeId,
      cleaningTypeIds: record.request.cleaningTypeIds,
      visitFee: money(fee?.amount ?? 0),
      visitFeeStatus: paid ? 'paid' : 'awaiting_payment',
      submittedAt: iso(record.request.createdAt),
      communeKey: record.request.communeKey,
      ...names,
    },
  };
}

/** Débit d'un frais en attente : opération écrite, envoyée, issue appliquée. */
export async function debitVisitFee(
  deps: CleaningDeps,
  record: CaseRecord,
  fee: VisitFee,
  actorId: string | null,
  now: Date,
): Promise<{ outcome: DebitOutcome; record: CaseRecord }> {
  const operations = await deps.cases.walletOperations(record.request.id);
  const pending = operations.find(
    (op) => op.visitFeeId === fee.id && op.kind === 'debit' && op.status === 'pending',
  );
  const op = pending ?? newDebit(deps, record, fee, operations, actorId, now);
  if (!pending) {
    record = await saveCase(deps, record, record.request.version, {
      changes: { events: [], audit: [] },
      walletOperations: [op],
    });
  }
  const outcome = await sendDebit(deps, op);
  const applied = await applyDebitOutcome(deps, op, outcome, now);
  return { outcome, record: applied ?? record };
}

/** Frais à rendre à la clôture d'un dossier : opérations « en cours » à écrire et à envoyer. */
export async function refundsFor(
  deps: CleaningDeps,
  record: CaseRecord,
  before: readonly VisitFee[],
  after: readonly VisitFee[],
  actorId: string | null,
  now: Date,
): Promise<WalletOperationRecord[]> {
  const refunded = after.filter(
    (fee) => fee.status === 'refunded' && before.find((old) => old.id === fee.id)?.status === 'paid',
  );
  if (!refunded.length) return [];
  const operations = await deps.cases.walletOperations(record.request.id);
  return refunded
    .map((fee) => newRefund(deps, record, fee, operations, actorId, now))
    .filter((op): op is WalletOperationRecord => op !== null);
}
