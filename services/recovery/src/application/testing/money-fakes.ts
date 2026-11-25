import { AppError } from '@ksp/platform';
import { type CommissionTotals } from '../../domain/collection';
import {
  type CaseChanges,
  type CaseDocumentData,
  type PageRequest,
  type RecoveryCaseRecord,
} from '../cases/ports';
import { type DebtorUploads, type DocumentUrls, type UploadSlot } from '../debtor-space/debtor-space.ports';
import { NO_SETTLEMENTS } from '../debtor-space/settlement-terms';
import {
  type CallbackRecord,
  type CaseMoney,
  type ClosureRecord,
  type CollectionRecord,
  creditedGross,
  type DisputeRecord,
  type MoneyStore,
  type MoneyWrites,
  type OfflinePaymentFilter,
  type OfflinePaymentRecord,
  type OverpaymentRefundRecord,
  type PaymentRequestRecord,
  type RemittanceFilter,
} from '../money/money.ports';
import {
  type Holder,
  type Notifier,
  type PaymentLink,
  type PaymentLinks,
  type WalletGateway,
} from '../ports';
import { type MemoryCaseRepository, MemoryWallet } from './case-fakes';

/** Page d'une liste en mémoire : curseur = rang du suivant. */
function paginate<T>(items: readonly T[], page: PageRequest): { items: T[]; nextCursor: string | null } {
  const start = page.cursor ? Number(page.cursor) : 0;
  const slice = items.slice(start, start + page.limit);
  return { items: slice, nextCursor: start + page.limit < items.length ? String(start + page.limit) : null };
}

/**
 * Dépôt de l'argent en mémoire, branché sur le dépôt des dossiers en mémoire : `commit` enregistre le
 * dossier par son `save` (verrou optimiste, inbox, journal, événements, audit), puis les écritures.
 */
export class MemoryMoneyStore implements MoneyStore {
  readonly totals = new Map<string, CommissionTotals>();
  readonly closures = new Map<string, ClosureRecord>();
  readonly collectionsById = new Map<string, CollectionRecord>();
  readonly paymentRequests = new Map<string, PaymentRequestRecord>();
  readonly offlinePayments = new Map<string, OfflinePaymentRecord>();
  readonly refunds = new Map<string, OverpaymentRefundRecord>();
  readonly disputesById = new Map<string, DisputeRecord>();
  readonly callbacks = new Map<string, CallbackRecord>();

  constructor(private readonly cases: MemoryCaseRepository) {}

  private write(changes: CaseChanges) {
    this.cases.evidence.push(...structuredClone(changes.evidence));
    this.cases.events.push(...structuredClone(changes.events));
    this.cases.audit.push(...structuredClone(changes.audit));
  }

  private addDocument(caseId: string, document: CaseDocumentData) {
    const stored = this.cases.cases.get(caseId);
    if (stored && !stored.documents.some((candidate) => candidate.id === document.id)) {
      stored.documents.push(structuredClone(document));
    }
  }

  async money(caseId: string): Promise<CaseMoney> {
    const collections = [...this.collectionsById.values()].filter((c) => c.caseId === caseId);
    const sum = (pick: (c: CollectionRecord) => number) =>
      collections.reduce((total, c) => total + pick(c), 0);
    return {
      totals: structuredClone(this.totals.get(caseId) ?? { base: 0, commission: 0 }),
      collected: {
        costs: sum((c) => c.allocatedCosts),
        interests: sum((c) => c.allocatedInterests),
        principal: sum((c) => c.allocatedPrincipal),
      },
      overpaid: sum((c) => c.overpaid),
      refunded: [...this.refunds.values()]
        .filter((refund) => refund.caseId === caseId)
        .reduce((total, refund) => total + refund.amount, 0),
      closure: structuredClone(this.closures.get(caseId) ?? null),
    };
  }

