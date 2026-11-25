import { type CollectionSource, computeCollection } from '../../domain/collection';
import { BASIS_POINTS } from '../../domain/money';
import { CaseErrors } from '../cases/case-errors';
import { debtorDisplayName, evidenceEntry, stableId, SYSTEM } from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { caseSubject } from '../cases/creditor-cases.use-cases';
import {
  type CaseAuditEntry,
  type CaseChanges,
  type CaseDocumentData,
  type EvidenceActor,
  noChanges,
  type RecoveryCaseRecord,
} from '../cases/ports';
import { formatXof, unwrap } from '../shared/errors';
import { CaseClosure, closeRecord } from './case-closure.service';
import {
  type ClosureRecord,
  type CollectionRecord,
  creditedGross,
  type MoneyWrites,
  type ReceiptMethod,
} from './money.ports';
import { caseAmounts, collectionStage, mainDebtor, type MoneyDeps } from './money-rules';

/** Statuts d'un dossier qui reçoit un encaissement ; un dossier clos ne reçoit plus qu'un trop-perçu. */
const COLLECTING = new Set(['active', 'suspended', 'closed']);
/** Nouvelles tentatives d'un encaissement devant une écriture concurrente sur le dossier. */
const STALE_RETRIES = 3;

/** Un encaissement à enregistrer, quelle que soit son origine. */
export interface IncomingCollection {
  caseId: string;
  source: CollectionSource;
  /** Référence unique de l'origine : `payment:<id>`, `offline:<id>`, `direct:<id>`. */
  reference: string;
  gross: number;
  receivedAt: Date;
  /** Auteur au journal de preuve : système (lien payé), finance (validation), créancier (direct). */
  actor: EvidenceActor;
  /** Compte qui a déclaré ou validé ; null pour un lien payé. */
  recordedBy: string | null;
  /** Reçu à remettre au débiteur (KSP a reçu l'argent) ; null pour un paiement direct. */
  receipt: { method: ReceiptMethod; reference: string } | null;
  proofFileId?: string | null;
  note?: string | null;
  /** Faux : paiement direct reçu après le délai qui suit l'arrêt du dossier (R-PR-06, R5). */
  commissionDue?: boolean;
  /** Écritures de l'origine, enregistrées avec l'encaissement (lien payé, paiement validé…). */
  writes?: (collection: CollectionRecord) => Omit<MoneyWrites, 'collections' | 'totals' | 'closure'>;
  /** Pièces ajoutées au dossier avec l'encaissement (preuve d'un paiement direct). */
  documents?: CaseDocumentData[];
  audit?: CaseAuditEntry[];
  /** Phrase du journal de preuve, avant le montant. */
  summary: string;
  inbox?: { eventId: string; consumer: string };
}

export interface CollectOutcome {
  record: RecoveryCaseRecord;
  collection: CollectionRecord;
  /** Faux : encaissement déjà enregistré (rejeu), rien n'a changé. */
  created: boolean;
}

const SOURCE_LABELS: Record<CollectionSource, string> = {
  payment_link: 'lien de paiement',
  offline_cash: 'espèces au guichet',
  offline_transfer: 'virement',
  partner: 'partenaire',
  direct_to_creditor: 'paiement direct au créancier',
};

/**
 * Service applicatif de l'encaissement (UC-RC-28 ; ADR-060, points 4 à 9), unique pour toutes les
 * origines : lien de paiement (`payment.link.paid`), paiement hors ligne validé à deux, encaissement
 * d'un partenaire validé (R5), paiement direct déclaré par le créancier.
 *
 * 1. Sous le verrou du dossier, dans une transaction : imputation frais → intérêts → principal,
 *    commission par la règle figée (paliers sur le cumul, minimum au cumul complété à l'encaissement
 *    qui solde, maximum par encaissement), montant dû mis à jour, trop-perçu noté, encaissement,
 *    journal, `recovery.payment.collected` (un seul message au créancier par encaissement) et, si le
 *    dû tombe à zéro, clôture « payé ».
 * 2. Ensuite, idempotents et repris par la tâche s'ils échouent : net crédité au créancier par
 *    `wallet.RecordCollection` (brut et commission) puis `recovery.remittance.paid` ; reçu PDF au
 *    débiteur ; effets de la clôture (attestation de solde, liens révoqués, `recovery.case.closed`).
 *    Un paiement direct n'est pas crédité : sa commission est facturée par billing (`invoiced`).
 */
