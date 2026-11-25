import { correctPrincipal } from '../../domain/amounts';
import { changeStatus } from '../../domain/case';
import {
  type DisputeReason,
  type DisputeResolution,
  openDispute,
  resolveDispute,
} from '../../domain/dispute';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import { agentActor, amountDue, evidenceEntry, requireIdempotencyKey, stableId } from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { requireCaseId } from '../cases/creditor-cases.use-cases';
import { noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, requireStaff, ROLES } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import { CaseClosure, closeRecord } from '../money/case-closure.service';
import { type DisputeRecord, type MoneyWrites, type PaymentRequestRecord } from '../money/money.ports';
import {
  caseAmounts,
  debtorRecipient,
  MoneyErrors,
  type MoneyDeps,
  optionalText,
} from '../money/money-rules';
import { moneyCaseView, type MoneyCaseView } from '../money/money-views';
import { requireAmount } from '../money/offline-payments.use-cases';
import { debtorActor, type DebtorScope } from './debtor-space.use-cases';

/** Courriers, contestations, escalade (manifeste de la gateway : juristes et administrateurs). */
export const LEGAL_ROLES = [ROLES.legal, ROLES.admin, ROLES.superAdmin] as const;

export const DISPUTE_REASONS: readonly DisputeReason[] = [
  'already_paid',
  'wrong_amount',
  'service_not_rendered',
  'wrong_person',
  'other',
];
const RESOLUTIONS: readonly DisputeResolution[] = ['resume', 'correct_amount', 'close'];
const REASON_LABELS: Record<DisputeReason, string> = {
  already_paid: 'déjà payé',
  wrong_amount: 'montant faux',
  service_not_rendered: 'prestation non faite',
  wrong_person: 'mauvaise personne',
  other: 'autre motif',
};
/** Pièces jointes à une contestation. */
const MAX_DISPUTE_FILES = 10;

/**
 * Contestation du débiteur (DisputeDebtorCase, R-PR-02, UC-RC-13) : motif, texte (chiffré en base),
 * pièces qu'il a envoyées ; le dossier est suspendu, le créancier a 10 jours (réglable) pour répondre,
 * `recovery.case.suspended` le prévient ; le débiteur reçoit l'accusé de réception. Rejouée avec la
 * même clé, elle rend la contestation enregistrée.
 */
export class DisputeDebtorCaseUseCase {
  constructor(private readonly deps: MoneyDeps) {}

