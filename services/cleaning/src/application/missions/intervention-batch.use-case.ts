import { DEFAULT_CHECKLIST } from '../../domain/catalog';
import { type BatchSlot, planBatch, selectBatchDates } from '../../domain/intervention-batch';
import { passageStart } from '../../domain/intervention-schedule';
import {
  deriveMissionStatus,
  type Intervention,
  isTerminalMission,
  type Mission,
  remainingToSchedule,
  unscheduledDates,
} from '../../domain/mission';
import { slotFrom } from '../../domain/schedule';
import { type CleaningDeps, missionView, type MissionView } from '../deps';
import { type InterventionBatchOutcome, type InterventionBatchPlan } from '../ports';
import { requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { eventSubject, upfrontNotice } from '../shared/event-subject';
import { requirePositiveInt, requireUuid } from '../shared/validation';
import { parseKey } from '../groups/group-support';
import { resolveAgents } from './admin-missions.use-cases';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScheduleInterventionBatchInput {
  missionId: string;
  /** Obligatoire : un second envoi avec la même clé rend le résultat du premier. */
  idempotencyKey: string;
  /** Sous-ensemble des dates restantes ; vide : selon `until`. */
  dates: string[];
  /** Toutes les dates restantes jusqu'à cette date incluse ; vide : toutes. */
  until: string;
  /** HH:mm ; vide : heure de début du plan. */
  startTime: string;
  durationMinutes: number;
  agentIds: string[];
  teamId: string;
  /** Vrai : planifier les dates libres et sauter les dates en conflit ; faux : tout ou rien. */
  skipConflicts: boolean;
}

export interface InterventionBatchResultView {
  mission: MissionView;
  outcome: InterventionBatchOutcome;
}

/**
 * Planification en lot des dates restantes du plan de passages (ADR-052) : un passage par date, mêmes
 * agents, même heure, même durée, avec les contrôles d'un passage seul, date par date, sous le verrou
 * des agents et dans une transaction. Tout ou rien par défaut (CLEANING_TEAM_UNAVAILABLE avec les
 * dates en conflit et leurs agents) ; `skipConflicts` planifie le reste et rend les dates sautées.
 * Un seul événement récapitulatif, cleaning.interventions.batch_scheduled.
 */
export class ScheduleInterventionBatchUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: ScheduleInterventionBatchInput): Promise<InterventionBatchResultView> {
    const staff = requireStaff(SUPERVISION);
    const key = parseKey(input.idempotencyKey, true);
    const mission = await this.deps.missions.findById(requireUuid('missionId', input.missionId));
    if (!mission) throw CleaningErrors.missionNotFound();
    const replay = await this.deps.missions.findInterventionBatch(mission.id, key);
    if (replay) return this.result(mission.id, replay);

    if (isTerminalMission(mission.status))
      throw CleaningErrors.invalidTransition(mission.status, 'scheduled');
    if (mission.suspension) throw CleaningErrors.contractSuspended();
    if (!mission.schedule) {
      throw CleaningErrors.invalid(
        'missionId',
        'Mission sans plan de passages : planifiez ses passages un par un.',
      );
    }
    const durationMinutes = requirePositiveInt('durationMinutes', input.durationMinutes, 24 * 60);
    const startTime = input.startTime || mission.schedule.startTime;
    if (!TIME.test(startTime)) throw CleaningErrors.invalid('startTime', 'Heure attendue au format HH:mm.');
    const { timeZone } = this.deps.fieldDates;
    const now = this.deps.clock.now();
    const remaining = unscheduledDates(mission, timeZone).filter(
      (date) => passageStart(date, startTime, timeZone) > now,
    );
    if (!remaining.length || remainingToSchedule(mission) === 0) throw CleaningErrors.noInterventionLeft();
    const selection = selectBatchDates(remaining, { dates: input.dates, until: input.until || null });
    if ('problem' in selection)
      throw CleaningErrors.invalid(selection.problem.field, selection.problem.message);
    const { dates } = selection;
    if (dates.length > remainingToSchedule(mission)) {
      throw CleaningErrors.invalid('dates', `${remainingToSchedule(mission)} passages restent à planifier.`);
    }
    const { maxBatch } = this.deps.schedules;
    if (dates.length > maxBatch) {
      throw CleaningErrors.invalid(
        'dates',
        `${maxBatch} passages au plus par appel : précisez until ou dates (${dates.length} demandés).`,
      );
    }
    const agentIds = await resolveAgents(this.deps, input.agentIds, input.teamId);
    const slots: BatchSlot[] = dates.map((date) => ({
      date,
      slot: slotFrom(passageStart(date, startTime, timeZone), durationMinutes),
    }));
    const service = await this.deps.catalog.findService(mission.serviceCode);
    const checklist = service?.pricing.checklist.length ? service.pricing.checklist : DEFAULT_CHECKLIST;
    const subject = await eventSubject(this.deps, mission);

