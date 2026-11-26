import { isLocalDay, localDay, type LocalDay } from '../../domain/calendar';
import { partnerTransferDeadline } from '../../domain/deadlines';
import { consumeProvisions, LEGAL_ACT_TYPES, type LegalActType } from '../../domain/litigation';
import { FIXED_RULES } from '../../domain/settings';
import { type PlanRecord } from '../amicable/amicable.ports';
import { optionalText } from '../amicable/amicable-rules';
import { longDay } from '../amicable/debtor-messages';
import { UUID } from '../cases/case-input';
import {
  evidenceEntry,
  requireIdempotencyKey,
  requirePage,
  stableId,
  upcomingHolidays,
} from '../cases/case-rules';
import { caseView, type CaseView } from '../cases/case-views';
import { caseSubject } from '../cases/creditor-cases.use-cases';
import { type CaseDocumentData, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { type OfflinePaymentView, offlinePaymentViews } from '../money/money-views';
import {
  OfflinePayments,
  optionalFileId,
  requireAmount,
  requireReceivedOn,
} from '../money/offline-payments.use-cases';
import { loadSettings } from '../settings.use-cases';
import { formatXof, RecoveryErrors } from '../shared/errors';
import {
  ASSIGNMENT_STATUSES,
  type AssignmentRecord,
  type AssignmentStatus,
  type LegalActRecord,
  type LitigationDeps,
  noLitigationWrites,
  type PartnerRecord,
} from './litigation.ports';
import {
  ACT_LABELS,
  commitLitigation,
  LitigationErrors,
  oneLine,
  PARTNER_KIND_LABELS,
  partnerActor,
  requirePartnerUser,
} from './litigation-rules';
import { type AssignmentView, assignmentViews, type NoticeView, noticeViews } from './litigation-views';

/**
 * Accès de l'huissier ou de l'avocat partenaire (UC-RC-21, partie 8), sans double authentification :
 * ses assignations, le dossier prêt de chacune (R-HU-03) avec les seules pièces de sa mission (R-AR-02),
 * ses actes (R-HU-04) et les sommes qu'il a encaissées (R-HU-05). Une assignation d'un autre
 * partenaire, retirée, terminée ou d'un dossier clos répond « introuvable » (404), sans indice.
 */

interface PartnerCaller {
  userId: string;
  partner: PartnerRecord | null;
}

async function currentPartner(deps: LitigationDeps): Promise<PartnerCaller> {
  const { userId } = requirePartnerUser();
  return { userId, partner: await deps.litigation.partnerByUser(userId) };
}

/** Assignation en cours du partenaire connecté, sur un dossier ouvert ; sinon introuvable. */
async function requireOwnAssignment(
  deps: LitigationDeps,
  caller: PartnerCaller,
  assignmentId: string,
): Promise<{ partner: PartnerRecord; assignment: AssignmentRecord; record: RecoveryCaseRecord }> {
  const partner = caller.partner;
  if (!partner || !UUID.test(assignmentId ?? '')) throw LitigationErrors.assignmentNotFound();
  const assignment = await deps.litigation.assignment(assignmentId.toLowerCase());
  if (!assignment || assignment.partnerId !== partner.id || assignment.status !== 'active') {
    throw LitigationErrors.assignmentNotFound();
  }
  const record = await deps.cases.find(assignment.caseId);
  if (!record || (record.status !== 'active' && record.status !== 'suspended')) {
    throw LitigationErrors.assignmentNotFound();
  }
  return { partner, assignment, record };
}

/** Assignations du partenaire connecté (ListMyAssignments) : en cours par défaut. */
export class ListMyAssignmentsUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    statuses: readonly string[];
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: AssignmentView[]; nextCursor: string | null }> {
    const caller = await currentPartner(this.deps);
    const statuses = (input.statuses.length > 0 ? input.statuses : ['active']) as AssignmentStatus[];
    if (statuses.some((status) => !ASSIGNMENT_STATUSES.includes(status))) {
      throw RecoveryErrors.invalid('statuses', `Valeurs attendues : ${ASSIGNMENT_STATUSES.join(', ')}.`);
    }
    const page = requirePage(input.page);
    if (!caller.partner) return { items: [], nextCursor: null };
    const result = await this.deps.litigation.assignmentsOf(caller.partner.id, statuses, page);
    return { items: await assignmentViews(this.deps, result.items), nextCursor: result.nextCursor };
  }
}

/**
 * Dossier prêt d'une assignation (R-HU-03), tel que le partenaire le voit : débiteurs et leurs
 * coordonnées, créances, montants et créancier de la fiche ; le reste de la fiche ne lui est pas montré.
 */
export interface AssignmentFileView {
  assignment: AssignmentView;
  caseView: CaseView;
  /** Pièces marquées visibles du partenaire, seulement (R-AR-02). */
  documents: CaseDocumentData[];
  signedPlan: PlanRecord | null;
  notices: NoticeView[];
}

