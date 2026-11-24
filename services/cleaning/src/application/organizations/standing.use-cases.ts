import { type ProgramChange } from '../../domain/organizations/alignment';
import { supersedesKspDecision } from '../../domain/organizations/ksp-standing';
import {
  type OrganizationStandingSettings,
  type OrganizationStandingTransaction,
} from '../../domain/organizations/ports';
import { reactToUnpaidCount } from '../../domain/organizations/react';
import { isTrackedInvoice, nextInvoiceStanding } from '../../domain/organizations/standing';
import { type OrganizationDeps } from '../deps';
import { type ExecutionReader } from '../execution/execution.ports';
import { CATCH_UP_MAX_WEEKS, resumeExcludedDays } from '../execution/execution-support';
import { type Clock } from '../ports';
import { type SettingsRepository } from '../settings/settings.use-cases';

/**
 * Situation des organisations (piste O ; lot F, UC-NT-47) : factures mensuelles impayées
 * (`billing.invoice.overdue` / `.paid` : avertissement, suspension, reprise, R-PE-06) et décision de
 * KSP (`identity.organization.suspended` / `.reactivated`, RV-85). Chaque événement est traité dans
 * une seule transaction, sous le verrou de l'organisation : inbox, état, programmes, événements et
 * traces. Rejouer un événement ne change rien.
 */

/** Consommateurs (inbox), un par type d'événement écouté. */
export const INVOICE_OVERDUE_CONSUMER = 'cleaning.billing.invoice.overdue';
export const INVOICE_PAID_CONSUMER = 'cleaning.billing.invoice.paid';
export const ORGANIZATION_SUSPENDED_CONSUMER = 'cleaning.identity.organization.suspended';
export const ORGANIZATION_REACTIVATED_CONSUMER = 'cleaning.identity.organization.reactivated';

/** Résumé d'une réévaluation : nombres seulement (journal du service). */
export interface StandingSummary {
  unpaidCount: number;
  warned: boolean;
  suspended: number;
  resumed: number;
  /** Programmes restés suspendus dont une cause a été ajoutée ou levée. */
  updated: number;
}

export type StandingOutcome =
  /** `ignored` : facture non suivie ; `duplicate` : événement déjà traité ; `stale` : décision plus ancienne. */
  { status: 'ignored' | 'duplicate' | 'stale' } | ({ status: 'processed' } & StandingSummary);

const NO_CHANGE: StandingSummary = { unpaidCount: 0, warned: false, suspended: 0, resumed: 0, updated: 0 };

function summary(unpaidCount: number, warned: boolean, changes: readonly ProgramChange[]): StandingSummary {
  const count = (...effects: ProgramChange['effect'][]) =>
    changes.filter((change) => effects.includes(change.effect)).length;
  return {
    unpaidCount,
    warned,
    suspended: count('suspended'),
    resumed: count('resumed'),
    updated: count('cause_added', 'cause_lifted'),
  };
}

/** Réglages lus à chaque décision (16.1) et jours sans rattrapage d'un programme (R-SU-03). */
export class StandingSettings implements OrganizationStandingSettings {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly execution: ExecutionReader,
    private readonly clock: Clock,
  ) {}

  async thresholds() {
    const { settings } = await this.settings.read();
    return { warning: settings.unpaidInvoicesWarning, suspension: settings.unpaidInvoicesSuspension };
  }

  async firstSessionLeadHours(): Promise<number> {
    return (await this.settings.read()).settings.firstSessionLeadHours;
  }

  async excludedDays(programId: string): Promise<ReadonlySet<string>> {
    const program = await this.execution.program(programId);
    if (!program) return new Set();
    const sessions = await this.execution.programSessions(programId);
    return resumeExcludedDays(this.execution, program, sessions, this.clock.now());
  }
}

/**
 * Réévaluation de la situation d'impayés d'une organisation (`reactToUnpaidCount`), dans la
 * transaction ouverte sous son verrou : après une facture passée impayée ou soldée, un changement
 * des seuils, ou la reprise d'un de ses programmes pour une autre cause (R-SU-01).
 */
export async function reevaluateStanding(
  tx: OrganizationStandingTransaction,
  settings: OrganizationStandingSettings,
  organizationId: string,
  now: Date,
): Promise<StandingSummary> {
  const standing = await tx.standing(organizationId);
  const overdueInvoiceIds = await tx.overdueInvoiceIds(organizationId);
  const programs = await tx.openPrograms(organizationId);
  const thresholds = await settings.thresholds();
  const firstSessionLeadHours = await settings.firstSessionLeadHours();
  // Seuls les programmes que la levée de la cause « factures impayées » ferait reprendre ont besoin
  // de leurs jours sans rattrapage.
  const excluded = new Map<string, ReadonlySet<string>>();
  for (const program of programs) {
    if (program.causes.length === 1 && program.causes[0]!.cause === 'unpaid_invoices') {
      excluded.set(program.id, await settings.excludedDays(program.id));
    }
  }
  const reaction = reactToUnpaidCount({
    standing,
    overdueInvoiceIds,
    thresholds,
    programs,
    now,
    resume: {
      firstSessionLeadHours,
      excludedDays: (programId) => excluded.get(programId) ?? new Set<string>(),
      maxWeeks: CATCH_UP_MAX_WEEKS,
    },
  });
  await tx.applyProgramChanges(reaction.changes, {
    unpaidCount: overdueInvoiceIds.length,
    threshold: thresholds.suspension,
    at: now,
  });
  if (
    reaction.standing.overdueCount !== standing.overdueCount ||
    reaction.standing.warningLevel !== standing.warningLevel
  ) {
    await tx.saveStanding(reaction.standing);
  }
  if (reaction.warning) await tx.publishUnpaidWarning(reaction.warning);
  return summary(overdueInvoiceIds.length, reaction.warning !== null, reaction.changes);
}

