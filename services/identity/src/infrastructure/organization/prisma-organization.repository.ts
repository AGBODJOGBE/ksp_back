import { type KspEventPayloads, type KspEventType } from '@ksp/contracts';
import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type Membership,
  type NewOrganization,
  OrganizationChangedError,
  OrganizationIfuTakenError,
  type OrganizationMemberView,
  type OrganizationPage,
  type OrganizationRepository,
  type OrganizationStatusChange,
} from '../../application/organization/organization.ports';
import { type OrganizationDirectory } from '../../application/directory/get-organizations.use-case';
import { type Organization, type OrganizationStatus } from '../../domain/organization/organization';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';

const ORGANIZATION_SELECT = {
  id: true,
  legalName: true,
  address: true,
  ifu: true,
  rccm: true,
  billingEmail: true,
  status: true,
  createdBy: true,
  createdAt: true,
  reviewedBy: true,
  reviewedAt: true,
  rejectionReason: true,
  suspendedAt: true,
  suspensionReason: true,
} as const;

type OrganizationRow = Prisma.OrganizationGetPayload<{ select: typeof ORGANIZATION_SELECT }>;

function toOrganization(row: OrganizationRow): Organization {
  return { ...row };
}

/** Action écrite dans le journal d'audit pour chaque décision. */
const AUDIT_ACTIONS: Readonly<Record<OrganizationStatusChange['decision'], string>> = {
  validate: 'organization.validated',
  reject: 'organization.rejected',
  suspend: 'organization.suspended',
  reactivate: 'organization.reactivated',
};

/** Champs écrits par chaque décision du back-office. */
function decisionWrites(change: OrganizationStatusChange): Prisma.OrganizationUpdateManyMutationInput {
  switch (change.decision) {
    case 'validate':
      return { status: change.to, reviewedBy: change.actorId, reviewedAt: change.now };
    case 'reject':
      return {
        status: change.to,
        reviewedBy: change.actorId,
        reviewedAt: change.now,
        rejectionReason: change.reason,
      };
    case 'suspend':
      return {
        status: change.to,
        suspendedBy: change.actorId,
        suspendedAt: change.now,
        suspensionReason: change.reason,
      };
    case 'reactivate':
      return { status: change.to, suspendedBy: null, suspendedAt: null, suspensionReason: null };
  }
}

type DecisionEvent =
  | ['identity.organization.validated', KspEventPayloads['identity.organization.validated']]
  | ['identity.organization.rejected', KspEventPayloads['identity.organization.rejected']]
  | ['identity.organization.suspended', KspEventPayloads['identity.organization.suspended']]
  | ['identity.organization.reactivated', KspEventPayloads['identity.organization.reactivated']];

function decisionEvent(change: OrganizationStatusChange, organization: Organization): DecisionEvent {
  const base = { organizationId: organization.id, legalName: organization.legalName };
  switch (change.decision) {
    case 'validate':
      return [
        'identity.organization.validated',
        { ...base, createdBy: organization.createdBy, validatedBy: change.actorId },
      ];
    case 'reject':
      return [
        'identity.organization.rejected',
        {
          ...base,
          createdBy: organization.createdBy,
          rejectedBy: change.actorId,
          reason: change.reason ?? '',
        },
      ];
    case 'suspend':
      return [
        'identity.organization.suspended',
        {
          ...base,
          suspendedBy: change.actorId,
          createdBy: organization.createdBy,
          reason: change.reason ?? '',
        },
      ];
    case 'reactivate':
      return [
        'identity.organization.reactivated',
        { ...base, reactivatedBy: change.actorId, createdBy: organization.createdBy },
      ];
  }
}

/**
 * Organisations, membres et décisions du back-office, en base identity (ADR-027) ; lecture des
 * fiches par les autres services (GetOrganizationsByIds).
 */
