import { localDay } from '../../domain/calendar';
import { close, type ClosureReason } from '../../domain/case';
import { caseSubject } from '../cases/creditor-cases.use-cases';
import { CaseErrors } from '../cases/case-errors';
import { debtorDisplayName, evidenceEntry, stableId, SYSTEM } from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import {
  type CaseChanges,
  type CaseDocumentData,
  type EvidenceActor,
  noChanges,
  type RecoveryCaseRecord,
} from '../cases/ports';
import { DebtorLinks } from '../debtor-access/debtor-links.service';
import { type IdGenerator } from '../ports';
import { type Staff } from '../shared/access';
import { RecoveryErrors, unwrap } from '../shared/errors';
import { type ClosureRecord } from './money.ports';
import { debtorRecipient, mainDebtor, type MoneyDeps } from './money-rules';

/**
 * Clôture d'un dossier (R-PR-10), réutilisable : paiement complet (encaissement qui solde le dû), puis
 * R5 (clôture manuelle, arrêt par le créancier) et la contestation fondée. Deux temps :
 * 1. `closeRecord` prépare l'état clos et sa trace, enregistrés avec l'écriture qui en est la cause
 *    (encaissement, décision) dans la même transaction ;
 * 2. `CaseClosure.complete` en fait les effets, idempotents et repris par la tâche tant qu'ils ne sont
 *    pas terminés : attestation de solde (dossier payé, R-DB-03) remise au débiteur, liens de paiement
 *    et liens personnels du débiteur révoqués, `recovery.case.closed`.
 */
export interface ClosureCause {
  reason: ClosureReason;
  actor: EvidenceActor;
  note: string | null;
  /** Membre du personnel qui clôt (trace d'audit), null pour le système ou le créancier. */
  staff: Staff | null;
}

const CLOSURE_SUMMARIES: Record<ClosureReason, string> = {
  paid: 'Dossier clos : montant dû entièrement payé',
  settlement_executed: 'Dossier clos : accord transactionnel exécuté',
  dispute_upheld: 'Dossier clos : contestation fondée',
  abandoned_by_creditor: 'Dossier clos : arrêté par le créancier',
  unrecoverable: 'Dossier clos : créance jugée irrecouvrable',
  prescribed: 'Dossier clos : créance prescrite',
};

/** Motifs qui donnent une attestation de solde au débiteur (R-DB-03). */
const CERTIFIED: ReadonlySet<ClosureReason> = new Set(['paid']);

/** État clos d'un dossier et sa trace, à enregistrer par l'appelant avec sa propre écriture. */
export function closeRecord(
  ids: IdGenerator,
  record: RecoveryCaseRecord,
  cause: ClosureCause,
  now: Date,
  changes: CaseChanges = noChanges(),
): { record: RecoveryCaseRecord; closure: ClosureRecord; changes: CaseChanges } {
  const state = unwrap(close(record, cause.reason));
  const next: RecoveryCaseRecord = { ...record, status: state.status, closureReason: state.closureReason };
  changes.evidence.push(
    evidenceEntry(ids, next, now, cause.actor, {
      action: 'case.closed',
      kind: 'status_changed',
      summary: CLOSURE_SUMMARIES[cause.reason],
    }),
  );
  if (cause.staff) {
    changes.audit.push({
      actorId: cause.staff.userId,
      action: 'case.closed',
      entityType: 'recovery_case',
      entityId: next.id,
      at: now,
      details: { reason: cause.reason },
    });
  }
  return {
    record: next,
    closure: {
      closedAt: now,
      closedBy: cause.actor,
      note: cause.note,
      certificateDocumentId: null,
      completedAt: null,
    },
    changes,
  };
}

const NATURE_LABELS: Record<string, string> = {
  unpaid_invoice: 'facture impayée',
  loan: 'prêt',
  acknowledgment_of_debt: 'reconnaissance de dette',
  bounced_cheque: 'chèque impayé',
  service: 'prestation de service',
  sale: 'vente',
  rent: 'loyers',
  other: 'créance',
};

export class CaseClosure {
  constructor(private readonly deps: MoneyDeps) {}

  /**
   * Clôture complète d'un dossier actif ou suspendu (R5 : clôture manuelle, arrêt par le créancier) :
   * état enregistré sous verrou, puis effets. Un effet en échec est repris par la tâche.
   */
  async close(caseId: string, cause: ClosureCause): Promise<RecoveryCaseRecord> {
    const record = await this.deps.cases.find(caseId);
    if (!record) throw CaseErrors.caseNotFound();
    const now = this.deps.clock.now();
    const closed = closeRecord(this.deps.ids, record, cause, now);
    const outcome = await this.deps.money.commit(closed.record, { closure: closed.closure }, closed.changes);
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    await this.completeQuietly(caseId);
    return { ...closed.record, version: record.version + 1 };
  }

