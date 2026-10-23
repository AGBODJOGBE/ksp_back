import { DEFAULT_CHECKLIST } from '../../domain/catalog';
import {
  deriveMissionStatus,
  type Intervention,
  isTerminalMission,
  type Mission,
} from '../../domain/mission';
import { planRescheduling } from '../../domain/rescheduling';
import {
  decideStanding,
  passagesToReschedule,
  standingCause,
  suspendMission,
  thresholdsFor,
  unpaidInterventions,
} from '../../domain/standing';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type ContractInvoiceStatus, type OutboxMessage } from '../ports';
import { CleaningErrors } from '../shared/errors';

/** Auteur des traces des décisions automatiques. */
export const SYSTEM_ACTOR = 'system';

export type StandingOutcome = 'none' | 'warned' | 'suspended' | 'resumed' | 'ignored';

function audit(action: string, mission: Mission, at: Date, details: Record<string, unknown>): AuditEntry {
  return { actorId: SYSTEM_ACTOR, action, entityType: 'mission', entityId: mission.id, at, details };
}

/**
 * Réévalue la situation de paiement d'une mission (CDC Nettoyage, partie 10) et agit :
 * avertissement, suspension (passages à venir annulés, agents libérés) ou déblocage avec
 * reprogrammation automatique. Idempotent : la décision ne dépend que de l'état enregistré.
 */
export class EvaluateStandingUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(missionId: string): Promise<StandingOutcome> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission || isTerminalMission(mission.status)) return 'ignored';
    const cause = standingCause(mission);
    if (!cause) return 'ignored';
    const now = this.deps.clock.now();
    const settings = await this.deps.catalog.getSettings();
    const unpaid =
      cause === 'unpaid_invoices'
        ? await this.deps.invoices.countOverdue(mission.id)
        : unpaidInterventions(mission, now, settings.individualPaymentGraceHours);
    const thresholds = thresholdsFor(cause, settings);
    const decision = decideStanding(mission, unpaid, thresholds);

    if (decision === 'suspend') {
      const result = suspendMission(mission, cause, unpaid, now);
      const suspended = { ...result.mission, warningLevel: unpaid, updatedAt: now };
      suspended.status = deriveMissionStatus(suspended);
      await this.save(suspended, {
        events: [
          {
            type: 'cleaning.contract.suspended',
            payload: {
              missionId: mission.id,
              customerId: mission.customerId,
              organizationId: mission.organizationId,
              cause,
              unpaidCount: unpaid,
              threshold: thresholds.suspendAt,
              cancelledInterventionIds: result.cancelledInterventionIds,
              releasedAgentIds: result.releasedAgentIds,
              suspendedAt: now.toISOString(),
            },
          },
        ],
        audit: [
          audit('mission.suspended', mission, now, {
            cause,
            unpaidCount: unpaid,
            cancelledInterventionIds: result.cancelledInterventionIds,
          }),
        ],
      });
      return 'suspended';
    }
    if (decision === 'resume') {
      await this.resume(mission, unpaid, now, settings.minimumLeadHours);
      return 'resumed';
    }
    if (decision === 'warn') {
      await this.save(
        { ...mission, warningLevel: unpaid, updatedAt: now },
        {
          events: [
            {
              type: 'cleaning.contract.suspension_warning',
              payload: {
                missionId: mission.id,
                customerId: mission.customerId,
                organizationId: mission.organizationId,
                unpaidCount: unpaid,
                suspensionThreshold: thresholds.suspendAt,
              },
            },
          ],
          audit: [audit('mission.suspension_warning', mission, now, { unpaidCount: unpaid })],
        },
      );
      return 'warned';
    }
    // Impayés en baisse sans changement d'état : un prochain impayé pourra de nouveau avertir.
    if (unpaid < mission.warningLevel) {
      await this.save({ ...mission, warningLevel: unpaid, updatedAt: now }, { events: [], audit: [] });
    }
    return 'none';
  }

  /** Déblocage puis reprogrammation automatique, dans la même transaction que le verrou des agents. */
  private async resume(mission: Mission, unpaid: number, now: Date, minimumLeadHours: number) {
    const cause = mission.suspension!.cause;
    const passages = passagesToReschedule(mission);
    const [agents, service] = await Promise.all([
      this.deps.agents.listAgents(),
      this.deps.catalog.findService(mission.serviceCode),
    ]);
    const activeAgentIds = agents.filter((agent) => agent.active).map((agent) => agent.agentId);
    const template = service?.pricing.checklist.length ? service.pricing.checklist : DEFAULT_CHECKLIST;

    const saved = await this.deps.missions.saveWithAgenda(activeAgentIds, (busy) => {
      const plan = planRescheduling({ passages, activeAgentIds, busy, now, minimumLeadHours });
      const created: Intervention[] = plan.placed.map((placed) => ({
        id: this.deps.ids.next(),
        status: 'planned',
        scheduledStart: placed.start,
        durationMinutes: placed.durationMinutes,
        agentIds: placed.agentIds,
        checklist: template.map((item) => ({ ...item, done: false })),
        incidentNote: null,
        beforePhotoFileIds: [],
        afterPhotoFileIds: [],
        startedAt: null,
        completedAt: null,
        cancellationCause: null,
        cancelledAt: null,
      }));
      const resumed: Mission = {
        ...mission,
        suspension: null,
        warningLevel: Math.min(mission.warningLevel, unpaid),
        interventions: [...mission.interventions, ...created],
        updatedAt: now,
      };
      resumed.status = deriveMissionStatus(resumed);
      const events: OutboxMessage[] = [
        {
          type: 'cleaning.contract.resumed',
          payload: {
            missionId: mission.id,
            customerId: mission.customerId,
            organizationId: mission.organizationId,
            cause,
            unpaidCount: unpaid,
            resumedAt: now.toISOString(),
            rescheduledCount: created.length,
            failedCount: plan.failed.length,
          },
        },
        ...created.map((intervention): OutboxMessage => ({
          type: 'cleaning.mission.scheduled',
          payload: {
            missionId: mission.id,
            interventionId: intervention.id,
            customerId: mission.customerId,
            scheduledStart: intervention.scheduledStart.toISOString(),
            durationMinutes: intervention.durationMinutes,
            agentIds: intervention.agentIds,
          },
        })),
      ];
      if (plan.failed.length) {
        events.push({
          type: 'cleaning.rescheduling.failed',
          payload: {
            missionId: mission.id,
            customerId: mission.customerId,
            organizationId: mission.organizationId,
            interventionIds: plan.failed,
            failedCount: plan.failed.length,
          },
        });
      }
      return {
        mission: resumed,
        changes: {
          events,
          audit: [
            audit('mission.resumed', mission, now, {
              unpaidCount: unpaid,
              rescheduledInterventionIds: created.map((intervention) => intervention.id),
              failedInterventionIds: plan.failed,
            }),
          ],
        },
      };
    });
    if (!saved) throw CleaningErrors.concurrentUpdate();
  }

  private async save(mission: Mission, changes: Parameters<CleaningDeps['missions']['save']>[1]) {
    if (!(await this.deps.missions.save(mission, changes))) throw CleaningErrors.concurrentUpdate();
  }
}

