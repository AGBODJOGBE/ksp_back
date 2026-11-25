import { localDay, localInstant } from '../../domain/calendar';
import {
  COLLECTION_SOURCE,
  OFFLINE_PAYMENT_STATUSES,
  type OfflinePaymentSource,
  type OfflinePaymentStatus,
  review,
} from '../../domain/offline-payment';
import { requireCaseInScope, staffScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import {
  agentActor,
  amountDue,
  evidenceEntry,
  requireIdempotencyKey,
  requirePage,
  stableId,
} from '../cases/case-rules';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import {
  type CaseAuditEntry,
  type CaseDocumentData,
  type EvidenceActor,
  noChanges,
  type RecoveryCaseRecord,
} from '../cases/ports';
import {
  CRITICAL_MFA_SECONDS,
  BACKOFFICE_MFA_SECONDS,
  requireStaff,
  ROLES,
  type Staff,
} from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import { CollectionService } from './collections.service';
import { type CollectionRecord, type OfflinePaymentRecord, type ReceiptMethod } from './money.ports';
import { LOCAL_DAY, MoneyErrors, type MoneyDeps, optionalText } from './money-rules';
import { offlinePaymentViews, type OfflinePaymentView } from './money-views';

/** Paiements hors ligne et trop-perçus (manifeste de la gateway : finance). */
export const FINANCE_ROLES = [ROLES.finance, ROLES.superAdmin] as const;

const SOURCE_LABELS: Record<OfflinePaymentSource, string> = {
  cash: 'espèces au guichet',
  transfer: 'virement',
  partner: 'encaissement d’un partenaire',
};

const RECEIPT_METHODS: Record<OfflinePaymentSource, ReceiptMethod> = {
  cash: 'cash',
  transfer: 'bank_transfer',
  // Le partenaire vire la somme à KSP (R-HU-05).
  partner: 'bank_transfer',
};

/** Montant entier en FCFA d'une requête. */
export function requireAmount(field: string, value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value <= 0) {
    throw RecoveryErrors.invalid(field, 'Montant entier en FCFA, strictement positif.');
  }
  return value;
}

/** Jour de réception « AAAA-MM-JJ », au plus aujourd'hui (heure du Bénin). */
export function requireReceivedOn(field: string, value: string, now: Date): Date {
  const day = value?.trim() ?? '';
  if (!LOCAL_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || day > localDay(now)) {
    throw RecoveryErrors.invalid(field, 'Date « AAAA-MM-JJ », au plus aujourd’hui.');
  }
  return localInstant(day, 12);
}

/** Identifiant facultatif d'un fichier envoyé par file. */
export function optionalFileId(field: string, value: string): string | null {
  if (!value) return null;
  if (!UUID.test(value)) throw RecoveryErrors.invalid(field, 'Identifiant de fichier invalide.');
  return value.toLowerCase();
}

/** Somme déclarée à valider : tout ce qui la décrit, quel que soit son déclarant. */
export interface OfflineDeclaration {
  record: RecoveryCaseRecord;
  source: OfflinePaymentSource;
  amount: number;
  receivedAt: Date;
  reference: string | null;
  proofFileId: string | null;
  note: string | null;
  /** Déclarant : membre de la finance, ou compte du partenaire (R5). */
  recordedBy: string;
  actor: EvidenceActor;
  partnerId: string | null;
  assignmentId: string | null;
  idempotencyKey: string;
  /** Membre du personnel qui saisit (trace d'audit), null pour un partenaire. */
  staff: Staff | null;
}

/**
 * Validation à deux des sommes reçues hors du lien de paiement (R-EN-01, R-AR-03, R-HU-05 ; ADR-060,
 * point 8), commune à toutes les origines : saisie par la finance (espèces, virement) ou déclarée par
 * un huissier ou un avocat depuis son accès (R5), puis validée ou refusée par une autre personne de la
 * finance, double authentification récente. L'encaissement n'est imputé et crédité qu'à la validation,
 * par le service d'encaissement.
 */
export class OfflinePayments {
  private readonly collections: CollectionService;

  constructor(private readonly deps: MoneyDeps) {
    this.collections = new CollectionService(deps);
  }

