import { DEFAULT_CHECKLIST } from '../../domain/catalog';
import {
  deriveMissionStatus,
  type Intervention,
  isTerminalMission,
  type Mission,
  type SuspensionCause,
} from '../../domain/mission';
import { planRescheduling } from '../../domain/rescheduling';
import { type CleaningSettings } from '../../domain/settings';
import {
  decideStanding,
  passagesToReschedule,
  remainingCauses,
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

/**
 * `cause_added` : la mission était déjà suspendue pour une autre cause ; `cause_lifted` : une
 * cause est levée mais une autre la garde suspendue (ADR-030).
 */
export type StandingOutcome =
  'none' | 'warned' | 'suspended' | 'cause_added' | 'cause_lifted' | 'resumed' | 'ignored';

function audit(action: string, mission: Mission, at: Date, details: Record<string, unknown>): AuditEntry {
  return { actorId: SYSTEM_ACTOR, action, entityType: 'mission', entityId: mission.id, at, details };
}

/**
 * Changement de cause d'une mission qui reste suspendue (ADR-030) : le client est prévenu qu'une
 * cause s'ajoute ou qu'une autre maintient la suspension. Identifiants seulement.
 */
function suspensionUpdated(
  mission: Mission,
  change: 'cause_added' | 'cause_lifted',
  cause: SuspensionCause,
  causes: SuspensionCause[],
  unpaid: number,
  now: Date,
): OutboxMessage {
  return {
    type: 'cleaning.contract.suspension_updated',
    payload: {
      missionId: mission.id,
      customerId: mission.customerId,
      organizationId: mission.organizationId,
      change,
      cause,
      causes,
      unpaidCount: unpaid,
      updatedAt: now.toISOString(),
    },
  };
}

/**
 * Pose et levée des causes de suspension d'une mission, communes aux impayés (CDC Nettoyage,
 * partie 10) et à la suspension de l'organisation cliente (ADR-030). Les causes se cumulent :
 * seule la première annonce la suspension (passages à venir annulés, agents libérés), seule la
 * levée de la dernière annonce la reprise (reprogrammation automatique) ; entre les deux, chaque
 * cause ajoutée ou levée est annoncée par cleaning.contract.suspension_updated.
 */
export class MissionSuspension {
  constructor(private readonly deps: CleaningDeps) {}

  /** Impayés actuels : factures d'entreprise en retard, ou passages impayés d'un particulier. */
  async unpaid(mission: Mission, cause: SuspensionCause, settings: CleaningSettings, now: Date) {
    return cause === 'unpaid_invoices'
      ? this.deps.invoices.countOverdue(mission.id)
      : unpaidInterventions(mission, now, settings.individualPaymentGraceHours);
  }

  async suspend(
    mission: Mission,
    cause: SuspensionCause,
    unpaid: number,
    threshold: number,
    now: Date,
  ): Promise<'suspended' | 'cause_added'> {
    const result = suspendMission(mission, cause, unpaid, now);
    const suspended = { ...result.mission, updatedAt: now };
    suspended.status = deriveMissionStatus(suspended);
    if (!result.started) {
      await this.save(suspended, {
        events: [suspensionUpdated(mission, 'cause_added', cause, suspended.suspension!.causes, unpaid, now)],
        audit: [
          audit('mission.suspension_cause_added', mission, now, {
            cause,
            causes: suspended.suspension!.causes,
            unpaidCount: unpaid,
          }),
        ],
      });
      return 'cause_added';
    }
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
            threshold,
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

  /**
   * Lève la cause ; reprise avec reprogrammation s'il n'en reste aucune. `replacement` : cause
   * qui doit prendre le relais dans le même enregistrement (impayés au seuil, non encore
   * enregistrés), pour ne jamais reprendre puis suspendre aussitôt.
   */
  async lift(
    mission: Mission,
    cause: SuspensionCause,
    unpaid: number,
    now: Date,
    minimumLeadHours: number,
    replacement: SuspensionCause | null = null,
  ): Promise<'cause_lifted' | 'resumed'> {
    const others = remainingCauses(mission.suspension!, cause);
    const remaining = replacement && !others.includes(replacement) ? [...others, replacement] : others;
    if (!remaining.length) {
      await this.resume(mission, cause, unpaid, now, minimumLeadHours);
      return 'resumed';
    }
    await this.save(
      {
        ...mission,
        suspension: { ...mission.suspension!, causes: remaining, unpaidCount: unpaid },
        warningLevel: replacement
          ? Math.max(mission.warningLevel, unpaid)
          : Math.min(mission.warningLevel, unpaid),
        updatedAt: now,
      },
      {
        events: [suspensionUpdated(mission, 'cause_lifted', cause, remaining, unpaid, now)],
        audit: [
          audit('mission.suspension_cause_lifted', mission, now, {
            cause,
            causes: remaining,
            unpaidCount: unpaid,
          }),
        ],
      },
    );
    return 'cause_lifted';
  }

  /** Déblocage puis reprogrammation automatique, dans la même transaction que le verrou des agents. */
  private async resume(
    mission: Mission,
    cause: SuspensionCause,
    unpaid: number,
    now: Date,
    minimumLeadHours: number,
  ) {
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
              cause,
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

  async save(mission: Mission, changes: Parameters<CleaningDeps['missions']['save']>[1]) {
    if (!(await this.deps.missions.save(mission, changes))) throw CleaningErrors.concurrentUpdate();
  }
}

/**
 * Réévalue la situation de paiement d'une mission (CDC Nettoyage, partie 10) et agit :
 * avertissement, suspension (passages à venir annulés, agents libérés) ou déblocage avec
 * reprogrammation automatique. Idempotent : la décision ne dépend que de l'état enregistré.
 * Les impayés ne lèvent que leur propre cause : une mission dont l'organisation est suspendue
 * le reste (ADR-030).
 */
export class EvaluateStandingUseCase {
  constructor(
    private readonly deps: CleaningDeps,
    private readonly suspension = new MissionSuspension(deps),
  ) {}

  async execute(missionId: string): Promise<StandingOutcome> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission || isTerminalMission(mission.status)) return 'ignored';
    const cause = standingCause(mission);
    if (!cause) return 'ignored';
    const now = this.deps.clock.now();
    const settings = await this.deps.catalog.getSettings();
    const unpaid = await this.suspension.unpaid(mission, cause, settings, now);
    const thresholds = thresholdsFor(cause, settings);
    const decision = decideStanding(mission, cause, unpaid, thresholds);

    if (decision === 'suspend') {
      return this.suspension.suspend(
        { ...mission, warningLevel: unpaid },
        cause,
        unpaid,
        thresholds.suspendAt,
        now,
      );
    }
    if (decision === 'resume') {
      return this.suspension.lift(mission, cause, unpaid, now, settings.minimumLeadHours);
    }
    if (decision === 'warn') {
      await this.suspension.save(
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
      await this.suspension.save(
        { ...mission, warningLevel: unpaid, updatedAt: now },
        { events: [], audit: [] },
      );
    }
    return 'none';
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
