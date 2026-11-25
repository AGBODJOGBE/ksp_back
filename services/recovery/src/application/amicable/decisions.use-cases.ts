import { AppError } from '@ksp/platform';
import { settlementTerms } from '../../domain/amicable';
import { addDays, localDay } from '../../domain/calendar';
import {
  advanceStage,
  close,
  type CaseStage,
  requestStageSkip,
  type SkipReason,
  skipStage,
  STAGE_ORDER,
} from '../../domain/case';
import {
  answerDecision,
  type DecisionAnswer,
  type DecisionStatus,
  expireDecision,
  openDecision,
} from '../../domain/decision';
import { FIXED_RULES } from '../../domain/settings';
import { creditorWriter, requireCaseInScope, requireOwnCase } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import {
  agentActor,
  amountDue,
  creditorActor,
  effectiveScale,
  evidenceEntry,
  requireIdempotencyKey,
  requirePage,
  stableId,
  SYSTEM,
} from '../cases/case-rules';
import { caseView, type CaseView } from '../cases/case-views';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import { type CaseChanges, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { DebtorLinks } from '../debtor-access/debtor-links.service';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, currentCreditor, requireStaff } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import {
  type AmicableChanges,
  type AmicableDeps,
  type DecisionRecord,
  noAmicableChanges,
  type PlanRecord,
  type SettlementRecord,
} from './amicable.ports';
import {
  AmicableErrors,
  applyStageMove,
  CASE_WORKERS,
  caseRef,
  commitAction,
  decisionRequested,
  optionalText,
  requireActive,
  requireDay,
  sendPlanForSignature,
  STAGE_CHANGERS,
  STAGE_LABELS,
  STAGE_SKIPPERS,
} from './amicable-rules';
import { longDay } from './debtor-messages';

/** Durée de validité d'une remise proposée : 30 jours au plus. */
const SETTLEMENT_MAX_DAYS = 30;
const DECISION_STATUSES: readonly DecisionStatus[] = [
  'pending',
  'approved',
  'rejected',
  'answered',
  'expired',
];
const SKIP_REASONS: readonly SkipReason[] = ['prescription_near', 'asset_flight_risk'];