/** Consommateur des événements de billing : file `cleaning.<événement>`. */
export const BILLING_CONSUMER = 'cleaning';

/**
 * billing.invoice.overdue / billing.invoice.paid : met à jour le compte des impayés du contrat
 * (inbox, idempotent), puis réévalue la mission. La réévaluation a lieu même pour un doublon :
 * si un premier traitement a échoué après l'inbox, la nouvelle tentative la termine.
 */
export class HandleInvoiceEventUseCase {
  constructor(
    private readonly deps: CleaningDeps,
    private readonly evaluate: EvaluateStandingUseCase,
  ) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    invoiceId: string;
    contractId: string;
    source: string;
    status: ContractInvoiceStatus;
  }): Promise<StandingOutcome> {
    if (input.source !== 'cleaning') return 'ignored';
    const mission = await this.deps.missions.findById(input.contractId);
    if (!mission) return 'ignored';
    await this.deps.invoices.record({
      eventId: input.eventId,
      consumer: `${BILLING_CONSUMER}.${input.eventType}`,
      invoiceId: input.invoiceId,
      missionId: mission.id,
      status: input.status,
      at: this.deps.clock.now(),
    });
    return this.evaluate.execute(mission.id);
  }
}

/**
 * Tâche planifiée : passages impayés des particuliers en récurrent (délai de grâce dépassé).
 * Une erreur sur une mission n'empêche pas l'examen des suivantes.
 */
export class WatchIndividualPaymentsUseCase {
  constructor(
    private readonly deps: CleaningDeps,
    private readonly evaluate: EvaluateStandingUseCase,
  ) {}

  async execute(): Promise<{ examined: number; failed: number }> {
    const missions = await this.deps.missions.listIndividualRecurring();
    let failed = 0;
    for (const mission of missions) {
      try {
        await this.evaluate.execute(mission.id);
      } catch {
        failed += 1;
      }
    }
    return { examined: missions.length, failed };
  }
}