export class CollectionService {
  private readonly closure: CaseClosure;

  constructor(private readonly deps: MoneyDeps) {
    this.closure = new CaseClosure(deps);
  }

  async collect(input: IncomingCollection): Promise<CollectOutcome> {
    const known = await this.deps.money.collectionByReference(input.reference);
    if (known) return this.replay(known, input);
    for (let attempt = 0; ; attempt += 1) {
      const record = await this.deps.cases.find(input.caseId);
      if (!record) throw CaseErrors.caseNotFound();
      const prepared = await this.prepare(record, input);
      const outcome = await this.deps.money.commit(
        prepared.record,
        prepared.writes,
        prepared.changes,
        input.inbox ? { inbox: input.inbox } : {},
      );
      if (outcome === 'saved') {
        const saved = { ...prepared.record, version: record.version + 1 };
        await this.settleQuietly(prepared.collection.id);
        if (prepared.writes.closure) await this.closure.completeQuietly(record.id);
        return { record: saved, collection: prepared.collection, created: true };
      }
      const again = await this.deps.money.collectionByReference(input.reference);
      if (again) return this.replay(again, input);
      if (outcome === 'duplicate') {
        // Événement déjà traité sans encaissement enregistré : rien à refaire.
        return { record, collection: prepared.collection, created: false };
      }
      if (attempt + 1 >= STALE_RETRIES) throw CaseErrors.concurrentUpdate(record.status);
    }
  }

  private async replay(collection: CollectionRecord, input: IncomingCollection): Promise<CollectOutcome> {
    if (input.inbox) await this.deps.money.markProcessed(input.inbox);
    const record = await this.deps.cases.find(collection.caseId);
    if (!record) throw CaseErrors.caseNotFound();
    return { record, collection, created: false };
  }