/** Remise pour paiement immédiat (R-PR-05), proposée par le chargé. */
export class ProposeSettlementUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  /**
   * Dans le barème du créancier, la remise est offerte au débiteur (son espace l'affiche jusqu'à la
   * date de validité) ; au-delà, elle est soumise au créancier (décision `settlement_discount`, 3
   * jours). Une nouvelle remise remplace celle qui était offerte ; une remise soumise au créancier
   * attend sa réponse.
   */
  async execute(input: {
    caseId: string;
    idempotencyKey: string;
    payNow: number | null;
    validUntil: string;
    note: string;
  }): Promise<SettlementRecord> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_WORKERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const id = stableId('recovery-settlement', record.id, staff.userId, key);
    const known = await this.deps.amicable.settlement(id);
    if (known) return known;
    requireActive(record);
    const { settings } = await loadSettings(this.deps.settings);
    const scale = effectiveScale(record, settings);
    const terms = unwrap(settlementTerms(amountDue(record), input.payNow ?? 0, scale.maxDiscountBps));
    const today = localDay(now);
    const validUntil = requireDay('validUntil', input.validUntil);
    if (validUntil < today || validUntil > addDays(today, SETTLEMENT_MAX_DAYS)) {
      throw RecoveryErrors.invalid('validUntil', `Date de validité dans les ${SETTLEMENT_MAX_DAYS} jours.`);
    }
    const existing = await this.deps.amicable.settlements(record.id);
    if (existing.some((settlement) => settlement.status === 'pending_creditor')) {
      throw CaseErrors.invalidTransition(
        record.status,
        'Une remise attend déjà la décision du créancier.',
        record.stage,
      );
    }
    const settlement: SettlementRecord = {
      id,
      caseId: record.id,
      payNow: terms.payNow,
      waived: terms.waived,
      discountBps: terms.discountBps,
      validUntil,
      status: terms.withinScale ? 'proposed' : 'pending_creditor',
      withinScale: terms.withinScale,
      proposedBy: staff.userId,
      note: optionalText('note', input.note, 1000),
      createdAt: now,
      answeredAt: null,
    };
    const changes = noChanges();
    const amicable = noAmicableChanges();
    for (const offered of existing.filter(
      (other) => other.status === 'proposed' || other.status === 'accepted',
    )) {
      amicable.settlements.push({ row: { ...offered, status: 'expired' }, expected: offered.status });
    }
    amicable.settlements.push({ row: settlement, expected: null });
    const offer =
      `payer ${formatXof(terms.payNow)} avant le ${longDay(validUntil)} contre l’abandon de ` +
      `${formatXof(terms.waived)} (remise de ${(terms.discountBps / 100).toLocaleString('fr-FR')} %)`;
    const actor = agentActor(staff.userId);
    if (terms.withinScale) {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, actor, {
          action: 'settlement.proposed',
          kind: 'decision',
          summary: `Remise dans le barème offerte au débiteur : ${offer}`,
          amount: terms.payNow,
        }),
      );
    } else {
      const decision = newDecision(
        this.deps,
        record,
        'settlement_discount',
        { settlementId: id },
        staff.userId,
        settings,
      );
      amicable.decisions.push({ row: decision, expected: null });
      changes.events.push(decisionRequested(record, decision));
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, actor, {
          action: 'decision.requested',
          kind: 'decision',
          summary:
            `Remise au-delà du barème soumise au créancier jusqu’au ${longDay(localDay(decision.expiresAt))} : ` +
            offer,
          amount: terms.payNow,
        }),
      );
    }
    await commitAction(this.deps, { touch: { caseId: record.id, at: now }, changes, amicable });
    return settlement;
  }
}

function newDecision(
  deps: Pick<AmicableDeps, 'ids' | 'clock'>,
  record: RecoveryCaseRecord,
  kind: DecisionRecord['kind'],
  payload: DecisionRecord['payload'],
  requestedBy: string,
  settings: Parameters<typeof openDecision>[2],
): DecisionRecord {
  const opened = openDecision(kind, deps.clock.now(), settings);
  return {
    id: deps.ids.next(),
    caseId: record.id,
    kind,
    status: opened.status,
    payload,
    requestedBy,
    requestedAt: opened.createdAt,
    expiresAt: opened.expiresAt,
    decidedAt: null,
    decidedBy: null,
    answer: null,
  };
}

/**
 * Changement d'étape manuel (ChangeCaseStage) : escalade validée par le superviseur ou le juriste
 * (relance amiable → mise en demeure, notification → relance amiable). L'étape « échéancier » s'ouvre
 * à la signature d'un échéancier ; les étapes payantes passent par le devis et la provision
 * (`RECOVERY_CREDITOR_APPROVAL_REQUIRED`). Un saut d'étape (R-PR-03, juriste) ouvre une décision
 * `stage_skip` du créancier et répond `RECOVERY_CREDITOR_APPROVAL_REQUIRED` (détails : décision et
 * échéance) tant qu'elle n'est pas prise : l'étape change à son acceptation.
 */