  /** Saisie en attente de validation ; rejouée avec la même clé par le même auteur, rendue telle quelle. */
  async declare(input: OfflineDeclaration): Promise<OfflinePaymentRecord> {
    const known = await this.deps.money.offlinePaymentByKey(input.recordedBy, input.idempotencyKey);
    if (known) {
      if (known.caseId !== input.record.id || known.amount !== input.amount) throw RecoveryErrors.keyReused();
      return known;
    }
    const record = input.record;
    if (record.status === 'suspended') throw MoneyErrors.caseSuspended();
    if (record.status !== 'active') {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier ne reçoit pas de paiement.');
    }
    const due = amountDue(record);
    if (input.amount > due) throw MoneyErrors.amountInvalid(due);
    const now = this.deps.clock.now();
    const payment: OfflinePaymentRecord = {
      id: stableId('recovery-offline-payment', input.recordedBy, input.idempotencyKey),
      caseId: record.id,
      source: input.source,
      amount: input.amount,
      receivedAt: input.receivedAt,
      reference: input.reference,
      proofFileId: input.proofFileId,
      note: input.note,
      recordedBy: input.recordedBy,
      partnerId: input.partnerId,
      assignmentId: input.assignmentId,
      status: 'pending_approval',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      collectionId: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    const documents: CaseDocumentData[] = [];
    if (input.proofFileId && !record.documents.some((document) => document.fileId === input.proofFileId)) {
      await this.deps.files.attach({
        fileId: input.proofFileId,
        subject: caseSubject(record.id),
        ownerId: input.recordedBy,
      });
      documents.push({
        id: stableId('recovery-offline-proof', payment.id),
        kind: 'evidence',
        label: 'Preuve d’un paiement hors ligne',
        fileId: input.proofFileId,
        documentId: null,
        visibleToPartner: false,
        visibleToDebtor: false,
        addedBy: input.actor,
        addedAt: now,
      });
    }
    const next = { ...record, documents: [...record.documents, ...documents] };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, input.actor, {
        action: 'offline_payment.recorded',
        kind: 'payment',
        summary: `Paiement hors ligne de ${formatXof(input.amount)} (${SOURCE_LABELS[input.source]}) saisi, en attente de validation par une deuxième personne`,
        amount: input.amount,
        internal: true,
      }),
    );
    if (input.staff) changes.audit.push(this.audit(input.staff, 'offline_payment.recorded', payment, now));
    const outcome = await this.deps.money.commit(next, { offlinePayments: [payment] }, changes);
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    return payment;
  }

  /**
   * Validation par une deuxième personne : la saisie devient un encaissement (imputé, commissionné,
   * crédité, reçu au débiteur) dans la même transaction. Rejouée sur une saisie déjà validée, elle
   * rend l'encaissement créé.
   */
  async approve(
    paymentId: string,
    reviewer: Staff,
  ): Promise<{ payment: OfflinePaymentRecord; collection: CollectionRecord }> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status === 'approved' && payment.collectionId && payment.reviewedBy === reviewer.userId) {
      const collection = await this.deps.money.collection(payment.collectionId);
      if (collection) return { payment, collection };
    }
    unwrap(review(payment, reviewer.userId, 'approved'));
    const now = this.deps.clock.now();
    const approved = (collection: CollectionRecord): OfflinePaymentRecord => ({
      ...payment,
      status: 'approved',
      reviewedBy: reviewer.userId,
      reviewedAt: now,
      collectionId: collection.id,
    });
    const outcome = await this.collections.collect({
      caseId: payment.caseId,
      source: COLLECTION_SOURCE[payment.source],
      reference: `offline:${payment.id}`,
      gross: payment.amount,
      receivedAt: payment.receivedAt,
      actor: agentActor(reviewer.userId),
      recordedBy: reviewer.userId,
      receipt: { method: RECEIPT_METHODS[payment.source], reference: payment.reference ?? '' },
      proofFileId: payment.proofFileId,
      note: payment.note,
      writes: (collection) => ({ offlinePayments: [approved(collection)] }),
      audit: [this.audit(reviewer, 'offline_payment.approved', payment, now)],
      summary: 'Paiement hors ligne validé par une deuxième personne',
    });
    return { payment: approved(outcome.collection), collection: outcome.collection };
  }

  /** Refus motivé par une deuxième personne : rien n'est imputé ni crédité. */
  async reject(paymentId: string, reviewer: Staff, reason: string): Promise<OfflinePaymentRecord> {
    const payment = await this.requirePayment(paymentId);
    if (payment.status === 'rejected' && payment.reviewedBy === reviewer.userId) return payment;
    unwrap(review(payment, reviewer.userId, 'rejected'));
    const record = await this.deps.cases.find(payment.caseId);
    if (!record) throw MoneyErrors.offlinePaymentNotFound();
    const now = this.deps.clock.now();
    const rejected: OfflinePaymentRecord = {
      ...payment,
      status: 'rejected',
      reviewedBy: reviewer.userId,
      reviewedAt: now,
      rejectionReason: reason,
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, agentActor(reviewer.userId), {
        action: 'offline_payment.rejected',
        kind: 'payment',
        summary: `Paiement hors ligne de ${formatXof(payment.amount)} refusé à la validation`,
        amount: payment.amount,
        internal: true,
      }),
    );
    changes.audit.push(this.audit(reviewer, 'offline_payment.rejected', payment, now));
    const outcome = await this.deps.money.commit(record, { offlinePayments: [rejected] }, changes);
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    return rejected;
  }

  private async requirePayment(paymentId: string): Promise<OfflinePaymentRecord> {
    if (!UUID.test(paymentId ?? '')) throw MoneyErrors.offlinePaymentNotFound();
    const payment = await this.deps.money.offlinePayment(paymentId.toLowerCase());
    if (!payment) throw MoneyErrors.offlinePaymentNotFound();
    return payment;
  }

  private audit(staff: Staff, action: string, payment: OfflinePaymentRecord, at: Date): CaseAuditEntry {
    return {
      actorId: staff.userId,
      action,
      entityType: 'recovery_case',
      entityId: payment.caseId,
      at,
      details: { offlinePaymentId: payment.id, amount: payment.amount, source: payment.source },
    };
  }
}