  /** Effets de la clôture, sans lever : la tâche reprend un échec. */
  async completeQuietly(caseId: string): Promise<boolean> {
    try {
      return await this.complete(caseId);
    } catch {
      return false;
    }
  }

  /**
   * Effets de la clôture, idempotents : attestation de solde produite (clé stable) et envoyée au
   * débiteur, liens de paiement et liens personnels révoqués, `recovery.case.closed`. Sans effet sur un
   * dossier dont la clôture est déjà terminée. Lève si un service manque : rien n'est marqué terminé.
   */
  async complete(caseId: string): Promise<boolean> {
    const record = await this.deps.cases.find(caseId);
    if (!record || record.status !== 'closed') return false;
    const money = await this.deps.money.money(caseId);
    if (!money.closure || money.closure.completedAt) return false;
    const now = this.deps.clock.now();
    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const creditorName = names.holder(record.creditor);

    let certificate: CaseDocumentData | null = null;
    if (record.closureReason && CERTIFIED.has(record.closureReason) && record.paid > 0) {
      if (!creditorName) throw RecoveryErrors.dependencyUnavailable('identity');
      certificate = await this.certificate(record, creditorName, money.closure.closedAt, now);
    }

    // Liens de paiement encore payables : révoqués chez payment (un échec ne bloque pas, le lien
    // payé tard reste enregistré comme trop-perçu).
    const revokedRequestIds: string[] = [];
    for (const request of await this.deps.money.activePaymentRequests(caseId)) {
      if (request.paymentLinkId) {
        try {
          await this.deps.paymentLinks.revoke(request.paymentLinkId, 'case_closed');
        } catch {
          continue;
        }
      }
      revokedRequestIds.push(request.id);
    }
    await new DebtorLinks(this.deps).revoke({ caseId });

    if (certificate) {
      const recipient = debtorRecipient(mainDebtor(record));
      if (recipient) {
        await this.deps.notifier.sendToDebtor({
          message: 'settlement_certificate',
          ...recipient,
          variables: {
            creditor_name: creditorName,
            case_number: record.number,
            link: this.deps.debtorAccess.baseUrl,
          },
          idempotencyKey: `settlement-certificate:${record.id}`,
        });
      }
    }

    const collections = await this.deps.money.collections(caseId);
    const totalCollected = collections.reduce(
      (sum, collection) => sum + collection.gross - collection.overpaid,
      0,
    );
    const changes = noChanges();
    if (certificate) {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'settlement_certificate.issued',
          kind: 'document',
          summary: 'Attestation de solde émise et remise au débiteur',
          ref: { type: 'document', id: certificate.documentId! },
        }),
      );
    }
    changes.events.push({
      type: 'recovery.case.closed',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        kind: record.kind,
        reason: record.closureReason!,
        totalCollected: { amount: totalCollected, currency: 'XOF' },
        settlementCertificateDocumentId: certificate?.documentId ?? null,
        closedAt: money.closure.closedAt.toISOString(),
      },
    });
    return this.deps.money.completeClosure(caseId, { at: now, certificate, revokedRequestIds }, changes);
  }

  /** Attestation de solde (modèle `recovery_settlement_certificate`), clé stable par dossier. */
  private async certificate(
    record: RecoveryCaseRecord,
    creditorName: string,
    closedAt: Date,
    now: Date,
  ): Promise<CaseDocumentData> {
    const debtor = mainDebtor(record);
    const references = record.claims.map((claim) => claim.reference).join(', ');
    const identification = debtor?.ifu || debtor?.rccm || '';
    const address = debtor?.address?.trim() ?? '';
    const document = await this.deps.documents.generate({
      template: 'recovery_settlement_certificate',
      variables: {
        caseReference: record.number,
        creditor: { name: creditorName },
        debtor: {
          name: (debtor ? debtorDisplayName(debtor) : '') || 'Débiteur',
          ...(address && address.length <= 300 ? { address } : {}),
          ...(identification && identification.length <= 100 ? { identification } : {}),
        },
        claim: {
          cause:
            `${record.claims.length > 1 ? 'Créances' : 'Créance'} ${references} (${NATURE_LABELS[record.nature] ?? 'créance'})`.slice(
              0,
              1000,
            ),
        },
        closure: 'paid_in_full',
        totalPaid: record.paid,
        settledOn: localDay(closedAt),
      },
      subject: caseSubject(record.id),
      idempotencyKey: `recovery:settlement-certificate:${record.id}`,
    });
    return {
      id: stableId('settlement-certificate', record.id),
      kind: 'settlement_certificate',
      label: `Attestation de solde ${document.number}`,
      fileId: null,
      documentId: document.id,
      visibleToPartner: false,
      visibleToDebtor: true,
      addedBy: SYSTEM,
      addedAt: now,
    };
  }
}
