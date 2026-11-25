import { addDays, localDay } from '../../domain/calendar';
import { changeStatus, reject, type RejectionReason } from '../../domain/case';
import { infoCompletionDeadline } from '../../domain/deadlines';
import { type AuditLog, type FullSettings } from '../ports';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, CASE_READERS, requireStaff, type Staff } from '../shared/access';
import { RecoveryErrors, unwrap } from '../shared/errors';
import { CASE_SUPERVISORS, requireCaseInScope, staffScope } from './case-access';
import { CaseErrors } from './case-errors';
import { type FeeDeps, settleRejectedFee } from './case-fees';
import { UUID } from './case-input';
import {
  agentActor,
  computeScore,
  evidenceEntry,
  injunctionEligible,
  requireIdempotencyKey,
  requirePage,
} from './case-rules';
import { type CaseSummaryView, caseView, type CaseView, displayNames, summaryViews } from './case-views';
import { persist } from './case-writes';
import {
  type CaseDeps,
  journalView,
  type JournalView,
  listFilter,
  recoveryRateBps,
  requireCaseId,
} from './creditor-cases.use-cases';
import {
  type CaseScore,
  type EvidenceActor,
  noChanges,
  type OverviewFigures,
  type RecoveryCaseRecord,
} from './ports';

/** Dépendances du back-office : celles des dossiers, plus le journal d'audit des consultations. */
export interface AdminCaseDeps extends CaseDeps {
  audit: AuditLog;
}

/** Jours sans action au-delà desquels un dossier est signalé (14.6). */
export const IDLE_DAYS = 7;
const REJECTION_REASONS: readonly RejectionReason[] = [
  'prescribed',
  'illegal',
  'no_evidence',
  'debtor_unreachable',
  'other',
];
const DAY_MS = 86_400_000;

function optionalUuid(field: string, value: string): string | undefined {
  if (!value) return undefined;
  if (!UUID.test(value)) throw RecoveryErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

function requireNote(note: string): string {
  const text = note?.trim() ?? '';
  if (text.length < 3 || text.length > 2000) {
    throw RecoveryErrors.invalid('note', 'Motif écrit de 3 à 2 000 caractères, transmis au créancier.');
  }
  return text;
}

export interface OverviewView {
  figures: OverviewFigures;
  recoveryRateBps: number;
  recoveryRateByStage: { stage: string; rateBps: number }[];
  agents: { agentId: string; name: string; openCases: number; recovered: number; recoveryRateBps: number }[];
}

/**
 * Tableau de bord du recouvrement (GetRecoveryOverview, 14.6) : dossiers par étape et par offre,
 * montants confiés et recouvrés, taux par étape et par chargé, échéances du jour, promesses à
 * vérifier, dossiers sans action depuis 7 jours, prescriptions proches, files d'attente. Un chargé
 * seul n'y voit que ses dossiers ; une zone (commune) peut filtrer.
 */
export class GetRecoveryOverviewUseCase {
  constructor(private readonly deps: AdminCaseDeps) {}

  async execute(input: { communeKey: string }): Promise<OverviewView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_READERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const communeKey = input.communeKey?.trim() || null;
    if (communeKey !== null && communeKey.length > 60) {
      throw RecoveryErrors.invalid('communeKey', '60 caractères au plus.');
    }
    const { settings } = await loadSettings(this.deps.settings);
    const today = localDay(now);
    const figures = await this.deps.caseQueries.overview(staffScope(staff, communeKey), today, {
      idleSince: new Date(now.getTime() - IDLE_DAYS * DAY_MS),
      prescriptionBefore: addDays(today, settings.prescriptionAlertDays),
    });
    const names = await displayNames(
      this.deps.directory,
      [],
      figures.agents.map((agent) => agent.agentId),
    );
    return {
      figures,
      recoveryRateBps: recoveryRateBps(figures.recovered, figures.entrusted),
      recoveryRateByStage: figures.recoveredByStageGroup.map((group) => ({
        stage: group.stage,
        rateBps: recoveryRateBps(group.amount, figures.entrusted),
      })),
      agents: figures.agents.map((agent) => ({
        agentId: agent.agentId,
        name: names.user(agent.agentId),
        openCases: agent.openCases,
        recovered: agent.recovered,
        recoveryRateBps: recoveryRateBps(agent.recovered, agent.entrusted),
      })),
    };
  }
}

/** Dossiers du back-office (ListCases), dans le périmètre du membre du personnel. */
export class ListCasesUseCase {
  constructor(private readonly deps: AdminCaseDeps) {}

