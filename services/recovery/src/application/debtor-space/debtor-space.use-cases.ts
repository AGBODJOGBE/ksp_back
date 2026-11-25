import { AppError } from '@ksp/platform';
import { isWithinContactWindow } from '../../domain/contact-policy';
import { type PlanScale } from '../../domain/payment-plan';
import { UUID } from '../cases/case-input';
import {
  amountDue,
  effectiveScale,
  evidenceEntry,
  requireIdempotencyKey,
  stableId,
} from '../cases/case-rules';
import { type CaseAmountsView, displayNames } from '../cases/case-views';
import { persist } from '../cases/case-writes';
import { CaseErrors } from '../cases/case-errors';
import {
  type CaseDocumentData,
  type EvidenceActor,
  noChanges,
  type RecoveryCaseRecord,
} from '../cases/ports';
import { loadSettings } from '../settings.use-cases';
import { RecoveryErrors } from '../shared/errors';
import { formatXof } from '../shared/errors';
import { type CollectionSource } from '../../domain/collection';
import { type DisputeRecord, type PaymentRequestRecord } from '../money/money.ports';
import { MoneyErrors, type MoneyDeps, optionalText, overpaidBalance } from '../money/money-rules';
import { PAYMENT_REQUEST_SUBJECT } from '../money/money.use-cases';
import { requireAmount } from '../money/offline-payments.use-cases';
import { type UploadSlot } from './debtor-space.ports';

/**
 * Espace du débiteur sans compte (partie 7, UC-RC-10, 11, 13 ; ADR-061). Chaque méthode reçoit le
 * dossier et le débiteur de la session, vérifiée par le contrôleur avant tout le reste : le débiteur ne
 * voit que son dossier (R-DB-01), du créancier son seul nom, et jamais les coordonnées des autres.
 */
export interface DebtorScope {
  caseId: string;
  debtorId: string;
}

/** Durée de validité d'un lien de paiement demandé par le débiteur. */
export const PAYMENT_LINK_HOURS = 72;
/** Pièces qu'un débiteur peut envoyer pour un dossier. */
export const MAX_DEBTOR_FILES = 20;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Horizon d'une demande de rappel. */
const CALLBACK_HORIZON_DAYS = 30;

export const debtorActor = (debtorId: string): EvidenceActor => ({ type: 'debtor', id: debtorId });

/** Dossier de la session : un dossier clos ou refusé ferme déjà la session (ADR-061). */
async function sessionCase(deps: MoneyDeps, scope: DebtorScope): Promise<RecoveryCaseRecord> {
  const record = await deps.cases.find(scope.caseId);
  if (!record || !record.debtors.some((debtor) => debtor.id === scope.debtorId))
    throw CaseErrors.caseNotFound();
  return record;
}

/** Canal d'un paiement montré au débiteur (`DebtorPayment.channel`). */
const PAYMENT_CHANNELS: Record<CollectionSource, string> = {
  payment_link: 'online',
  offline_cash: 'cash',
  offline_transfer: 'transfer',
  partner: 'partner',
  direct_to_creditor: 'creditor',
};

export interface DebtorPaymentView {
  amount: number;
  paidAt: Date;
  channel: string;
  receiptDocumentId: string | null;
}

export interface DebtorCaseView {
  caseNumber: string;
  creditorName: string;
  nature: string;
  references: string[];
  amounts: CaseAmountsView;
  payments: DebtorPaymentView[];
  documents: CaseDocumentData[];
  planScale: PlanScale;
  status: string;
  disputes: DisputeRecord[];
  pendingPaymentUrl: string;
  certificateDocumentId: string;
}

/**
 * Situation du débiteur (GetDebtorCase) : créancier (nom seulement), nature et références, montant dû
 * détaillé, paiements et reçus, pièces choisies par KSP, barème du simulateur, ses contestations, lien
 * de paiement en cours. L'échéancier et la remise autorisée viennent avec le lot R4.
 */
