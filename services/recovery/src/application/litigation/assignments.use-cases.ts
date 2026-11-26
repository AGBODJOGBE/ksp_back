import { paidStageOf, partnerFitsStage } from '../../domain/litigation';
import { optionalText, requireActive } from '../amicable/amicable-rules';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import { agentActor, evidenceEntry } from '../cases/case-rules';
import { requireCaseId } from '../cases/creditor-cases.use-cases';
import { noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { CRITICAL_MFA_SECONDS, requireStaff } from '../shared/access';
import { RecoveryErrors } from '../shared/errors';
import { type AssignmentRecord, type LitigationDeps, noLitigationWrites } from './litigation.ports';
import {
  commitLitigation,
  LEGAL_ROLES,
  LitigationErrors,
  oneLine,
  PARTNER_KIND_LABELS,
} from './litigation-rules';
import { type AssignmentView, assignmentViews } from './litigation-views';

/**
 * Assignation d'un huissier ou d'un avocat (UC-RC-20, R-HU-02 et 07) : à une étape payante ouverte
 * (devis accepté et provision payée, R-PR-04), au partenaire actif du bon métier, un seul à la fois. Les
 * pièces de la mission (R-HU-03 : mandat, justificatifs, échéancier signé, mise en demeure et preuve de
 * remise, journal de preuve, actes) deviennent visibles du partenaire ; les autres restent cachées
 * (R-AR-02). Le retrait est motivé ; l'historique reste.
 */

/** Pièces transmises au partenaire à l'assignation (R-HU-03). */
export const MISSION_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  'mandate',
  'evidence',
  'payment_plan',
  'formal_notice',
  'notice_delivery_proof',
  'evidence_log',
  'legal_act',
]);

async function viewOf(
  deps: LitigationDeps,
  record: RecoveryCaseRecord,
  assignment: AssignmentRecord,
): Promise<AssignmentView> {
  const [view] = await assignmentViews(deps, [{ ...assignment, caseNumber: record.number }]);
  return view!;
}

export class AssignPartnerUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { caseId: string; partnerId: string; note: string }): Promise<AssignmentView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const partner = UUID.test(input.partnerId ?? '')
      ? await this.deps.litigation.partner(input.partnerId.toLowerCase())
      : null;
    if (!partner) throw LitigationErrors.partnerNotFound();
    const active = (await this.deps.litigation.caseAssignments(record.id)).find((a) => a.status === 'active');
    if (active?.partnerId === partner.id) return viewOf(this.deps, record, active);
    requireActive(record);
    const stage = paidStageOf(record.stage);
    const provisions = await this.deps.litigation.provisions(record.id);
    if (!stage || !provisions.some((provision) => provision.status === 'paid')) {
      throw LitigationErrors.approvalRequired(
        'Un partenaire s’assigne à une étape payante, après l’accord du créancier sur le devis et sa provision.',
      );
    }
    if (active) {
      throw CaseErrors.invalidTransition(
        record.status,
        'Un partenaire suit déjà ce dossier : retirez-le d’abord.',
        record.stage,
      );
    }
    if (partner.status !== 'active') throw LitigationErrors.partnerNotActive(partner.status);
    if (!partnerFitsStage(partner.kind, stage)) {
      throw RecoveryErrors.invalid('partnerId', 'L’étape « huissier » se confie à un huissier de justice.');
    }
    const note = optionalText('note', input.note, 1000);
    const quote = (await this.deps.litigation.feeQuotes(record.id))
      .filter((candidate) => candidate.status === 'accepted' && candidate.partnerId === partner.id)
      .at(-1);
    const assignment: AssignmentRecord = {
      id: this.deps.ids.next(),
      caseId: record.id,
      partnerId: partner.id,
      status: 'active',
      assignedBy: staff.userId,
      assignedAt: now,
      note,
      quoteDocumentId: quote?.documentId ?? null,
      lastUpdateAt: now,
      withdrawnAt: null,
      withdrawReason: null,
      completedAt: null,
    };
    const litigation = noLitigationWrites();
    litigation.assignments.push({ row: assignment, expected: null });
    litigation.partnerDocuments.push(
      ...record.documents
        .filter((document) => MISSION_DOCUMENT_KINDS.has(document.kind) && !document.visibleToPartner)
        .map((document) => document.id),
    );
    const pieces = record.documents.filter((document) => MISSION_DOCUMENT_KINDS.has(document.kind)).length;
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, agentActor(staff.userId), {
        action: 'partner.assigned',
        kind: 'system',
        summary:
          `Dossier confié à ${PARTNER_KIND_LABELS[partner.kind]} ${oneLine(partner.name, 200)}` +
          `${partner.office ? ` (${oneLine(partner.office, 200)})` : ''} : ${pieces} pièce(s) de la mission ` +
          'transmise(s)',
      }),
    );
    changes.events.push({
      type: 'recovery.partner.assigned',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        assignmentId: assignment.id,
        partnerId: partner.id,
        partnerKind: partner.kind,
        partnerUserId: partner.userId,
        assignedAt: now.toISOString(),
      },
    });
    changes.audit.push({
      actorId: staff.userId,
      action: 'partner.assigned',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { assignmentId: assignment.id, partnerId: partner.id },
    });
    await commitLitigation(this.deps, { touch: { caseId: record.id, at: now }, changes, litigation });
    return viewOf(this.deps, record, assignment);
  }
}

/** Retrait motivé d'un partenaire (R-HU-07) : il perd l'accès au dossier, l'historique reste. */
export class WithdrawPartnerUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { caseId: string; assignmentId: string; reason: string }): Promise<AssignmentView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_ROLES, CRITICAL_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const assignment = UUID.test(input.assignmentId ?? '')
      ? await this.deps.litigation.assignment(input.assignmentId.toLowerCase())
      : null;
    if (!assignment || assignment.caseId !== record.id) throw LitigationErrors.assignmentNotFound();
    const reason = oneLine(input.reason ?? '', 2000);
    if (reason.length < 3 || reason.length > 1000) {
      throw RecoveryErrors.invalid('reason', 'Motif de 3 à 1 000 caractères.');
    }
    if (assignment.status === 'withdrawn' && assignment.withdrawReason === reason) {
      return viewOf(this.deps, record, assignment);
    }
    if (assignment.status !== 'active') {
      throw CaseErrors.invalidTransition(
        record.status,
        'Cette assignation n’est plus en cours.',
        record.stage,
      );
    }
    const partner = await this.deps.litigation.partner(assignment.partnerId);
    const withdrawn: AssignmentRecord = {
      ...assignment,
      status: 'withdrawn',
      withdrawnAt: now,
      withdrawReason: reason,
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, agentActor(staff.userId), {
        action: 'partner.withdrawn',
        kind: 'system',
        summary:
          `Dossier retiré ${partner ? `à ${PARTNER_KIND_LABELS[partner.kind]} ${oneLine(partner.name, 200)}` : 'au partenaire'} : ` +
          reason,
      }),
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'partner.withdrawn',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { assignmentId: assignment.id, partnerId: assignment.partnerId },
    });
    const litigation = noLitigationWrites();
    litigation.assignments.push({ row: withdrawn, expected: 'active' });
    await commitLitigation(this.deps, { touch: { caseId: record.id, at: now }, changes, litigation });
    return viewOf(this.deps, record, withdrawn);
  }
}