  async execute(input: {
    statuses: readonly string[];
    stages: readonly string[];
    kinds: readonly string[];
    assignedAgentId: string;
    creditorId: string;
    partnerId: string;
    communeKey: string;
    search: string;
    idleDays: number;
    prescriptionNear: boolean;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: CaseSummaryView[]; nextCursor: string | null; total: number }> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_READERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const page = requirePage(input.page);
    const { settings } = await loadSettings(this.deps.settings);
    const filter = listFilter(input);
    const agent = optionalUuid('filter.assignedAgentId', input.assignedAgentId);
    const creditorId = optionalUuid('filter.creditorId', input.creditorId);
    const partnerId = optionalUuid('filter.partnerId', input.partnerId);
    if (creditorId) filter.creditorId = creditorId;
    if (partnerId) filter.partnerId = partnerId;
    if (input.communeKey?.trim()) filter.communeKey = input.communeKey.trim();
    if (input.idleDays) {
      if (!Number.isSafeInteger(input.idleDays) || input.idleDays < 0 || input.idleDays > 3650) {
        throw RecoveryErrors.invalid('filter.idleDays', 'Nombre de jours de 0 à 3 650.');
      }
      filter.idleSince = new Date(now.getTime() - input.idleDays * DAY_MS);
    }
    if (input.prescriptionNear)
      filter.prescriptionBefore = addDays(localDay(now), settings.prescriptionAlertDays);
    const scope = staffScope(staff);
    if (scope.agentId !== null) {
      // Un chargé ne voit que ses dossiers, même s'il en demande d'autres.
      if (agent && agent !== scope.agentId) return { items: [], nextCursor: null, total: 0 };
      filter.assignedAgentId = scope.agentId;
    } else if (agent) {
      filter.assignedAgentId = agent;
    }
    const result = await this.deps.caseQueries.list(filter, page);
    return {
      items: await summaryViews(this.deps, result.items, settings, now),
      nextCursor: result.nextCursor,
      total: result.total,
    };
  }
}

export interface AdminCaseView {
  view: CaseView;
  /** Score enregistré, ou calculé à la volée pendant l'examen (R-SD-07) ; null avant l'envoi. */
  score: CaseScore | null;
  injunctionEligible: boolean;
}

/**
 * Fiche complète d'un dossier (GetCase) : débiteurs et contacts, montants, étapes, pièces, détail du
 * score et critères de l'injonction de payer. Chaque consultation est tracée au journal d'audit.
 */
export class GetCaseUseCase {
  constructor(private readonly deps: AdminCaseDeps) {}

  async execute(input: { caseId: string }): Promise<AdminCaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_READERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const { settings } = await loadSettings(this.deps.settings);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'case.viewed',
      entityType: 'recovery_case',
      entityId: record.id,
      details: { number: record.number },
    });
    const reviewing = record.status === 'under_review' || record.status === 'info_requested';
    return {
      view: await caseView(this.deps, record, settings, now),
      score: record.score ?? (reviewing ? computeScore(record, settings, now) : null),
      injunctionEligible: injunctionEligible(record, localDay(now)),
    };
  }
}

/** Journal complet d'un dossier (ListCaseJournal), notes internes comprises sur demande. */
export class ListCaseJournalUseCase {
  constructor(private readonly deps: AdminCaseDeps) {}

  async execute(input: {
    caseId: string;
    includeInternal: boolean;
    page?: { limit?: number; cursor?: string };
  }): Promise<JournalView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_READERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const page = await this.deps.caseQueries.journal(
      record.id,
      { includeInternal: input.includeInternal },
      requirePage(input.page),
    );
    return journalView(this.deps, page.items, page.nextCursor);
  }
}

/**
 * Refus d'un dossier (4.4) : irrecevable par le superviseur, ou classé faute de complément par la
 * tâche des échéances (`incomplete`). L'état, le journal et `recovery.case.rejected` (montant net
 * remboursé : frais moins forfait d'étude) sont écrits ensemble ; viennent ensuite le remboursement
 * du débit entier et le débit du forfait d'étude, repris par la tâche s'ils n'aboutissent pas.
 */