@Injectable()
export class PrismaOrganizationRepository implements OrganizationRepository, OrganizationDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async countPendingCreatedBy(userId: string): Promise<number> {
    return this.prisma.organization.count({ where: { createdBy: userId, status: 'pending_review' } });
  }

  async create(input: NewOrganization): Promise<Membership> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Index unique partiel organizations_ifu_active_key : un IFU par organisation non refusée.
        const row = await tx.organization.create({
          data: {
            id: input.id,
            legalName: input.legalName,
            address: input.address,
            ifu: input.ifu,
            rccm: input.rccm,
            status: 'pending_review',
            createdBy: input.createdBy,
            createdAt: input.now,
            members: {
              create: { id: input.memberId, userId: input.createdBy, role: 'org_admin', joinedAt: input.now },
            },
          },
          select: ORGANIZATION_SELECT,
        });
        await this.publish(tx, input.now, 'identity.organization.created', {
          organizationId: input.id,
          createdBy: input.createdBy,
          legalName: input.legalName,
        });
        await this.publish(tx, input.now, 'identity.member.added', {
          organizationId: input.id,
          userId: input.createdBy,
          orgRole: 'org_admin',
        });
        return { organization: toOrganization(row), role: 'org_admin' as const };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new OrganizationIfuTakenError();
      }
      throw error;
    }
  }

  async findById(organizationId: string): Promise<Organization | null> {
    const row = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: ORGANIZATION_SELECT,
    });
    return row ? toOrganization(row) : null;
  }

  async findByIds(organizationIds: readonly string[]): Promise<Organization[]> {
    const rows = await this.prisma.organization.findMany({
      where: { id: { in: [...organizationIds] } },
      select: { ...ORGANIZATION_SELECT, billingEmailVerifiedAt: true },
    });
    // L'adresse n'est enregistrée qu'à sa confirmation : la date de vérification est un second verrou.
    return rows.map(({ billingEmailVerifiedAt, ...row }) =>
      toOrganization({ ...row, billingEmail: billingEmailVerifiedAt ? row.billingEmail : null }),
    );
  }

  async membership(userId: string, organizationId: string): Promise<Membership | null> {
    const row = await this.prisma.organizationMember.findFirst({
      where: { userId, organizationId, removedAt: null },
      select: { role: true, organization: { select: ORGANIZATION_SELECT } },
    });
    return row ? { organization: toOrganization(row.organization), role: row.role } : null;
  }

  async memberships(userId: string): Promise<Membership[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { userId, removedAt: null },
      orderBy: { organizationId: 'desc' },
      select: { role: true, organization: { select: ORGANIZATION_SELECT } },
    });
    return rows.map((row) => ({ organization: toOrganization(row.organization), role: row.role }));
  }

  async list(
    filter: { status: OrganizationStatus | null },
    page: { limit: number; cursor: string | null },
  ): Promise<OrganizationPage> {
    const rows = await this.prisma.organization.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      select: ORGANIZATION_SELECT,
    });
    const items = rows.slice(0, page.limit).map(toOrganization);
    return { items, nextCursor: rows.length > page.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async members(organizationId: string): Promise<OrganizationMemberView[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { organizationId, removedAt: null },
      orderBy: { joinedAt: 'asc' },
      select: {
        userId: true,
        role: true,
        joinedAt: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            phones: { where: { isPrimary: true }, select: { phoneE164: true }, take: 1 },
          },
        },
      },
    });
    return rows.map((row) => ({
      userId: row.userId,
      role: row.role,
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      phoneE164: row.user.phones[0]?.phoneE164 ?? null,
      joinedAt: row.joinedAt,
    }));
  }

  async applyDecision(change: OrganizationStatusChange): Promise<Organization> {
    return this.prisma.$transaction(async (tx) => {
      // Transition conditionnelle : de deux décisions simultanées, une seule passe.
      const updated = await tx.organization.updateMany({
        where: { id: change.organizationId, status: change.from },
        data: decisionWrites(change),
      });
      if (updated.count !== 1) throw new OrganizationChangedError();
      const organization = toOrganization(
        await tx.organization.findUniqueOrThrow({
          where: { id: change.organizationId },
          select: ORGANIZATION_SELECT,
        }),
      );
      const [type, payload] = decisionEvent(change, organization);
      await this.publish(tx, change.now, type, payload);
      await tx.auditEntry.create({
        data: {
          id: change.auditId,
          actorId: change.actorId,
          action: AUDIT_ACTIONS[change.decision],
          entityType: 'organization',
          entityId: change.organizationId,
          at: change.now,
          details: { from: change.from, to: change.to, ...(change.reason ? { reason: change.reason } : {}) },
        },
      });
      return organization;
    });
  }

  private async publish<T extends KspEventType>(
    tx: Prisma.TransactionClient,
    occurredAt: Date,
    type: T,
    payload: KspEventPayloads[T],
  ): Promise<void> {
    await appendToOutbox(
      tx as unknown as SqlExecutor,
      createEnvelope(type, payload, { producer: 'identity', occurredAt }),
    );
  }
}