export class GetDebtorCaseUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(scope: DebtorScope): Promise<DebtorCaseView> {
    const now = this.deps.clock.now();
    const record = await sessionCase(this.deps, scope);
    const [{ settings }, money, collections, disputes, requests, names] = await Promise.all([
      loadSettings(this.deps.settings),
      this.deps.money.money(record.id),
      this.deps.money.collections(record.id),
      this.deps.money.disputes(record.id),
      this.deps.money.activePaymentRequests(record.id),
      displayNames(this.deps.directory, [record.creditor], []),
    ]);
    const pending = requests.find(
      (request) => request.debtorId === scope.debtorId && request.expiresAt > now && request.paymentUrl,
    );
    return {
      caseNumber: record.number,
      creditorName: names.holder(record.creditor),
      nature: record.nature,
      references: record.claims.map((claim) => claim.reference),
      amounts: {
        principal: record.principal,
        interests: record.interests,
        costs: record.costs,
        paid: record.paid,
        waived: 0,
        due: amountDue(record),
        overpaid: overpaidBalance(money),
      },
      payments: collections.map((collection) => ({
        amount: collection.gross,
        paidAt: collection.collectedAt,
        channel: PAYMENT_CHANNELS[collection.source],
        receiptDocumentId: collection.receiptDocumentId,
      })),
      documents: record.documents.filter((document) => document.visibleToDebtor),
      planScale: effectiveScale(record, settings),
      status: record.status,
      disputes: disputes.filter(
        (dispute) => dispute.debtorId === null || dispute.debtorId === scope.debtorId,
      ),
      pendingPaymentUrl: pending?.paymentUrl ?? '',
      certificateDocumentId: money.closure?.certificateDocumentId ?? '',
    };
  }
}

/**
 * Paiement de la totalité ou d'un montant libre (CreateDebtorPayment, UC-RC-11 ; ADR-060 point 7) : un
 * lien de paiement de ce montant, plafonné au montant dû ; les liens précédents encore payables sont
 * révoqués avant (un seul lien payable). Rejoué avec la même clé, il rend le même lien.
 */
export class CreateDebtorPaymentUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(
    input: DebtorScope & { idempotencyKey: string; amount: number | null; settlementId: string },
  ): Promise<{ url: string; amount: number; expiresAt: Date }> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = await sessionCase(this.deps, input);
    const known = await this.deps.money.paymentRequestByKey(record.id, key);
    if (known) {
      if (known.debtorId !== input.debtorId || (input.amount !== null && known.amount !== input.amount)) {
        throw RecoveryErrors.keyReused();
      }
      return { url: known.paymentUrl ?? '', amount: known.amount, expiresAt: known.expiresAt };
    }
    if (record.status === 'suspended') throw MoneyErrors.caseSuspended();
    if (record.status !== 'active') {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier n’attend plus de paiement.');
    }
    const now = this.deps.clock.now();
    const due = amountDue(record);
    let settlementId: string | null = null;
    let amount: number;
    if (input.settlementId) {
      // Remise pour paiement immédiat (R-PR-05, R4) : le montant est celui de la remise.
      const settlement = UUID.test(input.settlementId)
        ? await this.deps.settlementTerms.payable({
            caseId: record.id,
            settlementId: input.settlementId.toLowerCase(),
            at: now,
          })
        : null;
      if (!settlement || settlement.caseId !== record.id) {
        throw RecoveryErrors.invalid('settlementId', 'Aucune remise n’est proposée sur ce dossier.');
      }
      if (input.amount !== null && input.amount !== settlement.payNow) {
        throw MoneyErrors.amountInvalid(
          settlement.payNow,
          `Le montant de la remise est de ${formatXof(settlement.payNow)}.`,
        );
      }
      settlementId = settlement.id;
      amount = settlement.payNow;
    } else {
      amount = requireAmount('amount', input.amount);
    }
    if (amount > due) throw MoneyErrors.amountInvalid(due);

    const revoked: PaymentRequestRecord[] = [];
    for (const previous of await this.deps.money.activePaymentRequests(record.id)) {
      if (previous.paymentLinkId) {
        const link = await this.deps.paymentLinks.revoke(previous.paymentLinkId, 'replaced');
        if (link.status === 'paid') throw MoneyErrors.paymentInFlight();
      }
      revoked.push({ ...previous, status: 'revoked' });
    }

    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const requestId = stableId('recovery-payment-request', record.id, input.debtorId, key);
    const expiresAt = new Date(now.getTime() + PAYMENT_LINK_HOURS * 3_600_000);
    const link = await this.deps.paymentLinks.create({
      idempotencyKey: `recovery:payment-request:${requestId}`,
      subjectType: PAYMENT_REQUEST_SUBJECT,
      subjectId: requestId,
      reference: record.number,
      beneficiaryName: (names.holder(record.creditor) || 'Groupe KSP').slice(0, 100),
      description: `Dossier de recouvrement ${record.number}`,
      amount,
      expiresAt,
    });
    const request: PaymentRequestRecord = {
      id: requestId,
      caseId: record.id,
      debtorId: input.debtorId,
      amount,
      status: 'active',
      paymentLinkId: link.id,
      paymentUrl: link.url,
      requestedBy: 'debtor',
      installmentId: null,
      settlementId,
      idempotencyKey: key,
      expiresAt: new Date(link.expiresAt || expiresAt.toISOString()),
      paidAt: null,
      createdAt: now,
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, debtorActor(input.debtorId), {
        action: 'payment_link.created',
        kind: 'payment',
        summary: `Lien de paiement de ${formatXof(amount)} demandé par le débiteur${revoked.length > 0 ? ' ; le lien précédent est révoqué' : ''}`,
        amount,
      }),
    );
    const outcome = await this.deps.money.commit(record, { paymentRequests: [...revoked, request] }, changes);
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    return { url: request.paymentUrl ?? '', amount, expiresAt: request.expiresAt };
  }
}

