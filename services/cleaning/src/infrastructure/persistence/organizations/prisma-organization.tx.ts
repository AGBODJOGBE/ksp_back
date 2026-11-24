import { ConcurrentUpdateError } from '../../../application/agents/agent.ports';
import { type ExecutionTx } from '../../../application/execution/execution.ports';
import {
  type KspStanding,
  type OrganizationTransaction,
  type ProgramCauseEffect,
} from '../../../application/organizations/organizations.ports';
import {
  lockedOrganizationPrograms,
  unpaidWarningChanges,
  writeCauseChanges,
  writeUnpaidProgramChanges,
} from '../../../application/organizations/program-changes';
import { type Clock } from '../../../application/ports';
import { type OrganizationProgram, type ProgramChange } from '../../../domain/organizations/alignment';
import {
  type InvoiceStanding,
  type OrganizationBillingStanding,
} from '../../../domain/organizations/standing';
import { isUuid } from '../agents/agent-rows';
import { type Tx } from '../changes';

/**
 * Situation d'une organisation dans une transaction ouverte sous son verrou (piste O) : inbox,
 * factures suivies, compte d'impayés, décision de KSP. Les programmes sont écrits par la
 * transaction du lot E (`execution`), sur la même connexion.
 */
export class PrismaOrganizationTransaction implements OrganizationTransaction {
  constructor(
    private readonly tx: Tx,
    private readonly execution: ExecutionTx,
    private readonly clock: Clock,
  ) {}

  /** Inbox dans la transaction de l'effet : rien n'est gardé si elle échoue. */
  async markProcessed(eventId: string, consumer: string): Promise<boolean> {
    const inserted = await this.tx.$executeRaw`
      INSERT INTO processed_events (event_id, consumer) VALUES (${eventId}::uuid, ${consumer})
      ON CONFLICT DO NOTHING`;
    return inserted === 1;
  }

  async standing(organizationId: string): Promise<OrganizationBillingStanding> {
    const row = isUuid(organizationId)
      ? await this.tx.organizationBillingStanding.findUnique({ where: { organizationId } })
      : null;
    return {
      organizationId,
      overdueCount: row?.overdueCount ?? 0,
      warningLevel: row?.warningLevel ?? 0,
      version: row?.version ?? 0,
    };
  }

  async saveStanding(standing: OrganizationBillingStanding): Promise<void> {
    const data = {
      overdueCount: standing.overdueCount,
      warningLevel: standing.warningLevel,
      updatedAt: this.clock.now(),
      version: standing.version,
    };
    const updated = await this.tx.organizationBillingStanding.updateMany({
      where: { organizationId: standing.organizationId, version: standing.version - 1 },
      data,
    });
    if (updated.count === 1) return;
    // Aucune ligne à la version attendue : première situation de l'organisation, sinon écriture
    // concurrente.
    if (standing.version !== 1) throw new ConcurrentUpdateError();
    const created = await this.tx.organizationBillingStanding.createMany({
      data: [{ organizationId: standing.organizationId, ...data }],
      skipDuplicates: true,
    });
    if (created.count !== 1) throw new ConcurrentUpdateError();
  }

  async invoiceStanding(invoiceId: string): Promise<InvoiceStanding | null> {
    if (!isUuid(invoiceId)) return null;
    const row = await this.tx.organizationInvoice.findUnique({ where: { invoiceId } });
    return row?.standing ?? null;
  }

  async saveInvoiceStanding(invoice: {
    invoiceId: string;
    organizationId: string;
    standing: InvoiceStanding;
    at: Date;
  }): Promise<void> {
    await this.tx.organizationInvoice.upsert({
      where: { invoiceId: invoice.invoiceId },
      create: {
        invoiceId: invoice.invoiceId,
        organizationId: invoice.organizationId,
        standing: invoice.standing,
        updatedAt: invoice.at,
      },
      update: { standing: invoice.standing, updatedAt: invoice.at },
    });
  }

  async overdueInvoiceIds(organizationId: string): Promise<string[]> {
    if (!isUuid(organizationId)) return [];
    const rows = await this.tx.organizationInvoice.findMany({
      where: { organizationId, standing: 'overdue' },
      select: { invoiceId: true },
      orderBy: { invoiceId: 'asc' },
    });
    return rows.map((row) => row.invoiceId);
  }

  /** Programmes non terminés de l'organisation, verrouillés dans l'ordre de leurs identifiants. */
  async openPrograms(organizationId: string): Promise<OrganizationProgram[]> {
    if (!isUuid(organizationId)) return [];
    const rows = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM programs
      WHERE owner_kind = 'organization' AND owner_id = ${organizationId}::uuid
        AND status NOT IN ('completed', 'cancelled')
      ORDER BY id FOR UPDATE`;
    return lockedOrganizationPrograms(
      this.execution,
      rows.map((row) => row.id),
    );
  }

  applyProgramChanges(
    changes: readonly ProgramChange[],
    context: { unpaidCount: number; threshold: number; at: Date },
  ): Promise<void> {
    return writeUnpaidProgramChanges(this.execution, changes, context);
  }

  publishUnpaidWarning(payload: Parameters<typeof unpaidWarningChanges>[0]): Promise<void> {
    return this.execution.write(unpaidWarningChanges(payload));
  }

  async kspStanding(organizationId: string): Promise<KspStanding | null> {
    if (!isUuid(organizationId)) return null;
    const row = await this.tx.organizationStanding.findUnique({ where: { organizationId } });
    return row ? { organizationId, suspended: row.suspended, changedAt: row.changedAt } : null;
  }

  async saveKspStanding(standing: KspStanding, at: Date): Promise<void> {
    const data = { suspended: standing.suspended, changedAt: standing.changedAt, updatedAt: at };
    await this.tx.organizationStanding.upsert({
      where: { organizationId: standing.organizationId },
      create: { organizationId: standing.organizationId, ...data },
      update: data,
    });
  }

  applyOrganizationSuspension(input: {
    programIds: readonly string[];
    action: 'add' | 'lift';
    at: Date;
  }): Promise<ProgramCauseEffect[]> {
    return writeCauseChanges(this.execution, {
      changes: input.programIds.map((programId) => ({ programId, action: input.action })),
      cause: 'organization_suspended',
      unpaidCount: null,
      threshold: null,
      at: input.at,
    });
  }
}
