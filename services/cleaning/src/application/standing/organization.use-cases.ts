import { isTerminalMission, type Mission } from '../../domain/mission';
import { hasSuspensionCause, ORGANIZATION_CAUSE, thresholdsFor } from '../../domain/standing';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from '../shared/errors';
import { type EvaluateStandingUseCase, type MissionSuspension } from './standing.use-cases';

/** Consommateur des événements d'identity : file `cleaning.<événement>`. */
export const IDENTITY_CONSUMER = 'cleaning';

/** Alignements successifs tolérés quand l'état de l'organisation change pendant l'alignement. */
export const MAX_ALIGNMENT_PASSES = 3;

export interface OrganizationOutcome {
  /** Missions non terminées de l'organisation. */
  examined: number;
  /** Missions dont la cause « organisation suspendue » a été posée ou levée par cet alignement. */
  changed: number;
}

/**
 * Aligne les missions non terminées d'une organisation sur son état connu (ADR-030) : cause
 * « organisation suspendue » posée tant que KSP la suspend, levée à sa réactivation. La mission
 * ne reprend que si aucune autre cause (impayés) ne la retient ; à sa reprise, les impayés restés
 * en suspens sont réévalués (avertissement ou nouvelle suspension).
 *
 * Idempotent : l'alignement ne dépend que de l'état enregistré. Une erreur sur une mission
 * n'empêche pas les suivantes ; la première est relancée à la fin, pour que le message soit
 * retraité.
 *
 * Décisions concurrentes (suspension et réactivation traitées en même temps) : l'état est relu
 * après l'alignement ; s'il a changé, l'alignement recommence. Une décision enregistrée après
 * cette relecture verra, à son tour, les missions déjà alignées : l'état final est toujours le
 * dernier enregistré.
 */
export class ReconcileOrganizationUseCase {
  constructor(
    private readonly deps: CleaningDeps,
    private readonly suspension: MissionSuspension,
    private readonly evaluate: EvaluateStandingUseCase,
  ) {}

  async execute(organizationId: string): Promise<OrganizationOutcome> {
    let suspended = await this.deps.organizations.isSuspended(organizationId);
    let changed = 0;
    for (let pass = 1; pass <= MAX_ALIGNMENT_PASSES; pass += 1) {
      const outcome = await this.alignAll(organizationId, suspended);
      changed += outcome.changed;
      const current = await this.deps.organizations.isSuspended(organizationId);
      if (current === suspended) return { examined: outcome.examined, changed };
      suspended = current;
    }
    // L'état change sans cesse : le message est retraité plus tard (file de reprise).
    throw CleaningErrors.concurrentUpdate();
  }

  private async alignAll(organizationId: string, suspended: boolean): Promise<OrganizationOutcome> {
    const missions = await this.deps.missions.listActiveForOrganization(organizationId);
    let changed = 0;
    let failure: unknown = null;
    for (const mission of missions) {
      try {
        if (await this.align(mission, suspended)) changed += 1;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return { examined: missions.length, changed };
  }

  /** true si la cause a été posée ou levée. */
  private async align(mission: Mission, suspended: boolean): Promise<boolean> {
    if (isTerminalMission(mission.status)) return false;
    if (suspended === hasSuspensionCause(mission, ORGANIZATION_CAUSE)) return false;
    const now = this.deps.clock.now();
    const settings = await this.deps.catalog.getSettings();
    // Mission d'une organisation : contrat d'entreprise, ses impayés sont des factures.
    const unpaid = await this.suspension.unpaid(mission, 'unpaid_invoices', settings, now);
    const threshold = thresholdsFor('unpaid_invoices', settings).suspendAt;
    if (suspended) {
      await this.suspension.suspend(mission, ORGANIZATION_CAUSE, unpaid, threshold, now);
      return true;
    }
    // Impayés au seuil sans que leur cause soit enregistrée (seuil abaissé pendant la suspension,
    // par exemple) : la cause des impayés prend le relais dans le même enregistrement, plutôt
    // qu'une reprise aussitôt suivie d'une nouvelle suspension.
    const unpaidTakesOver = unpaid >= threshold && !hasSuspensionCause(mission, 'unpaid_invoices');
    const outcome = await this.suspension.lift(
      mission,
      ORGANIZATION_CAUSE,
      unpaid,
      now,
      settings.minimumLeadHours,
      unpaidTakesOver ? 'unpaid_invoices' : null,
    );
    if (outcome === 'resumed') await this.evaluate.execute(mission.id);
    return true;
  }
}

/**
 * identity.organization.suspended / identity.organization.reactivated : enregistre l'état de
 * l'organisation (inbox, idempotent ; un événement plus ancien que le dernier appliqué est sans
 * effet), puis aligne ses missions. L'alignement a lieu même pour un doublon : si un premier
 * traitement a échoué après l'inbox, la nouvelle tentative le termine.
 */
export class HandleOrganizationEventUseCase {
  constructor(
    private readonly deps: CleaningDeps,
    private readonly reconcile: ReconcileOrganizationUseCase,
  ) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    organizationId: string;
    suspended: boolean;
    occurredAt: string;
  }): Promise<OrganizationOutcome> {
    await this.deps.organizations.record({
      eventId: input.eventId,
      consumer: `${IDENTITY_CONSUMER}.${input.eventType}`,
      organizationId: input.organizationId,
      suspended: input.suspended,
      at: new Date(input.occurredAt),
    });
    return this.reconcile.execute(input.organizationId);
  }
}
