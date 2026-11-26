import { isLocalDay, localInstant } from '../../domain/calendar';
import { isCommissionDueOnDirectPayment } from '../../domain/case';
import { FIXED_RULES } from '../../domain/settings';
import { creditorWriter, requireCaseInScope, requireOwnCase } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import {
  agentActor,
  amountDue,
  creditorActor,
  evidenceEntry,
  requireIdempotencyKey,
  requirePage,
  stableId,
  SYSTEM,
} from '../cases/case-rules';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import { type CaseView } from '../cases/case-views';
import { type CaseDocumentData, noChanges } from '../cases/ports';
import { CRITICAL_MFA_SECONDS, currentCreditor, requireStaff } from '../shared/access';
import { formatXof, RecoveryErrors } from '../shared/errors';
import { CollectionService } from './collections.service';
import { type CollectionRecord, type RemittanceRecord } from './money.ports';
import { MoneyErrors, type MoneyDeps, optionalText, overpaidBalance } from './money-rules';
import { moneyCaseView, type MoneyCaseView, withMoney } from './money-views';
import {
  FINANCE_ROLES,
  optionalFileId,
  requireAmount,
  requireReceivedOn,
} from './offline-payments.use-cases';

/** Consommateur de `payment.link.paid` (inbox). */
export const PAYMENT_LINK_PAID_CONSUMER = 'recovery.payment.link.paid';
/** Objet payable des liens du recouvrement (ADR-060, point 7). */
export const PAYMENT_REQUEST_SUBJECT = 'recovery_payment_request';

/**
 * Lien de paiement payé (`payment.link.paid`, ADR-040) : l'argent reçu est toujours enregistré, même
 * sur un lien révoqué ou expiré entre-temps, ou sur un dossier déjà soldé (trop-perçu). Idempotent
 * (inbox et référence `payment:<id>`). Les autres objets payables ne regardent pas recovery.
 */
export class RecordLinkPaymentUseCase {
  private readonly collections: CollectionService;

  constructor(private readonly deps: MoneyDeps) {
    this.collections = new CollectionService(deps);
  }

  async execute(input: {
    eventId: string;
    paymentId: string;
    subjectType: string;
    subjectId: string;
    amount: number;
    providerReference: string | null;
    paidAt: string;
  }): Promise<'recorded' | 'duplicate' | 'ignored'> {
    if (input.subjectType !== PAYMENT_REQUEST_SUBJECT) return 'ignored';
    const inbox = { eventId: input.eventId, consumer: PAYMENT_LINK_PAID_CONSUMER };
    const request = await this.deps.money.paymentRequest(input.subjectId);
    if (!request) {
      await this.deps.money.markProcessed(inbox);
      return 'ignored';
    }
    const paidAt = new Date(input.paidAt);
    const outcome = await this.collections.collect({
      caseId: request.caseId,
      source: 'payment_link',
      reference: `payment:${input.paymentId}`,
      gross: input.amount,
      receivedAt: paidAt,
      actor: SYSTEM,
      recordedBy: null,
      receipt: { method: 'mobile_money', reference: input.providerReference || input.paymentId },
      writes: () => ({ paymentRequests: [{ ...request, status: 'paid', paidAt }] }),
      summary: 'Paiement reçu par le lien du débiteur',
      inbox,
    });
    if (outcome.created && request.settlementId) {
      // Remise payée (R4) : exécutée par son propre service ; un échec n'annule pas l'encaissement.
      try {
        await this.deps.settlementTerms.paid({
          settlementId: request.settlementId,
          caseId: request.caseId,
          collectionId: outcome.collection.id,
          at: paidAt,
        });
      } catch {
        // Reprise à la main ou par R4 : l'encaissement est enregistré.
      }
    }
    return outcome.created ? 'recorded' : 'duplicate';
  }
}

/**
 * Paiement reçu directement par le créancier (DeclareDirectPayment, R-PR-07) : imputé comme tout
 * encaissement, rien n'est crédité ; la commission lui est facturée par billing (`invoiced`). Après
 * l'arrêt du dossier (R-PR-06, lot R5), il se déclare encore : commissionné s'il est reçu dans les
 * 30 jours qui suivent l'arrêt. Rejoué avec la même clé, il rend l'encaissement enregistré.
 */
export class DeclareDirectPaymentUseCase {
  private readonly collections: CollectionService;

