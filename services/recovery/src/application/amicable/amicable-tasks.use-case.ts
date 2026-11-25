import { automaticChannelOf, isAutomaticMessageAllowed } from '../../domain/amicable';
import { localDay, type LocalDay } from '../../domain/calendar';
import { advanceStage } from '../../domain/case';
import { installmentStatus, payInstallments, planProgress, remindersDue } from '../../domain/payment-plan';
import { amicableStepsDue, DEFAULT_AMICABLE_SEQUENCE, nextProgression } from '../../domain/progression';
import { evaluatePromise } from '../../domain/promise';
import { FIXED_RULES } from '../../domain/settings';
import { evidenceEntry, SYSTEM, upcomingHolidays } from '../cases/case-rules';
import { noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { type FullSettings } from '../ports';
import { loadSettings } from '../settings.use-cases';
import { formatXof, unwrap } from '../shared/errors';
import {
  type AmicableDeps,
  type DebtorMessageRecord,
  noAmicableChanges,
  type PlanRecord,
  type PromiseRecord,
} from './amicable.ports';
import { applyStageMove, caseRef, coordinatesOf, isPlanPending, mainDebtor } from './amicable-rules';
import { expirePendingDecision } from './decisions.use-cases';
import {
  amountText,
  DebtorMessenger,
  longDay,
  MESSAGE_LEASE_MS,
  MESSAGE_MAX_ATTEMPTS,
  queuedMessage,
} from './debtor-messages';

/** Lignes traitées par lot ; un passage parcourt au plus `MAX_PAGES` lots par étape. */
const BATCH = 50;
const MAX_PAGES = 20;

export interface AmicableReport {
  /** Premiers contacts mis en file (notification du mandat). */
  noticesQueued: number;
  messagesSent: number;
  messagesCancelled: number;
  /** Messages en échec définitif (aucune coordonnée, essais épuisés). */
  messagesFailed: number;
  /** Étapes avancées seules (notification sans réponse, échéancier rompu). */
  stagesAdvanced: number;
  /** Mises en demeure proposées au superviseur (relance amiable sans résultat). */
  escalationsProposed: number;
  installmentsMissed: number;
  plansDefaulted: number;
  plansCompleted: number;
  promisesKept: number;
  promisesBroken: number;
  decisionsExpired: number;
  settlementsExpired: number;
  /** Lignes en erreur, reprises au passage suivant. */
  failed: number;
}

const emptyReport = (): AmicableReport => ({
  noticesQueued: 0,
  messagesSent: 0,
  messagesCancelled: 0,
  messagesFailed: 0,
  stagesAdvanced: 0,
  escalationsProposed: 0,
  installmentsMissed: 0,
  plansDefaulted: 0,
  plansCompleted: 0,
  promisesKept: 0,
  promisesBroken: 0,
  decisionsExpired: 0,
  settlementsExpired: 0,
  failed: 0,
});

/** Parcourt une liste par lots repris après le dernier identifiant ; une erreur n'arrête pas les suivants. */
async function eachPage<T>(
  load: (afterId: string | null) => Promise<T[]>,
  idOf: (item: T) => string,
  handle: (item: T) => Promise<void>,
  report: AmicableReport,
): Promise<void> {
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const items = await load(after);
    for (const item of items) {
      try {
        await handle(item);
      } catch {
        report.failed += 1;
      }
    }
    if (items.length < BATCH) return;
    after = idOf(items[items.length - 1]!);
  }
}

/**
 * Tâche de la procédure amiable (UC-RC-15, 18, 26, 27 ; ADR-060, point 17), délais lus dans les
 * réglages :
 * 1. premier contact : chaque dossier accepté (étape de notification) met en file la notification du
 *    mandat au débiteur principal, avec son lien personnel ;
 * 2. échéanciers signés : échéances déduites des encaissements (lecture seule), échéance manquée
 *    après la grâce (`recovery.plan.installment_missed`), échéancier soldé, ou rompu à 2 échéances
 *    manquées, 1 après une renégociation (`recovery.plan.defaulted`, relance amiable) ; rappels 3
 *    jours avant et le jour de chaque échéance ;
 * 3. promesses tenues par les encaissements, ou non tenues le lendemain (relance du débiteur) ;
 * 4. avancement : notification sans suite après 8 jours → relance amiable (sauf échéancier en cours
 *    d'accord) ; pas automatiques de la relance (message J0, e-mail J7) ; relance amiable échue →
 *    mise en demeure proposée au superviseur (faite ensuite par le juriste) ;
 * 5. décisions du créancier échues, remises non utilisées à leur date ;
 * 6. envoi des messages en file, dans la plage de contact et hors jours fériés, lien renouvelé.
 * Plusieurs instances peuvent tourner : écritures conditionnées (version, statut lu), messages
 * réservés avant l'envoi, clés de dédoublonnage.
 */