/**
 * Pièce envoyée par le débiteur pour sa contestation (CreateDebtorUpload) : file déclare le fichier
 * pour lui (finalité `recovery_debtor_evidence`), rattaché au dossier, et rend l'adresse d'envoi.
 */
export class CreateDebtorUploadUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(
    input: DebtorScope & { fileName: string; contentType: string; sizeBytes: number },
  ): Promise<UploadSlot> {
    const record = await sessionCase(this.deps, input);
    const fileName = input.fileName?.trim() ?? '';
    if (fileName.length < 1 || fileName.length > 255)
      throw RecoveryErrors.invalid('fileName', '1 à 255 caractères.');
    const contentType = input.contentType?.trim() ?? '';
    if (contentType.length < 3 || contentType.length > 100) {
      throw RecoveryErrors.invalid('contentType', 'Type MIME attendu.');
    }
    const size = Number(input.sizeBytes);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw RecoveryErrors.invalid('sizeBytes', 'Taille de 1 octet à 10 Mo.');
    }
    const sent = record.documents.filter((document) => document.addedBy.id === input.debtorId).length;
    if (sent >= MAX_DEBTOR_FILES) {
      throw RecoveryErrors.invalid('fileName', `${MAX_DEBTOR_FILES} pièces au plus par dossier.`);
    }
    return this.deps.debtorUploads.create({ caseId: record.id, fileName, contentType, sizeBytes: size });
  }
}

/**
 * Confirmation d'une pièce envoyée (CompleteDebtorUpload) : file vérifie le contenu ; disponible, la
 * pièce rejoint le dossier (`dispute_evidence`), prête à être jointe à une contestation.
 */
export class CompleteDebtorUploadUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(input: DebtorScope & { fileId: string }): Promise<{ fileId: string; status: string }> {
    if (!UUID.test(input.fileId ?? '')) throw RecoveryErrors.invalid('fileId', 'Ce fichier est introuvable.');
    const fileId = input.fileId.toLowerCase();
    const record = await sessionCase(this.deps, input);
    if (record.documents.some((document) => document.fileId === fileId))
      return { fileId, status: 'available' };
    const file = await this.deps.debtorUploads.complete(fileId);
    if (file.status === 'rejected') return { fileId, status: 'rejected' };
    if (file.subject?.type !== 'recovery_case' || file.subject.id !== record.id) {
      throw RecoveryErrors.invalid('fileId', 'Ce fichier est introuvable.');
    }
    if (file.status !== 'available') {
      throw AppError.precondition(
        'FILE_NOT_UPLOADED',
        'Le contenu n’est pas encore reçu : envoyez-le puis confirmez.',
      );
    }
    const now = this.deps.clock.now();
    const document: CaseDocumentData = {
      id: stableId('recovery-debtor-file', fileId),
      kind: 'dispute_evidence',
      label: (file.fileName || 'Pièce du débiteur').slice(0, 200),
      fileId,
      documentId: null,
      visibleToPartner: false,
      visibleToDebtor: true,
      addedBy: debtorActor(input.debtorId),
      addedAt: now,
    };
    const next = { ...record, documents: [...record.documents, document] };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, debtorActor(input.debtorId), {
        action: 'document.added',
        kind: 'document',
        summary: 'Pièce envoyée par le débiteur',
        ref: { type: 'file', id: fileId },
      }),
    );
    await persist(this.deps.cases, next, changes, { now });
    return { fileId, status: 'available' };
  }
}