export async function rejectCase(
  deps: FeeDeps,
  record: RecoveryCaseRecord,
  input: {
    reason: RejectionReason;
    note: string;
    actor: EvidenceActor;
    staff: Staff | null;
    assessmentKey: string | null;
  },
): Promise<RecoveryCaseRecord> {
  const now = deps.clock.now();
  const state = unwrap(reject(record, input.reason));
  const next: RecoveryCaseRecord = {
    ...record,
    status: state.status,
    rejectionReason: state.rejectionReason,
    reviewNote: input.note,
    infoRequestedAt: null,
    assessmentKey: input.assessmentKey ?? record.assessmentKey,
  };
  const refunded = next.fee.paidAt ? Math.max(0, next.fee.amount - next.fee.studyFee) : 0;
  const changes = noChanges();
  changes.evidence.push(
    evidenceEntry(deps.ids, next, now, input.actor, {
      action: 'case.rejected',
      kind: 'status_changed',
      summary:
        input.reason === 'incomplete'
          ? 'Dossier classé : complément non fourni dans le délai'
          : 'Dossier déclaré irrecevable ; motif transmis au créancier',
    }),
  );
  changes.events.push({
    type: 'recovery.case.rejected',
    payload: {
      caseId: next.id,
      caseNumber: next.number,
      creditor: next.creditor,
      reason: input.reason,
      refundedAmount: { amount: refunded, currency: 'XOF' },
      rejectedAt: now.toISOString(),
    },
  });
  if (input.staff) {
    changes.audit.push({
      actorId: input.staff.userId,
      action: 'case.rejected',
      entityType: 'recovery_case',
      entityId: next.id,
      at: now,
      details: { reason: input.reason, refunded },
    });
  }
  const saved = await persist(deps.cases, next, changes, { now });
  return (await settleRejectedFee(deps, saved)).record;
}

/**
 * Recevabilité (AssessCase, UC-RC-14) par un superviseur : recevable (le dossier devient actif à
 * l'étape de notification, score R-SD-07, chargé affecté s'il est désigné, `recovery.case.accepted` ;
 * rien n'est envoyé au débiteur ici), complément demandé (motif écrit, délai réglable,
 * `recovery.case.info_requested`), ou irrecevable (motif écrit, frais remboursés moins le forfait
 * d'étude). Rejouée avec la même clé, elle rend le dossier sans rien refaire.
 */