export class OrganizationStandingUseCases {
  private readonly settings: OrganizationStandingSettings;

  constructor(
    private readonly deps: OrganizationDeps,
    /** Organisation dont la réévaluation a échoué après un changement des seuils (journal). */
    private readonly report: (organizationId: string, error: unknown) => void = () => undefined,
  ) {
    this.settings = new StandingSettings(deps.moduleSettings, deps.execution, deps.clock);
  }

  /**
   * `billing.invoice.overdue` ou `.paid` (versions 1 et 2). Seules les factures mensuelles
   * d'organisation du Nettoyage sont suivies (RV-87) ; une facture soldée ne redevient jamais
   * impayée, quel que soit l'ordre d'arrivée.
   */
  async onInvoiceEvent(input: {
    eventId: string;
    event: 'overdue' | 'paid';
    invoiceId: string;
    organizationId: string | null;
    source: string;
    kind?: string | null;
  }): Promise<StandingOutcome> {
    if (!isTrackedInvoice(input)) return { status: 'ignored' };
    const organizationId = input.organizationId!.toLowerCase();
    const invoiceId = input.invoiceId.toLowerCase();
    const consumer = input.event === 'overdue' ? INVOICE_OVERDUE_CONSUMER : INVOICE_PAID_CONSUMER;
    return this.deps.organizations.run(organizationId, async (tx) => {
      if (!(await tx.markProcessed(input.eventId, consumer))) return { status: 'duplicate' };
      const now = this.deps.clock.now();
      const current = await tx.invoiceStanding(invoiceId);
      const next = nextInvoiceStanding(current, input.event);
      if (next !== current) {
        await tx.saveInvoiceStanding({ invoiceId, organizationId, standing: next, at: now });
      }
      return { status: 'processed', ...(await reevaluateStanding(tx, this.settings, organizationId, now)) };
    });
  }

  /**
   * `identity.organization.suspended` ou `.reactivated` : la cause `organization_suspended` est
   * posée ou levée sur les programmes non terminés de l'organisation (R-SU-01 : un programme ne
   * reprend que lorsque toutes ses causes sont levées). Un événement plus ancien que la dernière
   * décision appliquée est ignoré ; à date égale, la suspension l'emporte. Si un programme reprend,
   * la situation d'impayés est réévaluée.
   */
  async onOrganizationDecision(input: {
    eventId: string;
    decision: 'suspended' | 'reactivated';
    organizationId: string;
    occurredAt: Date;
  }): Promise<StandingOutcome> {
    const organizationId = input.organizationId.toLowerCase();
    const suspended = input.decision === 'suspended';
    const consumer = suspended ? ORGANIZATION_SUSPENDED_CONSUMER : ORGANIZATION_REACTIVATED_CONSUMER;
    return this.deps.organizations.run(organizationId, async (tx) => {
      if (!(await tx.markProcessed(input.eventId, consumer))) return { status: 'duplicate' };
      const decision = { suspended, changedAt: input.occurredAt };
      if (!supersedesKspDecision(await tx.kspStanding(organizationId), decision)) return { status: 'stale' };
      const now = this.deps.clock.now();
      await tx.saveKspStanding({ organizationId, ...decision }, now);
      const programs = await tx.openPrograms(organizationId);
      const effects = await tx.applyOrganizationSuspension({
        programIds: programs.map((program) => program.id),
        action: suspended ? 'add' : 'lift',
        at: now,
      });
      const count = (...kinds: string[]) => effects.filter((line) => kinds.includes(line.effect)).length;
      const own = {
        suspended: count('suspended'),
        resumed: count('resumed'),
        updated: count('cause_added', 'cause_lifted'),
      };
      if (own.resumed === 0) return { status: 'processed', ...NO_CHANGE, ...own };
      const reevaluated = await reevaluateStanding(tx, this.settings, organizationId, now);
      return { status: 'processed', ...reevaluated, resumed: own.resumed, updated: own.updated };
    });
  }

  /** Réévaluation d'une organisation, dans sa propre transaction. */
  reevaluate(organizationId: string): Promise<StandingSummary> {
    return this.deps.organizations.run(organizationId, (tx) =>
      reevaluateStanding(tx, this.settings, organizationId, this.deps.clock.now()),
    );
  }

  /**
   * Après un changement des seuils (UC-NT-43) : chaque organisation concernée est réévaluée dans sa
   * propre transaction ; l'échec d'une organisation n'arrête pas les autres (elle le sera à son
   * prochain événement de facture).
   */
  async reevaluateAll(): Promise<{ reevaluated: number; failed: string[] }> {
    const failed: string[] = [];
    const organizationIds = await this.deps.organizations.organizationsToReevaluate();
    for (const organizationId of organizationIds) {
      try {
        await this.reevaluate(organizationId);
      } catch (error) {
        failed.push(organizationId);
        this.report(organizationId, error);
      }
    }
    return { reevaluated: organizationIds.length - failed.length, failed };
  }
}