  async execute(
    input: DebtorScope & { idempotencyKey: string; reason: string; text: string; fileIds: readonly string[] },
  ): Promise<DisputeRecord> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = await this.deps.cases.find(input.caseId);
    if (!record || !record.debtors.some((debtor) => debtor.id === input.debtorId)) {
      throw CaseErrors.caseNotFound();
    }
    const known = await this.deps.money.disputeByKey(record.id, key);
    if (known) {
      if (known.debtorId !== input.debtorId) throw RecoveryErrors.keyReused();
      return known;
    }
    const reason = input.reason as DisputeReason;
    if (!DISPUTE_REASONS.includes(reason)) {
      throw RecoveryErrors.invalid('reason', `Valeur attendue : ${DISPUTE_REASONS.join(', ')}.`);
    }
    const text = optionalText('text', input.text, 2000);
    const fileIds = [...new Set((input.fileIds ?? []).map((id) => id.toLowerCase()))];
    if (fileIds.length > MAX_DISPUTE_FILES) {
      throw RecoveryErrors.invalid('fileIds', `${MAX_DISPUTE_FILES} pièces au plus.`);
    }
    for (const fileId of fileIds) {
      const sent = record.documents.some(
        (document) =>
          document.fileId === fileId &&
          document.kind === 'dispute_evidence' &&
          document.addedBy.id === input.debtorId,
      );
      if (!UUID.test(fileId) || !sent) {
        throw RecoveryErrors.invalid('fileIds', 'Pièce inconnue : envoyez-la d’abord depuis votre espace.');
      }
    }
    if (record.status === 'suspended') throw MoneyErrors.caseSuspended();
    if (record.status !== 'active') {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier ne se conteste plus.');
    }
    const now = this.deps.clock.now();
    const { settings } = await loadSettings(this.deps.settings);
    const opened = openDispute(reason, now, settings.disputeAnswerDays);
    const state = unwrap(changeStatus(record, 'suspended'));
    const next: RecoveryCaseRecord = { ...record, status: state.status };
    const dispute: DisputeRecord = {
      id: stableId('recovery-dispute', record.id, input.debtorId, key),
      caseId: record.id,
      debtorId: input.debtorId,
      reason,
      text,
      fileIds,
      status: opened.status,
      openedAt: opened.openedAt,
      creditorAnswerDueAt: opened.creditorAnswerDueAt,
      creditorAnsweredAt: null,
      resolution: null,
      resolutionNote: null,
      resolvedBy: null,
      resolvedAt: null,
      idempotencyKey: key,
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, debtorActor(input.debtorId), {
        action: 'dispute.opened',
        kind: 'dispute',
        summary:
          `Contestation du débiteur (motif : ${REASON_LABELS[reason]}${fileIds.length > 0 ? `, ${fileIds.length} pièce(s)` : ''}) : ` +
          `dossier suspendu, réponse du créancier attendue avant le ${opened.creditorAnswerDueAt.toISOString().slice(0, 10)}`,
      }),
    );
    changes.events.push({
      type: 'recovery.case.suspended',
      payload: {
        caseId: next.id,
        caseNumber: next.number,
        creditor: next.creditor,
        reason: 'dispute',
        disputeId: dispute.id,
        creditorAnswerDueAt: dispute.creditorAnswerDueAt.toISOString(),
        suspendedAt: now.toISOString(),
      },
    });
    const outcome = await this.deps.money.commit(next, { disputes: [dispute] }, changes);
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    await this.acknowledge(next, input.debtorId, dispute.id);
    return dispute;
  }

  /** Accusé de réception au débiteur, sans bloquer : la contestation est déjà enregistrée. */
  private async acknowledge(record: RecoveryCaseRecord, debtorId: string, disputeId: string): Promise<void> {
    try {
      const recipient = debtorRecipient(record.debtors.find((debtor) => debtor.id === debtorId) ?? null);
      const names = await displayNames(this.deps.directory, [record.creditor], []);
      const creditorName = names.holder(record.creditor);
      if (!recipient || !creditorName) return;
      await this.deps.notifier.sendToDebtor({
        message: 'dispute_received',
        ...recipient,
        variables: {
          creditor_name: creditorName,
          case_number: record.number,
          link: this.deps.debtorAccess.baseUrl,
        },
        idempotencyKey: `dispute-received:${disputeId}`,
      });
    } catch {
      // Message non remis : la contestation est enregistrée, le chargé la voit au journal.
    }
  }
}

/**
 * Suite d'une contestation (ResolveDispute, R-PR-02) par un juriste : « resume » (contestation
 * rejetée, dossier repris), « correct_amount » (montant dû corrigé à la baisse, dossier repris ; les
 * liens de paiement au-delà du nouveau dû sont révoqués) ou « close » (contestation fondée, dossier
 * clos et liens du débiteur révoqués). Motif écrit obligatoire.
 */
export class ResolveDisputeUseCase {
  private readonly closure: CaseClosure;

  constructor(private readonly deps: MoneyDeps) {
    this.closure = new CaseClosure(deps);
  }