  async commit(
    record: RecoveryCaseRecord,
    writes: MoneyWrites,
    changes: CaseChanges,
    options: { inbox?: { eventId: string; consumer: string } } = {},
  ) {
    for (const collection of writes.collections ?? []) {
      if ([...this.collectionsById.values()].some((c) => c.reference === collection.reference))
        return 'stale' as const;
    }
    const outcome = await this.cases.save(record, changes, options.inbox ? { inbox: options.inbox } : {});
    if (outcome !== 'saved') return outcome;
    if (writes.totals) this.totals.set(record.id, structuredClone(writes.totals));
    if (writes.closure) this.closures.set(record.id, structuredClone(writes.closure));
    for (const c of writes.collections ?? []) this.collectionsById.set(c.id, structuredClone(c));
    for (const r of writes.paymentRequests ?? []) this.paymentRequests.set(r.id, structuredClone(r));
    for (const p of writes.offlinePayments ?? []) this.offlinePayments.set(p.id, structuredClone(p));
    for (const r of writes.refunds ?? []) this.refunds.set(r.id, structuredClone(r));
    for (const d of writes.disputes ?? []) this.disputesById.set(d.id, structuredClone(d));
    for (const c of writes.callbacks ?? []) this.callbacks.set(c.id, structuredClone(c));
    return outcome;
  }

  async markProcessed(inbox: { eventId: string; consumer: string }) {
    this.cases.inbox.add(`${inbox.eventId}:${inbox.consumer}`);
  }

  async collection(id: string) {
    return structuredClone(this.collectionsById.get(id) ?? null);
  }

  async collectionByReference(reference: string) {
    return structuredClone([...this.collectionsById.values()].find((c) => c.reference === reference) ?? null);
  }

  async collections(caseId: string) {
    return structuredClone(
      [...this.collectionsById.values()]
        .filter((c) => c.caseId === caseId)
        .sort((a, b) => a.collectedAt.getTime() - b.collectedAt.getTime()),
    );
  }

  async markCredited(collectionId: string, walletTransactionId: string, at: Date, changes: CaseChanges) {
    const collection = this.collectionsById.get(collectionId);
    if (!collection || collection.creditedAt) return false;
    collection.walletTransactionId = walletTransactionId;
    collection.creditedAt = at;
    this.write(changes);
    return true;
  }

  async attachReceipt(collectionId: string, document: CaseDocumentData, changes: CaseChanges) {
    const collection = this.collectionsById.get(collectionId);
    if (!collection || collection.receiptDocumentId) return false;
    collection.receiptDocumentId = document.documentId;
    this.addDocument(collection.caseId, document);
    this.write(changes);
    return true;
  }

  async pendingSettlements(limit: number) {
    return structuredClone(
      [...this.collectionsById.values()]
        .filter(
          (c) => (creditedGross(c) > 0 && !c.creditedAt) || (c.receipt !== null && !c.receiptDocumentId),
        )
        .slice(0, limit),
    );
  }

  async completeClosure(
    caseId: string,
    input: { at: Date; certificate: CaseDocumentData | null; revokedRequestIds: readonly string[] },
    changes: CaseChanges,
  ) {
    const closure = this.closures.get(caseId);
    if (!closure || closure.completedAt) return false;
    closure.completedAt = input.at;
    closure.certificateDocumentId = input.certificate?.documentId ?? null;
    if (input.certificate) this.addDocument(caseId, input.certificate);
    for (const id of input.revokedRequestIds) {
      const request = this.paymentRequests.get(id);
      if (request && request.status === 'active') request.status = 'revoked';
    }
    this.write(changes);
    return true;
  }

  async pendingClosures(limit: number) {
    return [...this.closures.entries()]
      .filter(([, closure]) => !closure.completedAt)
      .map(([caseId]) => caseId)
      .slice(0, limit);
  }

  async paymentRequest(id: string) {
    return structuredClone(this.paymentRequests.get(id) ?? null);
  }

  async paymentRequestByKey(caseId: string, key: string) {
    return structuredClone(
      [...this.paymentRequests.values()].find((r) => r.caseId === caseId && r.idempotencyKey === key) ?? null,
    );
  }

  async activePaymentRequests(caseId: string) {
    return structuredClone(
      [...this.paymentRequests.values()].filter((r) => r.caseId === caseId && r.status === 'active'),
    );
  }

  async offlinePayment(id: string) {
    return structuredClone(this.offlinePayments.get(id) ?? null);
  }

  async offlinePaymentByKey(recordedBy: string, key: string) {
    return structuredClone(
      [...this.offlinePayments.values()].find(
        (p) => p.recordedBy === recordedBy && p.idempotencyKey === key,
      ) ?? null,
    );
  }