  constructor(private readonly deps: MoneyDeps) {
    this.collections = new CollectionService(deps);
  }

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    amount: number | null;
    receivedOn: string;
    note: string;
    proofFileId: string;
  }): Promise<{ view: MoneyCaseView; collection: CollectionRecord }> {
    const creditor = creditorWriter();
    const key = requireIdempotencyKey(input.idempotencyKey);
    const now = this.deps.clock.now();
    let record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    const reference = `direct:${stableId('recovery-direct-payment', record.id, key)}`;
    const known = await this.deps.money.collectionByReference(reference);
    if (known) return { view: await moneyCaseView(this.deps, record, now), collection: known };
    const stoppedAt =
      record.status === 'closed' && record.closureReason === 'abandoned_by_creditor'
        ? ((await this.deps.money.money(record.id)).closure?.closedAt ?? null)
        : null;
    if (record.status !== 'active' && record.status !== 'suspended' && !stoppedAt) {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier n’est pas en cours de recouvrement.');
    }
    const amount = requireAmount('amount', input.amount);
    const due = amountDue(record);
    if (amount > due) throw MoneyErrors.amountInvalid(due);
    const receivedAt = requireReceivedOn('receivedOn', input.receivedOn, now);
    const commissionDue = isCommissionDueOnDirectPayment(
      stoppedAt,
      receivedAt,
      FIXED_RULES.directPaymentCommissionDays,
    );
    const note = optionalText('note', input.note, 1000);
    const proofFileId = optionalFileId('proofFileId', input.proofFileId);
    const documents: CaseDocumentData[] = [];
    if (proofFileId && !record.documents.some((document) => document.fileId === proofFileId)) {
      await this.deps.files.attach({
        fileId: proofFileId,
        subject: caseSubject(record.id),
        ownerId: creditor.userId,
      });
      documents.push({
        id: stableId('recovery-direct-proof', reference),
        kind: 'evidence',
        label: 'Preuve d’un paiement reçu directement',
        fileId: proofFileId,
        documentId: null,
        visibleToPartner: false,
        visibleToDebtor: false,
        addedBy: creditorActor(creditor.userId),
        addedAt: now,
      });
    }
    const outcome = await this.collections.collect({
      caseId: record.id,
      source: 'direct_to_creditor',
      reference,
      gross: amount,
      receivedAt,
      actor: creditorActor(creditor.userId),
      recordedBy: creditor.userId,
      receipt: null,
      proofFileId,
      note,
      documents,
      commissionDue,
      summary: 'Paiement reçu directement par le créancier, déclaré par lui',
    });
    record = outcome.record;
    return { view: await moneyCaseView(this.deps, record, now), collection: outcome.collection };
  }
}

/** Borne d'une période : jour « AAAA-MM-JJ » (heure du Bénin) ou instant ISO 8601 ; vide : sans borne. */
function periodBound(field: string, value: string, end: boolean): Date | null {
  const text = value?.trim() ?? '';
  if (!text) return null;
  if (isLocalDay(text)) {
    const start = localInstant(text, 0);
    return end ? new Date(start.getTime() + 86_400_000 - 1) : start;
  }
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) throw RecoveryErrors.invalid(field, 'Date « AAAA-MM-JJ » attendue.');
  return instant;
}

/**
 * Encaissements crédités au portefeuille du créancier (ListMyRemittances) : net, commission, par
 * dossier, les plus récents d'abord. Un membre lecteur de l'organisation les consulte aussi.
 */
export class ListMyRemittancesUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(input: {
    caseId: string;
    from: string;
    to: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: RemittanceRecord[]; nextCursor: string | null }> {
    const creditor = currentCreditor();
    const page = requirePage(input.page);
    let caseId: string | null = null;
    if (input.caseId) {
      caseId = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor).id;
    }
    const from = periodBound('from', input.from, false);
    const to = periodBound('to', input.to, true);
    if (from && to && from > to)
      throw RecoveryErrors.invalid('to', 'La fin de la période précède son début.');
    return this.deps.money.remittances(creditor.holder, { caseId, from, to }, page);
  }
}

/**
 * Trop-perçu remboursé à la main par la finance (RecordOverpaymentRefund, ADR-060 point 9) : référence
 * du virement ou du transfert Mobile Money ; jamais plus que le trop-perçu à rembourser. Idempotent par
 * (auteur, clé).
 */
export class RecordOverpaymentRefundUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    amount: number | null;
    reference: string;
    note: string;
  }): Promise<MoneyCaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(FINANCE_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const known = await this.deps.money.refundByKey(staff.userId, key);
    if (known) {
      if (known.caseId !== record.id) throw RecoveryErrors.keyReused();
      return moneyCaseView(this.deps, record, now);
    }
    const amount = requireAmount('amount', input.amount);
    const balance = overpaidBalance(await this.deps.money.money(record.id));
    if (amount > balance) {
      throw MoneyErrors.amountInvalid(
        balance,
        `Le remboursement ne peut dépasser le trop-perçu à rembourser (${formatXof(balance)}).`,
      );
    }
    const reference = optionalText('reference', input.reference, 100);
    if (!reference)
      throw RecoveryErrors.invalid('reference', 'Référence du virement ou du transfert obligatoire.');
    const note = optionalText('note', input.note, 1000);
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, agentActor(staff.userId), {
        action: 'overpayment.refunded',
        kind: 'payment',
        summary: `Trop-perçu de ${formatXof(amount)} remboursé au débiteur par la finance`,
        amount,
      }),
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'overpayment.refunded',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { amount, refundId: stableId('recovery-overpayment-refund', staff.userId, key) },
    });
    const outcome = await this.deps.money.commit(
      record,
      {
        refunds: [
          {
            id: stableId('recovery-overpayment-refund', staff.userId, key),
            caseId: record.id,
            amount,
            reference,
            note,
            recordedBy: staff.userId,
            idempotencyKey: key,
            recordedAt: now,
          },
        ],
      },
      changes,
    );
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    return moneyCaseView(this.deps, { ...record, version: record.version + 1 }, now);
  }
}

/**
 * Reprise des effets de l'argent (tâche planifiée) : encaissements à créditer ou sans reçu, clôtures
 * à terminer. Sans appelant : appelée par la tâche, jamais par une route.
 */
export class ResumeMoneyEffectsUseCase {
  private readonly collections: CollectionService;

  constructor(deps: MoneyDeps) {
    this.collections = new CollectionService(deps);
  }

  execute(limit = 50): Promise<{ settled: number; closed: number; failed: number }> {
    return this.collections.resume(limit);
  }
}

/**
 * Argent d'une fiche déjà lue par son cas d'usage (GetCase, GetMyCase), qui en a vérifié l'accès :
 * encaissements, contestations, clôture et trop-perçu ajoutés à la vue.
 */
export class AddCaseMoneyUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  execute(view: CaseView): Promise<MoneyCaseView> {
    return withMoney(this.deps, view);
  }
}