export class ChangeCaseStageUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    caseId: string;
    toStage: string;
    reason: string;
    skipReason: string;
  }): Promise<CaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(STAGE_CHANGERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const to = input.toStage as CaseStage;
    if (!STAGE_ORDER.includes(to)) {
      throw RecoveryErrors.invalid('toStage', `Valeur attendue : ${STAGE_ORDER.join(', ')}.`);
    }
    const reason = optionalText('reason', input.reason, 500);
    if (!reason || reason.length < 3) throw RecoveryErrors.invalid('reason', 'Motif de 3 à 500 caractères.');
    requireActive(record);
    const { settings } = await loadSettings(this.deps.settings);
    const actor = agentActor(staff.userId);
    const changes = noChanges();

    if (input.skipReason) {
      const skipReason = input.skipReason as SkipReason;
      if (!SKIP_REASONS.includes(skipReason)) {
        throw RecoveryErrors.invalid('skipReason', `Valeur attendue : ${SKIP_REASONS.join(', ')}.`);
      }
      if (!STAGE_SKIPPERS.some((role) => staff.roles.has(role))) {
        throw AppError.forbidden('AUTH_FORBIDDEN', 'Un saut d’étape est demandé par le juriste.');
      }
      const request = unwrap(
        requestStageSkip(record, to, {
          reason: skipReason,
          prescriptionDate: record.prescriptionDate,
          today: localDay(now),
          prescriptionNearDays: FIXED_RULES.prescriptionNearDays,
        }),
      );
      let decision = await this.deps.amicable.pendingDecision(record.id, 'stage_skip');
      if (!decision) {
        decision = newDecision(
          this.deps,
          record,
          'stage_skip',
          { skip: { from: request.from, to: request.to, reason: skipReason, note: reason } },
          staff.userId,
          settings,
        );
        const amicable = noAmicableChanges();
        amicable.decisions.push({ row: decision, expected: null });
        changes.events.push(decisionRequested(record, decision));
        changes.evidence.push(
          evidenceEntry(this.deps.ids, record, now, actor, {
            action: 'decision.requested',
            kind: 'decision',
            summary:
              `Saut d’étape vers « ${STAGE_LABELS[to]} » demandé au créancier (` +
              `${skipReason === 'prescription_near' ? 'prescription proche' : 'risque de disparition des biens'}` +
              `) : ${reason}`,
          }),
        );
        changes.audit.push({
          actorId: staff.userId,
          action: 'case.stage_skip_requested',
          entityType: 'recovery_case',
          entityId: record.id,
          at: now,
          details: { from: request.from, to, skipReason, decisionId: decision.id },
        });
        await commitAction(this.deps, { touch: { caseId: record.id, at: now }, changes, amicable });
      } else if (decision.payload.skip?.to !== to) {
        throw CaseErrors.invalidTransition(
          record.status,
          'Un autre saut d’étape attend la décision du créancier.',
          record.stage,
        );
      }
      throw AppError.precondition(
        'RECOVERY_CREDITOR_APPROVAL_REQUIRED',
        'Un saut d’étape demande l’accord du créancier : la décision lui est soumise.',
        { decisionId: decision.id, expiresAt: decision.expiresAt.toISOString() },
      );
    }

    if (to === 'payment_plan') {
      throw CaseErrors.invalidTransition(
        record.status,
        'L’étape « échéancier » s’ouvre à la signature d’un échéancier par le débiteur.',
        record.stage,
      );
    }
    const next = applyStageMove(
      this.deps.ids,
      record,
      unwrap(advanceStage(record, to)),
      {
        actor,
        changedBy: 'staff',
        reason,
        at: now,
      },
      changes,
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'case.stage_changed',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: { from: record.stage, to },
    });
    await commitAction(this.deps, { record: next, changes, amicable: noAmicableChanges() });
    const saved = await this.deps.cases.find(record.id);
    return caseView(this.deps, saved ?? next, settings, now);
  }
}

/** Décision présentée : son dossier, et l'échéancier ou la remise qu'elle porte. */
export interface DecisionView {
  decision: DecisionRecord;
  caseNumber: string;
  plan: PlanRecord | null;
  settlement: SettlementRecord | null;
}

async function decisionView(
  deps: AmicableDeps,
  decision: DecisionRecord,
  caseNumber: string,
): Promise<DecisionView> {
  const { planId, settlementId } = decision.payload;
  return {
    decision,
    caseNumber,
    plan: planId ? await deps.amicable.plan(planId) : null,
    settlement: settlementId ? await deps.amicable.settlement(settlementId) : null,
  };
}