  async listOfflinePayments(filter: OfflinePaymentFilter, page: PageRequest) {
    const items = [...this.offlinePayments.values()]
      .filter((p) => filter.statuses.includes(p.status))
      .filter((p) => !filter.caseId || p.caseId === filter.caseId)
      .filter(
        (p) =>
          !filter.assignedAgentId ||
          this.cases.cases.get(p.caseId)?.assignedAgentId === filter.assignedAgentId,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({ ...structuredClone(p), caseNumber: this.cases.cases.get(p.caseId)?.number ?? '' }));
    return paginate(items, page);
  }

  async refundByKey(recordedBy: string, key: string) {
    return structuredClone(
      [...this.refunds.values()].find((r) => r.recordedBy === recordedBy && r.idempotencyKey === key) ?? null,
    );
  }

  async disputes(caseId: string) {
    return structuredClone([...this.disputesById.values()].filter((d) => d.caseId === caseId));
  }

  async disputeByKey(caseId: string, key: string) {
    return structuredClone(
      [...this.disputesById.values()].find((d) => d.caseId === caseId && d.idempotencyKey === key) ?? null,
    );
  }

  async pendingCallbacks(caseId: string) {
    return structuredClone(
      [...this.callbacks.values()].filter((c) => c.caseId === caseId && c.status === 'pending'),
    );
  }

  async remittances(creditor: Holder, filter: RemittanceFilter, page: PageRequest) {
    const items = [...this.collectionsById.values()]
      .filter((c) => c.creditedAt !== null)
      .filter((c) => {
        const record = this.cases.cases.get(c.caseId);
        return record?.creditor.type === creditor.type && record.creditor.id === creditor.id;
      })
      .filter((c) => !filter.caseId || c.caseId === filter.caseId)
      .filter(
        (c) => (!filter.from || c.creditedAt! >= filter.from) && (!filter.to || c.creditedAt! <= filter.to),
      )
      .sort((a, b) => b.creditedAt!.getTime() - a.creditedAt!.getTime())
      .map((c) => ({
        collection: structuredClone(c),
        caseNumber: this.cases.cases.get(c.caseId)?.number ?? '',
      }));
    return paginate(items, page);
  }
}

/**
 * Portefeuille simulé, encaissements compris : le portefeuille prépayé de R2 (débits, remboursements)
 * et les encaissements crédités au créancier, idempotents par référence ; panne simulable.
 */
export class MoneyWallet implements WalletGateway {
  constructor(readonly prepaid = new MemoryWallet()) {}

  readonly collections = new Map<
    string,
    { transactionId: string; holder: Holder; gross: number; commission: number; commissionRateBps: number }
  >();
  collectionFailures = 0;
  private sequence = 0;

  get balances() {
    return this.prepaid.balances;
  }

  debit(input: Parameters<WalletGateway['debit']>[0]) {
    return this.prepaid.debit(input);
  }

  refund(input: { debitTransactionId: string; reason: string }) {
    return this.prepaid.refund(input);
  }

  balance(holder: Holder) {
    return this.prepaid.balance(holder);
  }

  async recordCollection(input: Parameters<WalletGateway['recordCollection']>[0]) {
    if (this.collectionFailures > 0) {
      this.collectionFailures -= 1;
      throw AppError.unavailable('RECOVERY_DEPENDENCY_UNAVAILABLE', 'wallet indisponible', {
        service: 'wallet',
      });
    }
    const known = this.collections.get(input.reference);
    if (known) return { transactionId: known.transactionId, created: false };
    this.sequence += 1;
    const transactionId = `0192f1c4-0000-7000-9100-${this.sequence.toString(16).padStart(12, '0')}`;
    this.collections.set(input.reference, {
      transactionId,
      holder: input.holder,
      gross: input.gross,
      commission: input.commission,
      commissionRateBps: input.commissionRateBps,
    });
    return { transactionId, created: true };
  }

  async reverseCollection(): Promise<never> {
    throw new Error('reverseCollection ne devrait pas être appelé en R3');
  }
}

/** Liens de paiement simulés comme payment : idempotents par clé, révocation sans effet sur un lien payé. */
export class MemoryPaymentLinks implements PaymentLinks {
  readonly links = new Map<string, PaymentLink & { key: string; subjectId: string }>();
  private sequence = 0;

