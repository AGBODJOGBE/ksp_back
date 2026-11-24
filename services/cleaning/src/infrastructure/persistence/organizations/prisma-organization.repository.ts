import {
  type OrganizationTransaction,
  type OrganizationUnitOfWork,
} from '../../../application/organizations/organizations.ports';
import { type Clock, type IdGenerator } from '../../../application/ports';
import { type PrismaService } from '../../prisma/prisma.service';
import { PrismaExecutionTx } from '../execution/prisma-execution.tx';

/**
 * Unité de travail de la situation des organisations (piste O) : une transaction par événement,
 * sous le verrou de l'organisation (`lockOrganization`, RV-85), pris avant tout verrou de
 * programme. Elle attend au plus 10 s son tour et dure au plus 30 s (tous les programmes d'une
 * organisation peuvent être suspendus ou repris d'un coup).
 */
export class PrismaOrganizationUnitOfWork implements OrganizationUnitOfWork {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  run<T>(organizationId: string, work: (tx: OrganizationTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => work(await new PrismaExecutionTx(tx, this.clock, this.ids).organization(organizationId)),
      { maxWait: 10_000, timeout: 30_000 },
    );
  }

  async organizationsToReevaluate(): Promise<string[]> {
    const [invoices, standings, programs] = await Promise.all([
      this.prisma.organizationInvoice.findMany({
        where: { standing: 'overdue' },
        distinct: ['organizationId'],
        select: { organizationId: true },
      }),
      this.prisma.organizationBillingStanding.findMany({
        where: { OR: [{ overdueCount: { gt: 0 } }, { warningLevel: { gt: 0 } }] },
        select: { organizationId: true },
      }),
      this.prisma.program.findMany({
        where: { ownerKind: 'organization', suspensionCauses: { has: 'unpaid_invoices' } },
        distinct: ['ownerId'],
        select: { ownerId: true },
      }),
    ]);
    return [
      ...new Set([
        ...invoices.map((row) => row.organizationId),
        ...standings.map((row) => row.organizationId),
        ...programs.map((row) => row.ownerId),
      ]),
    ].sort();
  }
}