/** Décisions du créancier connecté (ListMyDecisions, UC-RC-06, 07) : en attente par défaut. */
export class ListMyDecisionsUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    statuses: readonly string[];
    caseId: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: DecisionView[]; nextCursor: string | null }> {
    const creditor = currentCreditor();
    const statuses = (input.statuses.length > 0 ? input.statuses : ['pending']) as DecisionStatus[];
    if (statuses.some((status) => !DECISION_STATUSES.includes(status))) {
      throw RecoveryErrors.invalid('statuses', `Valeurs attendues : ${DECISION_STATUSES.join(', ')}.`);
    }
    const caseId = input.caseId ? requireCaseId(input.caseId) : null;
    const page = await this.deps.amicable.decisionsOf(
      creditor.holder,
      { statuses, caseId },
      requirePage(input.page),
    );
    const items: DecisionView[] = [];
    for (const item of page.items) items.push(await decisionView(this.deps, item.decision, item.caseNumber));
    return { items, nextCursor: page.nextCursor };
  }
}

/** Effet d'une réponse du créancier : lignes et dossier à écrire. */
interface Effect {
  record: RecoveryCaseRecord | null;
  summary: string;
}

/**
 * Réponse du créancier (AnswerDecision, UC-RC-06, 07), une fois, avant l'échéance
 * (`RECOVERY_DECISION_CLOSED` sinon) : échéancier hors barème accepté (protocole envoyé à la signature
 * du débiteur) ou refusé ; remise acceptée (offerte au débiteur) ou refusée ; saut d'étape accepté
 * (exécuté, conditions contrôlées de nouveau) ou refusé ; contestation : réponse et pièces, la suite
 * revenant au juriste. Les devis des étapes payantes arrivent avec l'huissier. Rejouée avec la même
 * clé, elle rend l'état sans rien refaire.
 */
export class AnswerDecisionUseCase {
  constructor(private readonly deps: AmicableDeps) {}

  async execute(input: {
    decisionId: string;
    idempotencyKey: string;
    answer: string;
    comment: string;
    fileIds: readonly string[];
  }): Promise<{ decision: DecisionView; view: CaseView }> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const key = requireIdempotencyKey(input.idempotencyKey);
    if (!UUID.test(input.decisionId ?? '')) throw AmicableErrors.decisionNotFound();
    const decision = await this.deps.amicable.decision(input.decisionId.toLowerCase());
    if (!decision) throw AmicableErrors.decisionNotFound();
    let record: RecoveryCaseRecord;
    try {
      record = requireOwnCase(await this.deps.cases.find(decision.caseId), creditor);
    } catch {
      throw AmicableErrors.decisionNotFound();
    }
    const { settings } = await loadSettings(this.deps.settings);
    if (decision.answer?.idempotencyKey === key) {
      return {
        decision: await decisionView(this.deps, decision, record.number),
        view: await caseView(this.deps, record, settings, now),
      };
    }
    const answer = input.answer as DecisionAnswer;
    if (!['approve', 'reject', 'answer'].includes(answer)) {
      throw RecoveryErrors.invalid('answer', 'Valeur attendue : approve, reject, answer.');
    }
    const comment = optionalText('comment', input.comment, 2000);
    if (input.fileIds.length > 10 || input.fileIds.some((id) => !UUID.test(id))) {
      throw RecoveryErrors.invalid('fileIds', '10 pièces au plus, identifiants valides.');
    }
    const answered = answerDecision({ ...decision, createdAt: decision.requestedAt }, answer, now);
    if (!answered.ok && answered.code === 'RECOVERY_DECISION_CLOSED')
      throw AmicableErrors.decisionClosed(decision.status);
    const status = unwrap(answered).status;