    const plan = (free: BatchSlot[], skipped: InterventionBatchOutcome['skipped']): InterventionBatchPlan => {
      const interventions: Intervention[] = free.map(({ slot }) => ({
        id: this.deps.ids.next(),
        status: 'planned',
        scheduledStart: slot.start,
        durationMinutes,
        agentIds,
        checklist: checklist.map((item) => ({ ...item, done: false })),
        incidentNote: null,
        beforePhotoFileIds: [],
        afterPhotoFileIds: [],
        startedAt: null,
        completedAt: null,
        cancellationCause: null,
        cancelledAt: null,
      }));
      const updated: Mission = {
        ...mission,
        interventions: [...mission.interventions, ...interventions],
        updatedAt: now,
      };
      updated.status = deriveMissionStatus(updated);
      const outcome: InterventionBatchOutcome = {
        missionId: mission.id,
        interventionIds: interventions.map((intervention) => intervention.id),
        scheduledDates: free.map(({ date }) => date),
        skipped,
      };
      const skippedDates = skipped.map(({ date }) => date);
      return {
        mission: updated,
        outcome,
        changes: {
          events: [
            {
              type: 'cleaning.interventions.batch_scheduled',
              payload: {
                ...subject,
                missionId: mission.id,
                customerId: mission.customerId,
                interventionIds: outcome.interventionIds,
                count: interventions.length,
                firstStart: interventions[0]!.scheduledStart.toISOString(),
                lastStart: interventions[interventions.length - 1]!.scheduledStart.toISOString(),
                durationMinutes,
                agentIds,
                skippedDates,
                // Paiement « avant » encore dû (ADR-049) : les passages ne démarreront pas sans lui.
                ...upfrontNotice(mission),
              },
            },
          ],
          audit: [
            {
              actorId: staff.userId,
              action: 'interventions.batch_scheduled',
              entityType: 'mission',
              entityId: mission.id,
              at: now,
              details: { ...outcome, agentIds, startTime, durationMinutes },
            },
          ],
        },
      };
    };

    const written = await this.deps.missions.scheduleBatch({
      agentIds,
      batch: { missionId: mission.id, actorId: staff.userId, idempotencyKey: key },
      plan: (busy) => {
        const { free, conflicts } = planBatch(slots, agentIds, busy, mission.groupId);
        if (!free.length || (conflicts.length && !input.skipConflicts)) return { conflicts };
        return plan(free, conflicts);
      },
    });
    if (written.status === 'conflicts') throw CleaningErrors.batchConflicts(written.conflicts);
    if (written.status === 'stale') throw CleaningErrors.concurrentUpdate();
    if (written.status === 'replayed') {
      const previous = await this.deps.missions.findInterventionBatch(mission.id, key);
      if (!previous) throw CleaningErrors.concurrentUpdate();
      return this.result(mission.id, previous);
    }
    return this.result(mission.id, written.outcome);
  }

  private async result(
    missionId: string,
    outcome: InterventionBatchOutcome,
  ): Promise<InterventionBatchResultView> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission) throw CleaningErrors.missionNotFound();
    return { mission: await missionView(this.deps, mission), outcome };
  }
}