export class AssessCaseUseCase {
  constructor(private readonly deps: AdminCaseDeps) {}

  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    decision: string;
    note: string;
    agentUserId: string;
    rejectionReason: string;
  }): Promise<CaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_SUPERVISORS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const { settings } = await loadSettings(this.deps.settings);
    if (record.assessmentKey === key) return caseView(this.deps, record, settings, now);
    let next: RecoveryCaseRecord;
    switch (input.decision) {
      case 'accept':
        next = await this.accept(record, staff, key, input, settings);
        break;
      case 'request_info':
        next = await this.requestInfo(record, staff, key, input.note, settings);
        break;
      case 'reject': {
        const reason = input.rejectionReason as RejectionReason;
        if (!REJECTION_REASONS.includes(reason)) {
          throw RecoveryErrors.invalid(
            'rejectionReason',
            `Valeur attendue : ${REJECTION_REASONS.join(', ')} (« incomplete » est réservé au classement automatique).`,
          );
        }
        if (record.status !== 'under_review' && record.status !== 'info_requested') {
          throw CaseErrors.invalidTransition(
            record.status,
            'Seul un dossier en examen se déclare irrecevable.',
          );
        }
        next = await rejectCase(this.deps, record, {
          reason,
          note: requireNote(input.note),
          actor: agentActor(staff.userId),
          staff,
          assessmentKey: key,
        });
        break;
      }
      default:
        throw RecoveryErrors.invalid('decision', 'Valeur attendue : accept, request_info, reject.');
    }
    return caseView(this.deps, next, settings, now);
  }

  private async accept(
    record: RecoveryCaseRecord,
    staff: Staff,
    key: string,
    input: { note: string; agentUserId: string },
    settings: FullSettings,
  ): Promise<RecoveryCaseRecord> {
    const now = this.deps.clock.now();
    if (record.status !== 'under_review') {
      throw CaseErrors.invalidTransition(record.status, 'Seul un dossier en examen se déclare recevable.');
    }
    const agentId = optionalUuid('agentUserId', input.agentUserId) ?? record.assignedAgentId;
    const note = input.note?.trim() ?? '';
    if (note.length > 2000) throw RecoveryErrors.invalid('note', '2 000 caractères au plus.');
    const state = unwrap(changeStatus(record, 'active'));
    const score = computeScore(record, settings, now);
    const next: RecoveryCaseRecord = {
      ...record,
      status: state.status,
      stage: state.stage,
      highestStage: state.highestStage,
      acceptedAt: now,
      assignedAgentId: agentId,
      score,
      reviewNote: note || null,
      assessmentKey: key,
    };
    const actor = agentActor(staff.userId);
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, actor, {
        action: 'case.accepted',
        kind: 'status_changed',
        summary: `Dossier déclaré recevable (score de recouvrabilité ${score.value}/100)`,
      }),
    );
    if (agentId && agentId !== record.assignedAgentId) {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, actor, {
          action: 'case.assigned',
          kind: 'system',
          summary: 'Dossier affecté à un chargé de recouvrement',
        }),
      );
    }
    changes.stageTransitions.push({
      id: this.deps.ids.next(),
      from: null,
      to: state.stage!,
      at: now,
      by: actor,
      reason: 'Dossier recevable',
      skipReason: null,
    });
    const ref = { caseId: next.id, caseNumber: next.number, creditor: next.creditor };
    changes.events.push(
      {
        type: 'recovery.case.accepted',
        payload: {
          ...ref,
          kind: next.kind,
          assignedAgentId: agentId,
          score: score.value,
          acceptedAt: now.toISOString(),
        },
      },
      {
        type: 'recovery.case.stage_changed',
        payload: {
          ...ref,
          kind: next.kind,
          fromStage: null,
          toStage: state.stage!,
          skipReason: null,
          changedBy: 'staff',
          changedAt: now.toISOString(),
        },
      },
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'case.accepted',
      entityType: 'recovery_case',
      entityId: next.id,
      at: now,
      details: { score: score.value, assignedAgentId: agentId },
    });
    return persist(this.deps.cases, next, changes, { now });
  }

  private async requestInfo(
    record: RecoveryCaseRecord,
    staff: Staff,
    key: string,
    rawNote: string,
    settings: FullSettings,
  ): Promise<RecoveryCaseRecord> {
    const now = this.deps.clock.now();
    if (record.status !== 'under_review') {
      throw CaseErrors.invalidTransition(record.status, 'Un complément se demande sur un dossier en examen.');
    }
    const note = requireNote(rawNote);
    const state = unwrap(changeStatus(record, 'info_requested'));
    const dueAt = infoCompletionDeadline(now, settings);
    const next: RecoveryCaseRecord = {
      ...record,
      status: state.status,
      infoRequestedAt: now,
      reviewNote: note,
      completionNote: null,
      assessmentKey: key,
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, agentActor(staff.userId), {
        action: 'case.info_requested',
        kind: 'status_changed',
        summary: `Complément demandé au créancier, à fournir avant le ${localDay(dueAt)}`,
      }),
    );
    changes.events.push({
      type: 'recovery.case.info_requested',
      payload: {
        caseId: next.id,
        caseNumber: next.number,
        creditor: next.creditor,
        completionDueAt: dueAt.toISOString(),
        requestedAt: now.toISOString(),
      },
    });
    changes.audit.push({
      actorId: staff.userId,
      action: 'case.info_requested',
      entityType: 'recovery_case',
      entityId: next.id,
      at: now,
      details: { completionDueAt: dueAt.toISOString() },
    });
    return persist(this.deps.cases, next, changes, { now });
  }
}

/** Statuts où un dossier s'affecte à un chargé : envoyé, pas encore refusé ni clos. */
const ASSIGNABLE = new Set(['under_review', 'info_requested', 'active', 'suspended']);

/**
 * Affectation d'un dossier à un chargé (AssignCase) par un superviseur. Le rôle du chargé n'est pas
 * vérifié ici (identity ne le transmet pas aux services) : il ne verra le dossier que s'il est
 * `recovery_agent` ou au-dessus.
 */
export class AssignCaseUseCase {
  constructor(private readonly deps: AdminCaseDeps) {}

  async execute(input: { caseId: string; agentUserId: string }): Promise<CaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_SUPERVISORS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const agentId = optionalUuid('agentUserId', input.agentUserId);
    if (!agentId) throw RecoveryErrors.invalid('agentUserId', 'Chargé obligatoire.');
    const { settings } = await loadSettings(this.deps.settings);
    if (!ASSIGNABLE.has(record.status)) {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier ne s’affecte pas dans son état.');
    }
    if (record.assignedAgentId === agentId) return caseView(this.deps, record, settings, now);
    const next = { ...record, assignedAgentId: agentId };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, agentActor(staff.userId), {
        action: 'case.assigned',
        kind: 'system',
        summary: record.assignedAgentId
          ? 'Dossier réaffecté à un autre chargé de recouvrement'
          : 'Dossier affecté à un chargé de recouvrement',
      }),
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'case.assigned',
      entityType: 'recovery_case',
      entityId: next.id,
      at: now,
      details: { from: record.assignedAgentId, to: agentId },
    });
    const saved = await persist(this.deps.cases, next, changes, { now });
    return caseView(this.deps, saved, settings, now);
  }
}