    const changes = noChanges();
    const amicable = noAmicableChanges();
    const effect = await this.effect(
      record,
      decision,
      answer,
      creditor.userId,
      input.fileIds,
      changes,
      amicable,
    );
    const next: DecisionRecord = {
      ...decision,
      status,
      decidedAt: now,
      decidedBy: creditor.userId,
      answer: { answer, comment, fileIds: input.fileIds.map((id) => id.toLowerCase()), idempotencyKey: key },
    };
    amicable.decisions.push({ row: next, expected: 'pending' });
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, creditorActor(creditor.userId), {
        action: 'decision.answered',
        kind: 'decision',
        summary: effect.summary,
      }),
    );
    await commitAction(this.deps, {
      ...(effect.record ? { record: effect.record } : { touch: { caseId: record.id, at: now } }),
      changes,
      amicable,
    });
    const saved = (await this.deps.cases.find(record.id)) ?? record;
    return {
      decision: await decisionView(this.deps, next, record.number),
      view: await caseView(this.deps, saved, settings, now),
    };
  }

  private async effect(
    record: RecoveryCaseRecord,
    decision: DecisionRecord,
    answer: DecisionAnswer,
    userId: string,
    fileIds: readonly string[],
    changes: CaseChanges,
    amicable: AmicableChanges,
  ): Promise<Effect> {
    const now = this.deps.clock.now();
    const approved = answer === 'approve';
    switch (decision.kind) {
      case 'plan_off_scale': {
        const plan = decision.payload.planId ? await this.deps.amicable.plan(decision.payload.planId) : null;
        if (!plan || plan.status !== 'pending_creditor') {
          throw CaseErrors.invalidTransition(
            record.status,
            'Cet échéancier n’attend plus de décision.',
            record.stage,
          );
        }
        if (!approved) {
          amicable.plans.push({ row: { ...plan, status: 'rejected', endedAt: now }, expected: plan.version });
          return {
            record: null,
            summary: `Échéancier hors barème de ${formatXof(plan.total)} refusé par le créancier`,
          };
        }
        requireActive(record);
        const { settings } = await loadSettings(this.deps.settings);
        const sent = await sendPlanForSignature(this.deps, record, plan, settings);
        amicable.plans.push({ row: sent, expected: plan.version });
        return {
          record: null,
          summary:
            `Échéancier hors barème de ${formatXof(plan.total)} accepté par le créancier : protocole envoyé à ` +
            'la signature du débiteur',
        };
      }
      case 'settlement_discount': {
        const settlement = decision.payload.settlementId
          ? await this.deps.amicable.settlement(decision.payload.settlementId)
          : null;
        if (!settlement || settlement.status !== 'pending_creditor') {
          throw CaseErrors.invalidTransition(
            record.status,
            'Cette remise n’attend plus de décision.',
            record.stage,
          );
        }
        amicable.settlements.push({
          row: { ...settlement, status: approved ? 'accepted' : 'rejected', answeredAt: now },
          expected: 'pending_creditor',
        });
        return {
          record: null,
          summary: approved
            ? `Remise acceptée par le créancier : ${formatXof(settlement.payNow)} à payer avant le ${longDay(settlement.validUntil)}, offerte au débiteur`
            : 'Remise refusée par le créancier',
        };
      }
      case 'stage_skip': {
        const skip = decision.payload.skip;
        if (!skip) throw CaseErrors.invalidTransition(record.status, 'Saut d’étape inconnu.', record.stage);
        if (!approved)
          return {
            record: null,
            summary: `Saut d’étape vers « ${STAGE_LABELS[skip.to]} » refusé par le créancier`,
          };
        requireActive(record);
        const move = unwrap(
          skipStage(
            record,
            skip.to,
            {
              reason: skip.reason,
              prescriptionDate: record.prescriptionDate,
              today: localDay(now),
              prescriptionNearDays: FIXED_RULES.prescriptionNearDays,
            },
            true,
          ),
        );
        const next = applyStageMove(
          this.deps.ids,
          record,
          move,
          {
            actor: creditorActor(userId),
            changedBy: 'staff',
            reason: `Saut d’étape accepté par le créancier : ${skip.note}`,
            at: now,
          },
          changes,
        );
        return {
          record: next,
          summary: `Saut d’étape vers « ${STAGE_LABELS[skip.to]} » accepté par le créancier`,
        };
      }
      case 'dispute_response': {
        for (const fileId of fileIds) {
          await this.deps.files.attach({
            fileId: fileId.toLowerCase(),
            subject: caseSubject(record.id),
            ownerId: userId,
          });
        }
        return {
          record: null,
          summary: `Réponse du créancier à la contestation${fileIds.length ? `, avec ${fileIds.length} pièce(s)` : ''} : décision du juriste à suivre`,
        };
      }
      default:
        throw CaseErrors.invalidTransition(
          record.status,
          'Les devis des étapes payantes se valident avec l’assignation de l’huissier.',
          record.stage,
        );
    }
  }
}