  async execute(input: {
    caseId: string;
    disputeId: string;
    resolution: string;
    correctedDue: number | null;
    note: string;
  }): Promise<MoneyCaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const disputeId = input.disputeId?.toLowerCase() ?? '';
    const dispute = (await this.deps.money.disputes(record.id)).find(
      (candidate) => candidate.id === disputeId,
    );
    if (!dispute) throw RecoveryErrors.invalid('disputeId', 'Cette contestation est introuvable.');
    const resolution = input.resolution as DisputeResolution;
    if (!RESOLUTIONS.includes(resolution)) {
      throw RecoveryErrors.invalid('resolution', `Valeur attendue : ${RESOLUTIONS.join(', ')}.`);
    }
    const note = input.note?.trim() ?? '';
    if (note.length < 3 || note.length > 2000) {
      throw RecoveryErrors.invalid('note', 'Motif écrit de 3 à 2 000 caractères.');
    }
    const status = unwrap(
      resolveDispute(
        {
          reason: dispute.reason,
          status: dispute.status,
          openedAt: dispute.openedAt,
          creditorAnswerDueAt: dispute.creditorAnswerDueAt,
          creditorSilent: false,
        },
        resolution,
      ),
    ).status;
    if (record.status !== 'suspended') {
      throw CaseErrors.invalidTransition(
        record.status,
        'Seul un dossier suspendu par une contestation la tranche.',
      );
    }
    const resolved: DisputeRecord = {
      ...dispute,
      status,
      resolution,
      resolutionNote: note,
      resolvedBy: staff.userId,
      resolvedAt: now,
    };
    const actor = agentActor(staff.userId);
    const changes = noChanges();
    changes.audit.push({
      actorId: staff.userId,
      action: 'dispute.resolved',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { disputeId: dispute.id, resolution },
    });
    const writes: MoneyWrites = { disputes: [resolved] };
    let next: RecoveryCaseRecord;
    if (resolution === 'close') {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, actor, {
          action: 'dispute.upheld',
          kind: 'dispute',
          summary: 'Contestation jugée fondée par le juriste',
        }),
      );
      const closed = closeRecord(
        this.deps.ids,
        record,
        { reason: 'dispute_upheld', actor, note, staff },
        now,
        changes,
      );
      next = closed.record;
      writes.closure = closed.closure;
    } else {
      const state = unwrap(changeStatus(record, 'active'));
      next = { ...record, status: state.status };
      if (resolution === 'correct_amount') {
        const due = amountDue(record);
        const corrected = requireAmount('correctedDue', input.correctedDue);
        if (corrected >= due) {
          throw RecoveryErrors.invalid(
            'correctedDue',
            `Montant dû corrigé inférieur au dû actuel (${formatXof(due)}).`,
          );
        }
        const amounts = caseAmounts(record, await this.deps.money.money(record.id));
        const principal = unwrap(correctPrincipal(amounts, amounts.principal.owed - (due - corrected)))
          .principal.owed;
        next = { ...next, principal };
        writes.paymentRequests = await this.revokeAbove(record.id, corrected);
      }
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, actor, {
          action: resolution === 'resume' ? 'dispute.rejected' : 'dispute.amount_corrected',
          kind: 'dispute',
          summary:
            resolution === 'resume'
              ? 'Contestation rejetée par le juriste : dossier repris'
              : `Montant dû corrigé à ${formatXof(amountDue(next))} après la contestation : dossier repris`,
        }),
      );
      changes.events.push({
        type: 'recovery.case.resumed',
        payload: {
          caseId: next.id,
          caseNumber: next.number,
          creditor: next.creditor,
          disputeId: dispute.id,
          resolution,
          resumedAt: now.toISOString(),
        },
      });
    }
    const outcome = await this.deps.money.commit(next, writes, changes);
    if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(record.status);
    const saved = { ...next, version: record.version + 1 };
    if (writes.closure) await this.closure.completeQuietly(record.id);
    return moneyCaseView(this.deps, saved, now);
  }

  /** Liens de paiement d'un montant au-delà du nouveau dû : révoqués (plafond, ADR-060 point 7). */
  private async revokeAbove(caseId: string, due: number): Promise<PaymentRequestRecord[]> {
    const revoked: PaymentRequestRecord[] = [];
    for (const request of await this.deps.money.activePaymentRequests(caseId)) {
      if (request.amount <= due) continue;
      try {
        if (request.paymentLinkId)
          await this.deps.paymentLinks.revoke(request.paymentLinkId, 'amount_corrected');
        revoked.push({ ...request, status: 'revoked' });
      } catch {
        // Lien déjà payé ou payment injoignable : un paiement reçu au-delà sera un trop-perçu.
      }
    }
    return revoked;
  }
}