  async create(input: Parameters<PaymentLinks['create']>[0]): Promise<PaymentLink> {
    const known = [...this.links.values()].find((link) => link.key === input.idempotencyKey);
    if (known) return this.present(known);
    this.sequence += 1;
    const id = `0192f1c4-0000-7000-9200-${this.sequence.toString(16).padStart(12, '0')}`;
    const link = {
      id,
      status: 'active',
      url: `https://ksp.bj/payer/jeton-${this.sequence}`,
      amount: input.amount,
      expiresAt: input.expiresAt.toISOString(),
      paidAt: null,
      key: input.idempotencyKey,
      subjectId: input.subjectId,
    };
    this.links.set(id, link);
    return this.present(link);
  }

  async get(linkId: string): Promise<PaymentLink> {
    return this.present(this.links.get(linkId)!);
  }

  async revoke(linkId: string): Promise<PaymentLink> {
    const link = this.links.get(linkId)!;
    if (link.status === 'active') link.status = 'revoked';
    return this.present(link);
  }

  /** Paiement reçu par le prestataire (avant l'événement). */
  markPaid(linkId: string, at: string) {
    const link = this.links.get(linkId)!;
    link.status = 'paid';
    link.paidAt = at;
  }

  private present(link: PaymentLink): PaymentLink {
    return {
      id: link.id,
      status: link.status,
      url: link.url,
      amount: link.amount,
      expiresAt: link.expiresAt,
      paidAt: link.paidAt,
    };
  }
}

/** Messages directs au débiteur simulés : un envoi par clé. */
export class MemoryNotifier implements Notifier {
  readonly sent = new Map<string, Parameters<Notifier['sendToDebtor']>[0]>();

  async sendToDebtor(input: Parameters<Notifier['sendToDebtor']>[0]) {
    this.sent.set(input.idempotencyKey, structuredClone(input));
    return { notificationId: `notification-${this.sent.size}`, status: 'queued' };
  }
}

/** Pièces du débiteur simulées comme file : déclarées, confirmées (ou rejetées), lues. */
export class MemoryDebtorUploads implements DebtorUploads {
  readonly files = new Map<
    string,
    { caseId: string; fileName: string; status: 'pending' | 'available' | 'rejected' }
  >();
  /** Prochaines confirmations rejetées (contenu refusé par file). */
  rejectNext = 0;
  private sequence = 0;

  async create(input: { caseId: string; fileName: string }): Promise<UploadSlot> {
    this.sequence += 1;
    const fileId = `0192f1c4-0000-7000-9300-${this.sequence.toString(16).padStart(12, '0')}`;
    this.files.set(fileId, { caseId: input.caseId, fileName: input.fileName, status: 'pending' });
    return {
      fileId,
      url: `https://files.ksp.bj/upload/${fileId}`,
      expiresAt: '2026-11-20T09:15:00.000Z',
      headers: { 'Content-Type': 'application/pdf' },
    };
  }

  async complete(fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw AppError.notFound('FILE_NOT_FOUND', 'Fichier introuvable.');
    if (this.rejectNext > 0) {
      this.rejectNext -= 1;
      file.status = 'rejected';
    } else if (file.status === 'pending') {
      file.status = 'available';
    }
    return {
      fileId,
      status: file.status,
      fileName: file.fileName,
      subject: { type: 'recovery_case', id: file.caseId },
    };
  }

  async readUrl(input: { fileId: string; caseId: string }) {
    return { url: `https://files.ksp.bj/read/${input.fileId}`, expiresAt: '2026-11-20T09:05:00.000Z' };
  }
}

export class MemoryDocumentUrls implements DocumentUrls {
  async readUrl(documentId: string) {
    return { url: `https://files.ksp.bj/documents/${documentId}`, expiresAt: '2026-11-20T09:05:00.000Z' };
  }
}

/** Dépôts de l'argent en mémoire, branchés par `makeDeps` sur le dépôt des dossiers. */
export function memoryMoneyStores(cases: MemoryCaseRepository) {
  return {
    money: new MemoryMoneyStore(cases),
    debtorUploads: new MemoryDebtorUploads(),
    documentUrls: new MemoryDocumentUrls(),
    settlementTerms: NO_SETTLEMENTS,
  };
}