/**
 * Décision restée sans réponse à son échéance (tâche de la procédure amiable) : refus de l'échéancier
 * ou de la remise, saut d'étape abandonné, décision du juriste pour une contestation, dossier clos
 * « abandon par le créancier » pour une étape payante (R-PR-04). Rend faux si la décision n'était plus
 * à expirer.
 */
export async function expirePendingDecision(deps: AmicableDeps, decision: DecisionRecord): Promise<boolean> {
  const now = deps.clock.now();
  const expired = expireDecision({ ...decision, createdAt: decision.requestedAt }, now);
  if (!expired) return false;
  const record = await deps.cases.find(decision.caseId);
  if (!record) return false;
  const changes = noChanges();
  const amicable = noAmicableChanges();
  let closed: RecoveryCaseRecord | null = null;
  let summary: string;
  if (decision.kind === 'plan_off_scale') {
    const plan = decision.payload.planId ? await deps.amicable.plan(decision.payload.planId) : null;
    if (plan?.status === 'pending_creditor') {
      amicable.plans.push({ row: { ...plan, status: 'rejected', endedAt: now }, expected: plan.version });
    }
    summary = 'Échéancier hors barème refusé : pas de réponse du créancier dans le délai';
  } else if (decision.kind === 'settlement_discount') {
    const settlement = decision.payload.settlementId
      ? await deps.amicable.settlement(decision.payload.settlementId)
      : null;
    if (settlement?.status === 'pending_creditor') {
      amicable.settlements.push({
        row: { ...settlement, status: 'rejected', answeredAt: now },
        expected: 'pending_creditor',
      });
    }
    summary = 'Remise refusée : pas de réponse du créancier dans le délai';
  } else if (expired.effect === 'legal_officer_decides') {
    summary = 'Contestation sans réponse du créancier dans le délai : le juriste décide';
  } else if (expired.effect === 'abandon_case') {
    summary = 'Étape payante sans accord du créancier dans le délai : dossier clos, abandon par le créancier';
    if (record.status === 'active' || record.status === 'suspended') {
      const state = unwrap(close(record, 'abandoned_by_creditor'));
      closed = { ...record, status: state.status, closureReason: state.closureReason, updatedAt: now };
      changes.events.push({
        type: 'recovery.case.closed',
        payload: {
          ...caseRef(record),
          kind: record.kind,
          reason: 'abandoned_by_creditor',
          totalCollected: {
            amount: await deps.amicable.collectedSince(record.id, new Date(0)),
            currency: 'XOF',
          },
          settlementCertificateDocumentId: null,
          closedAt: now.toISOString(),
        },
      });
    }
  } else {
    summary = 'Saut d’étape abandonné : pas de réponse du créancier dans le délai';
  }
  amicable.decisions.push({
    row: { ...decision, status: expired.decision.status, decidedAt: now },
    expected: 'pending',
  });
  changes.evidence.push(
    evidenceEntry(deps.ids, record, now, SYSTEM, { action: 'decision.expired', kind: 'decision', summary }),
  );
  const outcome = await deps.amicable.commit({
    ...(closed ? { record: closed } : { touch: { caseId: record.id, at: now } }),
    changes,
    amicable,
  });
  if (outcome !== 'saved') return false;
  if (closed) await new DebtorLinks(deps).revoke({ caseId: record.id });
  return true;
}