  private async prepare(
    record: RecoveryCaseRecord,
    input: IncomingCollection,
  ): Promise<{
    record: RecoveryCaseRecord;
    collection: CollectionRecord;
    writes: MoneyWrites;
    changes: CaseChanges;
  }> {
    if (!COLLECTING.has(record.status)) {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier ne reçoit pas d’encaissement.');
    }
    if (!record.pricing) throw new Error(`Dossier ${record.id} sans règle tarifaire figée.`);
    const stored = await this.deps.rules.find(record.pricing.commissionRuleId);
    if (!stored) throw new Error(`Règle de commission ${record.pricing.commissionRuleId} introuvable.`);
    const money = await this.deps.money.money(record.id);
    const computed = unwrap(
      computeCollection({
        gross: input.gross,
        source: input.source,
        amounts: caseAmounts(record, money),
        highestStage: record.highestStage,
        rule: stored.rule,
        totals: money.totals,
        commissionDue: input.commissionDue ?? true,
        open: record.status !== 'closed',
      }),
    );
    const now = this.deps.clock.now();
    const collection: CollectionRecord = {
      id: stableId('recovery-collection', input.reference),
      caseId: record.id,
      source: input.source,
      reference: input.reference,
      gross: input.gross,
      allocatedCosts: computed.allocation.costs,
      allocatedInterests: computed.allocation.interests,
      allocatedPrincipal: computed.allocation.principal,
      overpaid: computed.allocation.overpayment,
      commissionBase: computed.commissionBase,
      commission: computed.commission,
      net: computed.net,
      settlement: computed.settlement,
      stage: collectionStage(record),
      stageGroup: computed.stageGroup,
      dueBefore: computed.dueBefore,
      rule: { id: stored.rule.id, version: record.pricing.commissionRuleVersion },
      walletTransactionId: null,
      creditedAt: null,
      receipt: computed.dueBefore > 0 ? input.receipt : null,
      receiptDocumentId: null,
      proofFileId: input.proofFileId ?? null,
      note: input.note ?? null,
      recordedBy: input.recordedBy,
      collectedAt: input.receivedAt,
      createdAt: now,
    };
    let next: RecoveryCaseRecord = {
      ...record,
      paid: record.paid + input.gross - computed.allocation.overpayment,
      documents: [...record.documents, ...(input.documents ?? [])],
    };
    const changes = noChanges();
    const parts = [`${input.summary} : ${formatXof(input.gross)} (${SOURCE_LABELS[input.source]})`];
    if (computed.commission > 0) {
      parts.push(
        computed.settlement === 'invoiced'
          ? `commission de ${formatXof(computed.commission)} facturée au créancier`
          : `commission de ${formatXof(computed.commission)}`,
      );
    }
    parts.push(`reste dû ${formatXof(computed.dueAfter)}`);
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, input.actor, {
        action: 'payment.collected',
        kind: 'payment',
        summary: parts.join(' ; '),
        amount: input.gross,
        ...(input.proofFileId ? { ref: { type: 'file' as const, id: input.proofFileId } } : {}),
      }),
    );
    if (computed.allocation.overpayment > 0) {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, SYSTEM, {
          action: 'payment.overpaid',
          kind: 'payment',
          summary: `Trop-perçu de ${formatXof(computed.allocation.overpayment)} noté : remboursement au débiteur par la finance`,
          amount: computed.allocation.overpayment,
        }),
      );
    }
    changes.events.push({
      type: 'recovery.payment.collected',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        kind: record.kind,
        collectionId: collection.id,
        source: input.source,
        gross: { amount: input.gross, currency: 'XOF' },
        allocatedCosts: { amount: collection.allocatedCosts, currency: 'XOF' },
        allocatedInterests: { amount: collection.allocatedInterests, currency: 'XOF' },
        allocatedPrincipal: { amount: collection.allocatedPrincipal, currency: 'XOF' },
        overpaid: { amount: collection.overpaid, currency: 'XOF' },
        commission: { amount: collection.commission, currency: 'XOF' },
        commissionSettlement: collection.settlement,
        stage: collectionStage(record),
        amountDueAfter: { amount: computed.dueAfter, currency: 'XOF' },
        receivedAt: input.receivedAt.toISOString(),
      },
    });
    changes.audit.push(...(input.audit ?? []));
    let closure: ClosureRecord | undefined;
    if (computed.closesCase) {
      const closed = closeRecord(
        this.deps.ids,
        next,
        { reason: 'paid', actor: SYSTEM, note: null, staff: null },
        now,
        changes,
      );
      next = closed.record;
      closure = closed.closure;
    }
    const writes: MoneyWrites = {
      ...(input.writes ? input.writes(collection) : {}),
      collections: [collection],
      totals: computed.totalsAfter,
      ...(closure ? { closure } : {}),
    };
    return { record: next, collection, writes, changes };
  }

  /** Crédit et reçu d'un encaissement, sans lever : la tâche reprend un échec. */
  async settleQuietly(collectionId: string): Promise<void> {
    try {
      await this.settle(collectionId);
    } catch {
      // Repris par la tâche (encaissement non crédité ou reçu manquant).
    }
  }

  /**
   * Effets d'un encaissement enregistré, idempotents : net crédité au créancier (wallet, référence de
   * l'encaissement) puis `recovery.remittance.paid` ; reçu au débiteur (clé stable). Lève si un service
   * manque : la tâche reprend.
   */
  async settle(collectionId: string): Promise<void> {
    const collection = await this.deps.money.collection(collectionId);
    if (!collection) return;
    const record = await this.deps.cases.find(collection.caseId);
    if (!record) return;
    const share = creditedGross(collection);
    if (share > 0 && !collection.creditedAt) await this.credit(record, collection, share);
    if (collection.receipt && !collection.receiptDocumentId) await this.receipt(record, collection);
  }

  private async credit(record: RecoveryCaseRecord, collection: CollectionRecord, share: number) {
    const credited = await this.deps.wallet.recordCollection({
      holder: record.creditor,
      gross: share,
      commission: collection.commission,
      commissionRateBps: Math.floor((collection.commission * BASIS_POINTS) / share),
      reference: collection.reference,
      description: `Encaissement du dossier ${record.number}`,
    });
    const now = this.deps.clock.now();
    const net = share - collection.commission;
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, SYSTEM, {
        action: 'remittance.paid',
        kind: 'payment',
        summary: `Net de ${formatXof(net)} crédité au portefeuille du créancier (commission ${formatXof(collection.commission)})`,
        amount: net,
      }),
    );
    changes.events.push({
      type: 'recovery.remittance.paid',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        collectionId: collection.id,
        gross: { amount: share, currency: 'XOF' },
        commission: { amount: collection.commission, currency: 'XOF' },
        net: { amount: net, currency: 'XOF' },
        walletTransactionId: credited.transactionId,
        creditedAt: now.toISOString(),
      },
    });
    changes.audit.push({
      actorId: 'system',
      action: 'remittance.paid',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { collectionId: collection.id, net, walletTransactionId: credited.transactionId },
    });
    await this.deps.money.markCredited(collection.id, credited.transactionId, now, changes);
  }

  /** Reçu du débiteur (modèle `recovery_receipt`), montré dans son espace (R-EN-02). */
  private async receipt(record: RecoveryCaseRecord, collection: CollectionRecord) {
    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const creditorName = names.holder(record.creditor);
    // Sans le nom du créancier (identity injoignable), le reçu attend le prochain passage.
    if (!creditorName || !collection.receipt) return;
    const debtor = mainDebtor(record);
    const document = await this.deps.documents.generate({
      template: 'recovery_receipt',
      variables: {
        caseReference: record.number,
        creditor: { name: creditorName },
        payer: { name: (debtor ? debtorDisplayName(debtor) : '') || 'Débiteur' },
        payment: {
          paidAt: collection.collectedAt.toISOString(),
          amount: collection.gross,
          method: collection.receipt.method,
          reference: (collection.receipt.reference || collection.reference).slice(0, 100),
        },
        dueBefore: collection.dueBefore,
      },
      subject: caseSubject(record.id),
      idempotencyKey: `recovery:receipt:${collection.id}`,
    });
    const now = this.deps.clock.now();
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, SYSTEM, {
        action: 'receipt.issued',
        kind: 'document',
        summary: `Reçu ${document.number} remis au débiteur`,
        ref: { type: 'document', id: document.id },
      }),
    );
    await this.deps.money.attachReceipt(
      collection.id,
      {
        id: stableId('recovery-receipt', collection.id),
        kind: 'receipt',
        label: `Reçu ${document.number}`,
        fileId: null,
        documentId: document.id,
        visibleToPartner: false,
        visibleToDebtor: true,
        addedBy: SYSTEM,
        addedAt: now,
      },
      changes,
    );
  }

  /**
   * Reprise (tâche planifiée) : encaissements non crédités ou sans reçu, puis clôtures dont les effets
   * ne sont pas terminés. Chaque effet est idempotent : plusieurs instances peuvent tourner.
   */
  async resume(limit = 50): Promise<{ settled: number; closed: number; failed: number }> {
    const report = { settled: 0, closed: 0, failed: 0 };
    for (const collection of await this.deps.money.pendingSettlements(limit)) {
      try {
        await this.settle(collection.id);
        report.settled += 1;
      } catch {
        report.failed += 1;
      }
    }
    for (const caseId of await this.deps.money.pendingClosures(limit)) {
      try {
        if (await this.closure.complete(caseId)) report.closed += 1;
      } catch {
        report.failed += 1;
      }
    }
    return report;
  }
}