/** Dossier d'une assignation en cours (GetMyAssignment) ; la consultation est tracée à l'audit. */
export class GetMyAssignmentUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { assignmentId: string }): Promise<AssignmentFileView> {
    const caller = await currentPartner(this.deps);
    const { assignment, record } = await requireOwnAssignment(this.deps, caller, input.assignmentId);
    const { settings } = await loadSettings(this.deps.settings);
    const [views, plans, notices, view] = await Promise.all([
      assignmentViews(this.deps, [{ ...assignment, caseNumber: record.number }]),
      this.deps.amicable.plans(record.id),
      this.deps.litigation.notices(record.id, 'formal_notice'),
      caseView(this.deps, record, settings, this.deps.clock.now()),
    ]);
    await this.deps.audit.record({
      actorId: caller.userId,
      action: 'case.viewed_by_partner',
      entityType: 'recovery_case',
      entityId: record.id,
      details: { assignmentId: assignment.id },
    });
    return {
      assignment: views[0]!,
      caseView: view,
      documents: record.documents.filter((document) => document.visibleToPartner),
      signedPlan: plans.find((plan) => plan.signedAt !== null) ?? null,
      notices: await noticeViews(this.deps, notices),
    };
  }
}

function requireDay(field: string, value: string): LocalDay {
  if (!isLocalDay(value ?? '')) throw RecoveryErrors.invalid(field, 'Date « AAAA-MM-JJ » attendue.');
  return value;
}

/**
 * Acte enregistré par le partenaire (RecordLegalAct, R-HU-04) : date, coût et pièce. Le coût est pris
 * sur les provisions du créancier ; un dépassement est signalé au juriste pour une provision
 * complémentaire, KSP n'avançant aucun frais. Le créancier et le juriste sont prévenus
 * (`recovery.partner.act_recorded`). Rejoué avec la même clé : le même acte.
 */
export class RecordLegalActUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: {
    assignmentId: string;
    idempotencyKey: string;
    type: string;
    actDate: string;
    cost: number | null;
    fileId: string;
    note: string;
    nextStepDate: string;
  }): Promise<LegalActRecord> {
    const caller = await currentPartner(this.deps);
    const key = requireIdempotencyKey(input.idempotencyKey);
    const { partner, assignment, record } = await requireOwnAssignment(this.deps, caller, input.assignmentId);
    const now = this.deps.clock.now();
    const id = stableId('recovery-legal-act', assignment.id, key);
    const type = input.type as LegalActType;
    const known = await this.deps.litigation.act(id);
    if (known) {
      if (known.type !== type || known.actDate !== input.actDate) throw RecoveryErrors.keyReused();
      return known;
    }
    if (!LEGAL_ACT_TYPES.includes(type)) {
      throw RecoveryErrors.invalid('type', `Valeur attendue : ${LEGAL_ACT_TYPES.join(', ')}.`);
    }
    const actDate = requireDay('actDate', input.actDate);
    if (actDate > localDay(now))
      throw RecoveryErrors.invalid('actDate', 'Date de l’acte au plus aujourd’hui.');
    const cost = input.cost ?? 0;
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > 1_000_000_000) {
      throw RecoveryErrors.invalid('cost', 'Coût entier en FCFA, positif ou nul.');
    }
    const fileId = optionalFileId('fileId', input.fileId);
    const note = optionalText('note', input.note, 1000);
    const nextStepDate = input.nextStepDate ? requireDay('nextStepDate', input.nextStepDate) : null;
    if (nextStepDate && nextStepDate < actDate) {
      throw RecoveryErrors.invalid('nextStepDate', 'Prochaine échéance après la date de l’acte.');
    }
    const actor = partnerActor(caller.userId);
    const documents: CaseDocumentData[] = [];
    if (fileId && !record.documents.some((document) => document.fileId === fileId)) {
      await this.deps.files.attach({ fileId, subject: caseSubject(record.id), ownerId: caller.userId });
      documents.push({
        id: stableId('recovery-legal-act-document', id),
        kind: 'legal_act',
        label: `${ACT_LABELS[type]} du ${longDay(actDate)}`,
        fileId,
        documentId: null,
        visibleToPartner: true,
        visibleToDebtor: false,
        addedBy: actor,
        addedAt: now,
      });
    }
    const act: LegalActRecord = {
      id,
      assignmentId: assignment.id,
      caseId: record.id,
      type,
      actDate,
      cost,
      fileId,
      note,
      nextStepDate,
      recordedBy: caller.userId,
      recordedAt: now,
    };
    const litigation = noLitigationWrites();
    litigation.acts.push(act);
    litigation.assignments.push({ row: { ...assignment, lastUpdateAt: now }, expected: 'active' });
    const paid = (await this.deps.litigation.provisions(record.id)).filter((p) => p.status === 'paid');
    const consumption = consumeProvisions(paid, cost);
    consumption.provisions.forEach((balance, index) => {
      const provision = paid[index]!;
      if (balance.consumed !== provision.consumed) {
        litigation.provisions.push({
          row: { ...provision, consumed: balance.consumed },
          expected: provision.consumed,
        });
      }
    });
    const next = { ...record, documents: [...record.documents, ...documents] };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, actor, {
        action: 'partner.act_recorded',
        kind: 'partner_act',
        summary:
          `${ACT_LABELS[type]} du ${longDay(actDate)} enregistré par ${PARTNER_KIND_LABELS[partner.kind]} ` +
          `${oneLine(partner.name, 200)}` +
          (cost > 0 ? ` : coût ${formatXof(cost)}` : '') +
          (nextStepDate ? ` ; prochaine échéance le ${longDay(nextStepDate)}` : ''),
        amount: cost > 0 ? cost : null,
        ...(fileId ? { ref: { type: 'file' as const, id: fileId } } : {}),
      }),
    );
    if (consumption.overrun > 0) {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, actor, {
          action: 'provision.overrun',
          kind: 'system',
          summary:
            `Frais au-delà de la provision du créancier : ${formatXof(consumption.overrun)}. KSP n’avance ` +
            'aucun frais : provision complémentaire à soumettre au créancier par le juriste',
          amount: consumption.overrun,
          internal: true,
        }),
      );
    }
    changes.events.push({
      type: 'recovery.partner.act_recorded',
      payload: {
        caseId: record.id,
        caseNumber: record.number,
        creditor: record.creditor,
        actId: id,
        assignmentId: assignment.id,
        partnerId: partner.id,
        actType: type,
        actDate,
        cost: { amount: cost, currency: 'XOF' },
        recordedAt: now.toISOString(),
      },
    });
    await commitLitigation(
      this.deps,
      documents.length > 0
        ? { record: next, changes, litigation }
        : { touch: { caseId: record.id, at: now }, changes, litigation },
    );
    return act;
  }
}