/** Saisie d'un paiement hors ligne par la finance (RecordOfflinePayment, UC-RC-22). */
export class RecordOfflinePaymentUseCase {
  private readonly payments: OfflinePayments;

  constructor(private readonly deps: MoneyDeps) {
    this.payments = new OfflinePayments(deps);
  }

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    source: string;
    amount: number | null;
    receivedOn: string;
    reference: string;
    proofFileId: string;
  }): Promise<OfflinePaymentView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(FINANCE_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    if (input.source !== 'cash' && input.source !== 'transfer') {
      throw RecoveryErrors.invalid(
        'source',
        'Valeur attendue : cash ou transfer (l’encaissement d’un partenaire est déclaré depuis son accès).',
      );
    }
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const payment = await this.payments.declare({
      record,
      source: input.source,
      amount: requireAmount('amount', input.amount),
      receivedAt: requireReceivedOn('receivedOn', input.receivedOn, now),
      reference: optionalText('reference', input.reference, 100),
      proofFileId: optionalFileId('proofFileId', input.proofFileId),
      note: null,
      recordedBy: staff.userId,
      actor: agentActor(staff.userId),
      partnerId: null,
      assignmentId: null,
      idempotencyKey: key,
      staff,
    });
    const [view] = await offlinePaymentViews(this.deps, [{ ...payment, caseNumber: record.number }]);
    return view!;
  }
}

/** Paiements hors ligne à valider (ListOfflinePayments) : « pending_approval » par défaut. */
export class ListOfflinePaymentsUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(input: {
    statuses: readonly string[];
    caseId: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: OfflinePaymentView[]; nextCursor: string | null }> {
    const now = this.deps.clock.now();
    const staff = requireStaff(FINANCE_ROLES, BACKOFFICE_MFA_SECONDS, now.getTime());
    const page = requirePage(input.page);
    const statuses = input.statuses.length > 0 ? input.statuses : ['pending_approval'];
    for (const status of statuses) {
      if (!OFFLINE_PAYMENT_STATUSES.includes(status as OfflinePaymentStatus)) {
        throw RecoveryErrors.invalid('statuses', `Valeur attendue : ${OFFLINE_PAYMENT_STATUSES.join(', ')}.`);
      }
    }
    const caseId = input.caseId ? requireCaseId(input.caseId) : null;
    const result = await this.deps.money.listOfflinePayments(
      {
        statuses: statuses as OfflinePaymentStatus[],
        caseId,
        assignedAgentId: staffScope(staff).agentId,
      },
      page,
    );
    return { items: await offlinePaymentViews(this.deps, result.items), nextCursor: result.nextCursor };
  }
}

async function offlineView(deps: MoneyDeps, payment: OfflinePaymentRecord): Promise<OfflinePaymentView> {
  const record = await deps.cases.find(payment.caseId);
  const [view] = await offlinePaymentViews(deps, [{ ...payment, caseNumber: record?.number ?? '' }]);
  return view!;
}

/** Validation par une deuxième personne de la finance (ApproveOfflinePayment). */
export class ApproveOfflinePaymentUseCase {
  private readonly payments: OfflinePayments;

  constructor(private readonly deps: MoneyDeps) {
    this.payments = new OfflinePayments(deps);
  }

  async execute(input: {
    offlinePaymentId: string;
  }): Promise<{ payment: OfflinePaymentView; collection: CollectionRecord }> {
    const now = this.deps.clock.now();
    const staff = requireStaff(FINANCE_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const result = await this.payments.approve(input.offlinePaymentId, staff);
    return { payment: await offlineView(this.deps, result.payment), collection: result.collection };
  }
}

/** Refus motivé par une deuxième personne de la finance (RejectOfflinePayment). */
export class RejectOfflinePaymentUseCase {
  private readonly payments: OfflinePayments;

  constructor(private readonly deps: MoneyDeps) {
    this.payments = new OfflinePayments(deps);
  }

  async execute(input: { offlinePaymentId: string; reason: string }): Promise<OfflinePaymentView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(FINANCE_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3 || reason.length > 500) {
      throw RecoveryErrors.invalid('reason', 'Motif écrit de 3 à 500 caractères.');
    }
    return offlineView(this.deps, await this.payments.reject(input.offlinePaymentId, staff, reason));
  }
}