/**
 * Demande de rappel (RequestDebtorCallback) : un créneau à venir, dans les plages de contact du
 * débiteur, au plus 30 jours ; un seul rappel en attente à la fois. Le message est chiffré en base.
 */
export class RequestDebtorCallbackUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(
    input: DebtorScope & { preferredFrom: string; preferredTo: string; message: string },
  ): Promise<{ requestedAt: Date }> {
    const now = this.deps.clock.now();
    const record = await sessionCase(this.deps, input);
    if (record.status !== 'active' && record.status !== 'suspended') {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier n’est plus suivi.');
    }
    const from = new Date(input.preferredFrom ?? '');
    const to = new Date(input.preferredTo ?? '');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw RecoveryErrors.invalid('preferredFrom', 'Créneau ISO 8601 : début avant la fin.');
    }
    if (from <= now || from.getTime() > now.getTime() + CALLBACK_HORIZON_DAYS * 86_400_000) {
      throw RecoveryErrors.invalid(
        'preferredFrom',
        `Créneau à venir, dans les ${CALLBACK_HORIZON_DAYS} jours.`,
      );
    }
    if (to.getTime() - from.getTime() > 12 * 3_600_000) {
      throw RecoveryErrors.invalid('preferredTo', 'Créneau de 12 heures au plus.');
    }
    const { settings } = await loadSettings(this.deps.settings);
    if (
      !isWithinContactWindow(from, settings.contactWindow) ||
      !isWithinContactWindow(new Date(to.getTime() - 1), settings.contactWindow)
    ) {
      throw RecoveryErrors.invalid(
        'preferredFrom',
        `Créneau dans les plages de contact (${settings.contactWindow.start} – ${settings.contactWindow.end}).`,
      );
    }
    const message = optionalText('message', input.message, 500);
    const pending = await this.deps.money.pendingCallbacks(record.id);
    if (pending.some((callback) => callback.debtorId === input.debtorId && callback.slotEnd > now)) {
      throw CaseErrors.invalidTransition(
        record.status,
        'Un rappel est déjà prévu : le chargé vous appellera.',
      );
    }
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, debtorActor(input.debtorId), {
        action: 'callback.requested',
        kind: 'contact',
        summary: `Rappel demandé par le débiteur, entre ${from.toISOString()} et ${to.toISOString()}`,
      }),
    );
    const outcome = await this.deps.money.commit(
      record,
      {
        callbacks: [
          {
            id: this.deps.ids.next(),
            caseId: record.id,
            debtorId: input.debtorId,
            slotStart: from,
            slotEnd: to,
            message,
            status: 'pending',
            createdAt: now,
          },
        ],
      },
      changes,
    );
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    return { requestedAt: now };
  }
}

/**
 * Adresse de lecture de courte durée d'une pièce montrée au débiteur (GetDebtorDocumentUrl) : reçu,
 * attestation de solde, échéancier signé (document) ou pièce choisie par KSP (file). Chaque
 * téléchargement est tracé à l'audit.
 */
export class GetDebtorDocumentUrlUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(input: DebtorScope & { documentId: string }): Promise<{ url: string; expiresAt: string }> {
    const id = input.documentId?.toLowerCase() ?? '';
    if (!UUID.test(id)) throw RecoveryErrors.invalid('documentId', 'Ce document est introuvable.');
    const record = await sessionCase(this.deps, input);
    const document = record.documents.find(
      (candidate) => candidate.visibleToDebtor && (candidate.documentId === id || candidate.fileId === id),
    );
    if (!document) throw RecoveryErrors.invalid('documentId', 'Ce document est introuvable.');
    const url = document.documentId
      ? await this.deps.documentUrls.readUrl(document.documentId)
      : await this.deps.debtorUploads.readUrl({ fileId: document.fileId!, caseId: record.id });
    await this.deps.audit.record({
      actorId: input.debtorId,
      action: 'debtor.document_downloaded',
      entityType: 'recovery_case',
      entityId: record.id,
      details: { caseDocumentId: document.id, kind: document.kind },
    });
    return url;
  }
}