/**
 * Somme encaissée par le partenaire (DeclarePartnerCollection, R-HU-05) : déclarée depuis son accès,
 * elle attend la somme virée à KSP sous 5 jours ouvrés, que la finance rapproche puis valide à deux,
 * comme un paiement hors ligne (ADR-060, point 8) : elle n'est imputée et créditée qu'à la validation.
 */
export class DeclarePartnerCollectionUseCase {
  private readonly payments: OfflinePayments;

  constructor(private readonly deps: LitigationDeps) {
    this.payments = new OfflinePayments(deps);
  }

  async execute(input: {
    assignmentId: string;
    idempotencyKey: string;
    amount: number | null;
    receivedOn: string;
    proofFileId: string;
    note: string;
  }): Promise<OfflinePaymentView> {
    const caller = await currentPartner(this.deps);
    const key = requireIdempotencyKey(input.idempotencyKey);
    const { partner, assignment, record } = await requireOwnAssignment(this.deps, caller, input.assignmentId);
    const now = this.deps.clock.now();
    const known = await this.deps.money.offlinePaymentByKey(caller.userId, key);
    const payment = await this.payments.declare({
      record,
      source: 'partner',
      amount: requireAmount('amount', input.amount),
      receivedAt: requireReceivedOn('receivedOn', input.receivedOn, now),
      reference: null,
      proofFileId: optionalFileId('proofFileId', input.proofFileId),
      note: optionalText('note', input.note, 500),
      recordedBy: caller.userId,
      actor: partnerActor(caller.userId),
      partnerId: partner.id,
      assignmentId: assignment.id,
      idempotencyKey: key,
      staff: null,
    });
    if (!known) {
      const holidays = await upcomingHolidays(this.deps.holidays, now);
      const transferBy = partnerTransferDeadline(now, FIXED_RULES.partnerTransferBusinessDays, holidays);
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, partnerActor(caller.userId), {
          action: 'partner.collection_declared',
          kind: 'payment',
          summary:
            `${formatXof(payment.amount)} encaissés par ${PARTNER_KIND_LABELS[partner.kind]} ` +
            `${oneLine(partner.name, 200)}, à virer à KSP au plus tard le ${longDay(transferBy)} ; ` +
            'imputés à la validation par la finance',
          amount: payment.amount,
          internal: true,
        }),
      );
      const litigation = noLitigationWrites();
      litigation.assignments.push({ row: { ...assignment, lastUpdateAt: now }, expected: 'active' });
      // La déclaration est enregistrée : la trace du délai de virement ne la remet pas en cause.
      await this.deps.litigation.commit({ touch: { caseId: record.id, at: now }, changes, litigation });
    }
    const [view] = await offlinePaymentViews(this.deps, [{ ...payment, caseNumber: record.number }]);
    return view!;
  }
}