export class WatchAmicableUseCase {
  private readonly messenger: DebtorMessenger;

  constructor(private readonly deps: AmicableDeps) {
    this.messenger = new DebtorMessenger(deps);
  }

  async execute(): Promise<AmicableReport> {
    const now = this.deps.clock.now();
    const { settings } = await loadSettings(this.deps.settings);
    const report = emptyReport();
    await this.queueNotices(now, report);
    await eachPage(
      (after) => this.deps.amicable.signedPlans(after, BATCH),
      (plan) => plan.id,
      (plan) => this.followPlan(plan, now, settings, report),
      report,
    );
    await eachPage(
      (after) => this.deps.amicable.pendingPromises(after, BATCH),
      (item) => item.promise.id,
      (item) => this.followPromise(item.promise, item.caseStatus, now, report),
      report,
    );
    await eachPage(
      (after) => this.deps.amicable.activeCases(['notice', 'amicable'], after, BATCH),
      (caseId) => caseId,
      (caseId) => this.progress(caseId, now, settings, report),
      report,
    );
    for (const decision of await this.deps.amicable.expiredDecisions(now, BATCH)) {
      try {
        if (await expirePendingDecision(this.deps, decision)) report.decisionsExpired += 1;
      } catch {
        report.failed += 1;
      }
    }
    await this.expireSettlements(now, report);
    await this.dispatch(now, settings, report);
    return report;
  }

  private async queueNotices(now: Date, report: AmicableReport): Promise<void> {
    for (const caseId of await this.deps.amicable.casesWithoutNotice(BATCH)) {
      try {
        const record = await this.deps.cases.find(caseId);
        if (!record || record.status !== 'active' || record.stage !== 'notice') continue;
        const amicable = noAmicableChanges();
        amicable.messages.push(
          queuedMessage(this.deps.ids, {
            caseId,
            debtorId: mainDebtor(record).id,
            message: 'mandate_notice',
            purpose: 'notice',
            dedupeKey: `notice:${caseId}`,
            notBefore: now,
          }),
        );
        await this.deps.amicable.commit({ changes: noChanges(), amicable });
        report.noticesQueued += 1;
      } catch {
        report.failed += 1;
      }
    }
  }

