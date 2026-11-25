import { AppError } from '@ksp/platform';
import { changeStatus } from '../../domain/case';
import { type FullSettings } from '../ports';
import { loadSettings } from '../settings.use-cases';
import { unwrap } from '../shared/errors';
import { rejectCase } from './admin-cases.use-cases';
import { CaseErrors } from './case-errors';
import { payCaseFee, settleRejectedFee } from './case-fees';
import { UUID } from './case-input';
import { creditorActor, evidenceEntry, SYSTEM } from './case-rules';
import { type CaseDeps } from './creditor-cases.use-cases';
import { noChanges, type RecoveryCaseRecord } from './ports';

const DAY_MS = 86_400_000;
/** Dossiers traités par étape et par passage ; le reste attend le passage suivant. */
const BATCH = 50;

export interface CaseDeadlinesReport {
  /** Brouillons et dossiers non payés supprimés (R-SD-04). */
  deleted: number;
  /** Paiements restés sans réponse de wallet, confirmés au rapprochement. */
  reconciled: number;
  /** Dossiers classés faute de complément (4.4). */
  closed: number;
  /** Remboursements et forfaits d'étude passés. */
  settled: number;
  failed: number;
}

/**
 * Tâche des échéances des dossiers (ADR-060, point 17), délais lus dans les réglages :
 * 1. dossier non payé à l'issue du délai de paiement des frais (7 jours depuis sa création) :
 *    supprimé comme brouillon (R-SD-04) ; un paiement demandé sans réponse de wallet est d'abord
 *    rapproché par le même débit (même clé) : débité, le dossier part en examen ; refusé, il est
 *    supprimé ;
 * 2. complément demandé sans réponse dans le délai (15 jours) : dossier classé (`rejected`, motif
 *    `incomplete`), frais remboursés moins le forfait d'étude (4.4) ;
 * 3. remboursement ou forfait d'étude d'un dossier refusé resté en échec : repris avec la même clé.
 * Plusieurs instances peuvent tourner : chaque écriture est conditionnée par la version du dossier,
 * chaque appel à wallet est idempotent. Une erreur sur un dossier n'arrête pas les suivants.
 */
export class WatchCaseDeadlinesUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(): Promise<CaseDeadlinesReport> {
    const now = this.deps.clock.now();
    const { settings } = await loadSettings(this.deps.settings);
    const report: CaseDeadlinesReport = { deleted: 0, reconciled: 0, closed: 0, settled: 0, failed: 0 };

    const unpaidBefore = new Date(now.getTime() - settings.feePaymentDays * DAY_MS);
    for (const record of await this.deps.cases.listUnpaidCreatedBefore(unpaidBefore, BATCH)) {
      try {
        let current: RecoveryCaseRecord | null = record;
        if (current.status === 'awaiting_fee' && current.fee.debitAttemptedAt !== null) {
          if (await this.reconcile(current, settings)) {
            report.reconciled += 1;
            continue;
          }
          current = await this.deps.cases.find(record.id);
          if (!current || current.fee.paidAt) continue;
        }
        const deleted = await this.deps.cases.deleteUnpaid(current, {
          actorId: 'system',
          action: 'case.unpaid_deleted',
          entityType: 'recovery_case',
          entityId: current.id,
          at: now,
          details: { number: current.number, status: current.status },
        });
        if (deleted) report.deleted += 1;
      } catch {
        report.failed += 1;
      }
    }

    const infoBefore = new Date(now.getTime() - settings.infoCompletionDays * DAY_MS);
    for (const record of await this.deps.cases.listInfoRequestedBefore(infoBefore, BATCH)) {
      try {
        await rejectCase(this.deps, record, {
          reason: 'incomplete',
          note: 'Complément non fourni dans le délai : dossier classé.',
          actor: SYSTEM,
          staff: null,
          assessmentKey: null,
        });
        report.closed += 1;
      } catch {
        report.failed += 1;
      }
    }

    for (const record of await this.deps.cases.listPendingFeeSettlements(BATCH)) {
      const { error } = await settleRejectedFee(this.deps, record);
      if (error) report.failed += 1;
      else report.settled += 1;
    }
    return report;
  }

  /**
   * Paiement resté sans réponse : rejoué avec la même clé. Vrai si le dossier est payé et envoyé ;
   * faux si wallet refuse (aucun débit) ; une panne de wallet laisse le dossier au passage suivant.
   */
  private async reconcile(record: RecoveryCaseRecord, settings: FullSettings): Promise<boolean> {
    try {
      await payCaseFee(this.deps, record, settings, SYSTEM);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.kind !== 'UNAVAILABLE' && error.kind !== 'DEADLINE_EXCEEDED') {
        return false;
      }
      throw error;
    }
  }
}

/** Abonnement de recovery à document : consommateur noté dans l'inbox. */
export const MANDATE_SIGNATURE_CONSUMER = 'recovery.document.signature.completed';

/**
 * Mandat signé (`document.signature.completed`, ADR-044) : le brouillon dont c'est le mandat en cours
 * passe « frais à payer », le PDF signé est joint au dossier et la signature entre au journal de
 * preuve. Idempotent (inbox dans la même transaction) ; une signature d'un autre modèle, d'un autre
 * service ou d'un mandat remplacé est ignorée.
 */
export class RecordMandateSignatureUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: {
    eventId: string;
    documentId: string;
    template: string;
    producerService: string;
    subjectType: string;
    subjectId: string;
    signerUserId: string | null;
    signedAt: string;
  }): Promise<'recorded' | 'ignored' | 'duplicate'> {
    if (
      input.template !== 'recovery_mandate' ||
      input.producerService !== 'recovery' ||
      input.subjectType !== 'recovery_case' ||
      !UUID.test(input.subjectId)
    ) {
      return 'ignored';
    }
    const parsed = new Date(input.signedAt);
    const signedAt = Number.isNaN(parsed.getTime()) ? this.deps.clock.now() : parsed;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await this.deps.cases.find(input.subjectId.toLowerCase());
      if (!record || record.status !== 'draft' || record.mandate?.documentId !== input.documentId)
        return 'ignored';
      const state = unwrap(changeStatus(record, 'awaiting_fee'));
      const actor = input.signerUserId
        ? creditorActor(input.signerUserId)
        : { type: 'creditor' as const, id: null };
      const next: RecoveryCaseRecord = {
        ...record,
        status: state.status,
        mandate: { ...record.mandate, signedAt },
        documents: [
          ...record.documents,
          {
            id: this.deps.ids.next(),
            kind: 'mandate',
            label: 'Mandat de recouvrement signé',
            fileId: null,
            documentId: input.documentId,
            visibleToPartner: false,
            visibleToDebtor: false,
            addedBy: actor,
            addedAt: signedAt,
          },
        ],
        lastActionAt: signedAt,
        updatedAt: this.deps.clock.now(),
      };
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, signedAt, actor, {
          action: 'mandate.signed',
          kind: 'document',
          summary:
            'Mandat signé par le créancier (signature électronique par code) ; frais de dossier à payer',
          ref: { type: 'document', id: input.documentId },
        }),
      );
      const outcome = await this.deps.cases.save(next, changes, {
        inbox: { eventId: input.eventId, consumer: MANDATE_SIGNATURE_CONSUMER },
      });
      if (outcome === 'saved') return 'recorded';
      if (outcome === 'duplicate') return 'duplicate';
    }
    throw CaseErrors.concurrentUpdate('draft');
  }
}