  /**
   * Échéances d'un échéancier signé, déduites des encaissements reçus depuis sa proposition. Un dossier
   * clos (payé, accord exécuté, abandon) arrête son échéancier, sans échéance manquée ni rappel.
   */
  private async followPlan(plan: PlanRecord, now: Date, settings: FullSettings, report: AmicableReport) {
    const record = await this.deps.cases.find(plan.caseId);
    if (!record) return;
    const today = localDay(now);
    const grace = settings.installmentGraceDays;
    const collected = await this.deps.amicable.collectedSince(plan.caseId, plan.createdAt);
    const imputed = payInstallments(
      plan.installments.map((installment) => ({ ...installment, paidAmount: 0 })),
      collected,
    ).installments;
    const installments = plan.installments.map((installment, index) => {
      const paidAmount = imputed[index]!.paidAmount;
      return {
        ...installment,
        paidAmount,
        status: installmentStatus({ ...installment, paidAmount }, today, grace),
        paidAt: paidAmount >= installment.amount ? (installment.paidAt ?? now) : null,
      };
    });
    const progress = planProgress(installments, today, {
      graceDays: grace,
      missedBeforeDefault: settings.missedInstallmentsBeforeAmicable,
      renegotiated: plan.renegotiatedFromId !== null,
    });
    if (record.status !== 'active' && record.status !== 'suspended') {
      const amicable = noAmicableChanges();
      const status = progress === 'completed' ? 'completed' : 'cancelled';
      amicable.plans.push({ row: { ...plan, installments, status, endedAt: now }, expected: plan.version });
      await this.deps.amicable.commit({ changes: noChanges(), amicable });
      return;
    }
    const missedCount = installments.filter((installment) => installment.status === 'missed').length;
    const changes = noChanges();
    const amicable = noAmicableChanges();
    for (const [index, installment] of installments.entries()) {
      if (installment.status !== 'missed' || plan.installments[index]!.status === 'missed') continue;
      const left = installment.amount - installment.paidAmount;
      changes.events.push({
        type: 'recovery.plan.installment_missed',
        payload: {
          ...caseRef(record),
          planId: plan.id,
          installmentRank: installment.rank,
          dueDate: installment.dueDate,
          amount: { amount: left, currency: 'XOF' },
          missedCount,
          missedAt: now.toISOString(),
        },
      });
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'plan.installment_missed',
          kind: 'plan',
          summary: `Échéance ${installment.rank} du ${longDay(installment.dueDate)} manquée (${formatXof(left)} restant dus)`,
          amount: left,
        }),
      );
      report.installmentsMissed += 1;
    }
    let next: PlanRecord = { ...plan, installments };
    let nextRecord: RecoveryCaseRecord | null = null;
    if (progress === 'completed') {
      next = { ...next, status: 'completed', endedAt: now };
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'plan.completed',
          kind: 'plan',
          summary: `Échéancier soldé : ${formatXof(plan.total)} reçus`,
          amount: plan.total,
        }),
      );
      report.plansCompleted += 1;
    } else if (progress === 'defaulted') {
      next = { ...next, status: 'defaulted', endedAt: now };
      changes.events.push({
        type: 'recovery.plan.defaulted',
        payload: { ...caseRef(record), planId: plan.id, missedCount, defaultedAt: now.toISOString() },
      });
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'plan.defaulted',
          kind: 'plan',
          summary: `Échéancier rompu : ${missedCount} échéance(s) manquée(s)`,
        }),
      );
      if (record.status === 'active' && record.stage === 'payment_plan') {
        nextRecord = applyStageMove(
          this.deps.ids,
          record,
          unwrap(advanceStage(record, 'amicable')),
          { actor: SYSTEM, changedBy: 'system', reason: 'Échéancier rompu', at: now },
          changes,
        );
      }
      report.plansDefaulted += 1;
    } else if (record.status === 'active') {
      for (const reminder of remindersDue(installments, today, FIXED_RULES.installmentReminderDaysBefore)) {
        const installment = installments.find((candidate) => candidate.rank === reminder.rank)!;
        const dedupeKey = `installment:${installment.id}:${reminder.kind}`;
        if (await this.deps.amicable.message(dedupeKey)) continue;
        amicable.messages.push(
          queuedMessage(this.deps.ids, {
            caseId: record.id,
            debtorId: mainDebtor(record).id,
            message: 'installment_reminder',
            purpose: 'installment_reminder',
            dedupeKey,
            notBefore: now,
            refId: installment.id,
            variables: {
              amount: amountText(installment.amount - installment.paidAmount),
              due_on: longDay(installment.dueDate),
            },
          }),
        );
      }
    }
    const planChanged = JSON.stringify(next) !== JSON.stringify(plan);
    if (planChanged) amicable.plans.push({ row: next, expected: plan.version });
    if (!planChanged && amicable.messages.length === 0) return;
    const outcome = await this.deps.amicable.commit({
      ...(nextRecord
        ? { record: nextRecord }
        : changes.evidence.length > 0
          ? { touch: { caseId: record.id, at: now } }
          : {}),
      changes,
      amicable,
    });
    if (outcome === 'saved' && nextRecord) report.stagesAdvanced += 1;
    if (outcome !== 'saved') report.failed += 1;
  }

  /** Promesse en attente : tenue par les encaissements reçus depuis, ou non tenue le lendemain. */
  private async followPromise(
    promise: PromiseRecord,
    caseStatus: RecoveryCaseRecord['status'],
    now: Date,
    report: AmicableReport,
  ): Promise<void> {
    const amicable = noAmicableChanges();
    const changes = noChanges();
    if (caseStatus !== 'active' && caseStatus !== 'suspended') {
      amicable.promises.push({ row: { ...promise, status: 'cancelled' }, expected: 'pending' });
      await this.deps.amicable.commit({ changes, amicable });
      return;
    }
    const paid = await this.deps.amicable.collectedSince(promise.caseId, promise.createdAt);
    const status = evaluatePromise(promise, paid, localDay(now));
    if (status === 'pending') return;
    const record = await this.deps.cases.find(promise.caseId);
    if (!record) return;
    if (status === 'kept') {
      amicable.promises.push({ row: { ...promise, status, keptAt: now }, expected: 'pending' });
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'promise.kept',
          kind: 'promise',
          summary: `Promesse de ${formatXof(promise.amount)} du ${longDay(promise.dueDate)} tenue`,
          amount: promise.amount,
        }),
      );
      report.promisesKept += 1;
    } else {
      amicable.promises.push({ row: { ...promise, status: 'broken', brokenAt: now }, expected: 'pending' });
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'promise.broken',
          kind: 'promise',
          summary:
            `Promesse de ${formatXof(promise.amount)} du ${longDay(promise.dueDate)} non tenue` +
            (caseStatus === 'active' ? ' : relance du débiteur' : ''),
          amount: promise.amount,
        }),
      );
      if (caseStatus === 'active') {
        amicable.messages.push(
          queuedMessage(this.deps.ids, {
            caseId: record.id,
            debtorId: mainDebtor(record).id,
            message: 'reminder',
            purpose: 'promise_followup',
            dedupeKey: `promise:${promise.id}`,
            notBefore: now,
            refId: promise.id,
          }),
        );
      }
      report.promisesBroken += 1;
    }
    await this.deps.amicable.commit({ touch: { caseId: record.id, at: now }, changes, amicable });
  }

  /** Avancement d'un dossier à la notification ou en relance amiable (partie 5). */
  private async progress(caseId: string, now: Date, settings: FullSettings, report: AmicableReport) {
    const record = await this.deps.cases.find(caseId);
    if (!record || record.status !== 'active' || (record.stage !== 'notice' && record.stage !== 'amicable'))
      return;
    const start = await this.deps.amicable.stageStart(record.id);
    let stageStartedAt: Date | null = start?.stage === record.stage ? start.at : (record.acceptedAt ?? null);
    let planPending = false;
    if (record.stage === 'notice') {
      // Le délai de réponse court depuis l'envoi de la notification ; sans coordonnée, depuis l'acceptation.
      const notice = await this.deps.amicable.message(`notice:${record.id}`);
      if (notice?.status === 'sent') stageStartedAt = notice.sentAt;
      else if (notice?.status !== 'failed' && notice?.status !== 'cancelled') stageStartedAt = null;
      planPending = (await this.deps.amicable.plans(record.id)).some(isPlanPending);
    }
    const action = nextProgression({
      state: record,
      stageStartedAt,
      now,
      planPending,
      planProgress: null,
      settings,
    });
    if (action.kind === 'advance') {
      const changes = noChanges();
      const next = applyStageMove(
        this.deps.ids,
        record,
        unwrap(advanceStage(record, action.to)),
        {
          actor: SYSTEM,
          changedBy: 'system',
          reason: 'Pas de réponse dans le délai de la notification',
          at: now,
        },
        changes,
      );
      const amicable = noAmicableChanges();
      const transitionId = changes.stageTransitions[0]!.id;
      amicable.messages.push(...this.stepMessages(next, transitionId, localDay(now), localDay(now), now));
      const outcome = await this.deps.amicable.commit({ record: next, changes, amicable });
      if (outcome === 'saved') report.stagesAdvanced += 1;
      return;
    }
    if (record.stage !== 'amicable' || !start || start.stage !== 'amicable') return;
    if (action.kind === 'propose') {
      if (await this.deps.amicable.hasEvidence(record.id, 'stage.escalation_proposed', start.at)) return;
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: 'stage.escalation_proposed',
          kind: 'system',
          summary:
            `Relance amiable sans résultat après ${settings.amicableDurationDays} jours : mise en demeure ` +
            'proposée, à valider par le superviseur',
        }),
      );
      await this.deps.amicable.commit({
        touch: { caseId: record.id, at: now },
        changes,
        amicable: noAmicableChanges(),
      });
      report.escalationsProposed += 1;
      return;
    }
    const amicable = noAmicableChanges();
    for (const message of this.stepMessages(
      record,
      start.transitionId,
      localDay(start.at),
      localDay(now),
      now,
    )) {
      if (!(await this.deps.amicable.message(message.dedupeKey))) amicable.messages.push(message);
    }
    if (amicable.messages.length > 0) await this.deps.amicable.commit({ changes: noChanges(), amicable });
  }

  /** Pas automatiques de la relance amiable dus à ce jour : message (J0), e-mail (J7) si le débiteur en a un. */
  private stepMessages(
    record: RecoveryCaseRecord,
    transitionId: string,
    startedOn: LocalDay,
    today: LocalDay,
    now: Date,
  ): DebtorMessageRecord[] {
    const debtor = mainDebtor(record);
    const hasEmail = coordinatesOf(debtor).email !== null;
    return amicableStepsDue(startedOn, today, new Set(), DEFAULT_AMICABLE_SEQUENCE).flatMap((step) => {
      const channel = automaticChannelOf(step.action, hasEmail);
      if (channel === null) return [];
      return [
        queuedMessage(this.deps.ids, {
          caseId: record.id,
          debtorId: debtor.id,
          message: 'reminder',
          purpose: 'amicable_step',
          dedupeKey: `amicable:${transitionId}:${step.index}`,
          notBefore: now,
          refId: transitionId,
          channel: channel === 'email' ? 'email' : null,
        }),
      ];
    });
  }

  private async expireSettlements(now: Date, report: AmicableReport): Promise<void> {
    for (const settlement of await this.deps.amicable.expiredSettlements(localDay(now), BATCH)) {
      try {
        const record = await this.deps.cases.find(settlement.caseId);
        if (!record) continue;
        const changes = noChanges();
        changes.evidence.push(
          evidenceEntry(this.deps.ids, record, now, SYSTEM, {
            action: 'settlement.expired',
            kind: 'decision',
            summary: `Remise non utilisée avant le ${longDay(settlement.validUntil)} : offre expirée`,
          }),
        );
        const amicable = noAmicableChanges();
        amicable.settlements.push({ row: { ...settlement, status: 'expired' }, expected: settlement.status });
        if (
          (await this.deps.amicable.commit({ touch: { caseId: record.id, at: now }, changes, amicable })) ===
          'saved'
        ) {
          report.settlementsExpired += 1;
        }
      } catch {
        report.failed += 1;
      }
    }
  }

  /** Envoi des messages en file : seulement dans la plage de contact et hors jours fériés. */
  private async dispatch(now: Date, settings: FullSettings, report: AmicableReport): Promise<void> {
    const holidays = await upcomingHolidays(this.deps.holidays, now);
    if (!isAutomaticMessageAllowed(now, settings.contactWindow, holidays)) return;
    const claimed = await this.deps.amicable.claimMessages(
      now,
      new Date(now.getTime() + MESSAGE_LEASE_MS),
      BATCH,
    );
    for (const message of claimed) {
      const record = await this.deps.cases.find(message.caseId);
      try {
        if (!record || record.status !== 'active' || !(await this.relevant(record, message))) {
          await this.close(message, 'cancelled', null);
          report.messagesCancelled += 1;
          continue;
        }
        const outcome = await this.messenger.deliver(record, message, { stored: true });
        if (outcome.status === 'sent') report.messagesSent += 1;
        else {
          await this.close(message, 'failed', record, 'aucune coordonnée valable du débiteur');
          report.messagesFailed += 1;
        }
      } catch {
        if (message.attempts >= MESSAGE_MAX_ATTEMPTS && record) {
          await this.close(message, 'failed', record, `${MESSAGE_MAX_ATTEMPTS} essais sans succès`).catch(
            () => undefined,
          );
          report.messagesFailed += 1;
        } else report.failed += 1;
      }
    }
  }

  /** Un message ne part que s'il a encore un objet : étape en cours, promesse rompue, échéance due. */
  private async relevant(record: RecoveryCaseRecord, message: DebtorMessageRecord): Promise<boolean> {
    switch (message.purpose) {
      case 'notice':
        return record.stage === 'notice';
      case 'amicable_step': {
        const start = await this.deps.amicable.stageStart(record.id);
        return record.stage === 'amicable' && start?.transitionId === message.refId;
      }
      case 'promise_followup':
        return (
          message.refId !== null && (await this.deps.amicable.promise(message.refId))?.status === 'broken'
        );
      case 'installment_reminder':
        return (await this.deps.amicable.plans(record.id)).some(
          (plan) =>
            plan.status === 'signed' &&
            plan.installments.some((i) => i.id === message.refId && i.paidAmount < i.amount),
        );
      default:
        return true;
    }
  }

  private async close(
    message: DebtorMessageRecord,
    status: 'cancelled' | 'failed',
    record: RecoveryCaseRecord | null,
    reason?: string,
  ): Promise<void> {
    const now = this.deps.clock.now();
    const changes = noChanges();
    if (record && status === 'failed') {
      changes.evidence.push(
        evidenceEntry(this.deps.ids, record, now, SYSTEM, {
          action: `message.${message.purpose}.failed`,
          kind: 'system',
          summary: `Message au débiteur non envoyé : ${reason}`,
          internal: true,
        }),
      );
    }
    const amicable = noAmicableChanges();
    amicable.messageUpdates.push({ ...message, status });
    await this.deps.amicable.commit({ changes, amicable });
  }
}
