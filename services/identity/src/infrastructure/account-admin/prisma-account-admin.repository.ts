import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  type AccountAdminRepository,
  type AccountAuditView,
  type AccountSearch,
  type AccountStatusChange,
  AccountStatusChangedError,
  type AdminAccountView,
  type MfaStatusView,
  type RoleAssignmentView,
} from '../../application/account-admin/account-admin.ports';
import { isUuid } from '../../application/context/active-contexts';
import { type RoleDefinition } from '../../domain/role/role';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';
import { ensureAnotherSuperAdmin, holdsSuperAdmin } from '../role/super-admin-guard';

const ROLE_SELECT = {
  service: true,
  code: true,
  scopeType: true,
  requiresMfa: true,
  backofficeAccess: true,
  description: true,
} as const;

const ADMIN_ACCOUNT_SELECT = {
  id: true,
  status: true,
  firstName: true,
  lastName: true,
  createdAt: true,
  suspendedAt: true,
  suspensionReason: true,
  phones: { where: { isPrimary: true }, select: { phoneE164: true }, take: 1 },
  roleAssignments: {
    where: { revokedAt: null },
    orderBy: { grantedAt: 'asc' },
    select: { role: { select: { code: true } } },
  },
} as const;

type AdminAccountRow = Prisma.UserGetPayload<{ select: typeof ADMIN_ACCOUNT_SELECT }>;

function toAdminAccount(row: AdminAccountRow): AdminAccountView {
  return {
    id: row.id,
    status: row.status,
    firstName: row.firstName,
    lastName: row.lastName,
    phoneE164: row.phones[0]?.phoneE164 ?? null,
    createdAt: row.createdAt,
    suspendedAt: row.suspendedAt,
    suspensionReason: row.suspensionReason,
    roleCodes: row.roleAssignments.map((assignment) => assignment.role.code),
  };
}

/** Champ texte d'une trace d'audit (details en JSON) ; null s'il est absent ou mal formé. */
function detail(details: Prisma.JsonValue, key: string): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

const STATUS_EVENTS = { suspend: 'user.suspended', reactivate: 'user.reactivated' } as const;

/** Administration des comptes au back-office (ADR-043), en base identity. */
@Injectable()
export class PrismaAccountAdminRepository implements AccountAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  async search(search: AccountSearch): Promise<{ items: AdminAccountView[]; nextCursor: string | null }> {
    const filters: Prisma.UserWhereInput[] = [{ status: { not: 'deleted' } }];
    if (search.cursor) filters.push({ id: { lt: search.cursor } });
    const { query } = search;
    if (query.kind === 'phone') filters.push({ phones: { some: { phoneE164: query.e164 } } });
    if (query.kind === 'name') {
      for (const word of query.words) {
        filters.push({
          OR: [
            { firstName: { contains: word, mode: 'insensitive' } },
            { lastName: { contains: word, mode: 'insensitive' } },
          ],
        });
      }
    }
    if (query.kind === 'staff' || search.teamOf) {
      filters.push({
        roleAssignments: {
          some: {
            revokedAt: null,
            ...(search.teamOf ? { role: { service: { in: [...search.teamOf] } } } : {}),
          },
        },
      });
    }
    const rows = await this.prisma.user.findMany({
      where: { AND: filters },
      orderBy: { id: 'desc' },
      take: search.limit + 1,
      select: ADMIN_ACCOUNT_SELECT,
    });
    const items = rows.slice(0, search.limit).map(toAdminAccount);
    return { items, nextCursor: rows.length > search.limit ? (items.at(-1)?.id ?? null) : null };
  }

  async findAccount(userId: string): Promise<AdminAccountView | null> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: ADMIN_ACCOUNT_SELECT });
    return row ? toAdminAccount(row) : null;
  }

  async assignments(userId: string): Promise<RoleAssignmentView[]> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: { userId },
      orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { grantedAt: 'desc' }],
      select: {
        id: true,
        scopeType: true,
        scopeId: true,
        grantedAt: true,
        grantedBy: true,
        grantReason: true,
        revokedAt: true,
        revokedBy: true,
        revokeReason: true,
        role: { select: ROLE_SELECT },
      },
    });
    const names = await this.namesOf(rows.flatMap((row) => [row.grantedBy, row.revokedBy]));
    return rows.map((row) => ({
      ...row,
      grantedByName: row.grantedBy ? (names.get(row.grantedBy) ?? null) : null,
      revokedByName: row.revokedBy ? (names.get(row.revokedBy) ?? null) : null,
    }));
  }

  async history(userId: string, limit: number): Promise<AccountAuditView[]> {
    const rows = await this.prisma.auditEntry.findMany({
      where: { entityType: 'user', entityId: userId },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    const names = await this.namesOf(rows.map((row) => row.actorId));
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      at: row.at,
      actorId: row.actorId,
      actorName: names.get(row.actorId) ?? null,
      roleCode: detail(row.details, 'roleCode'),
      reason: detail(row.details, 'reason'),
    }));
  }

  async mfaStatus(userId: string): Promise<MfaStatusView> {
    const [factor, unused, codes] = await Promise.all([
      this.prisma.mfaFactor.findUnique({
        where: { userId_type: { userId, type: 'totp' } },
        select: { enabledAt: true },
      }),
      this.prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } }),
      this.prisma.mfaRecoveryCode.count({ where: { userId } }),
    ]);
    const configuredAt = factor?.enabledAt ?? null;
    return {
      configuredAt,
      recoveryCodesRemaining: configuredAt ? unused : 0,
      resettable: factor !== null || codes > 0,
    };
  }

  async catalog(): Promise<RoleDefinition[]> {
    return this.prisma.role.findMany({ orderBy: { code: 'asc' }, select: ROLE_SELECT });
  }

  async changeStatus(change: AccountStatusChange): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const suspend = change.action === 'suspend';
      // Jamais sans super administrateur actif : la suspension en compte un de moins.
      if (suspend && (await holdsSuperAdmin(tx, change.userId))) {
        await ensureAnotherSuperAdmin(tx, change.userId);
      }
      // Transition conditionnelle : de deux décisions simultanées, une seule passe.
      const updated = await tx.user.updateMany({
        where: { id: change.userId, status: change.from },
        data: suspend
          ? {
              status: 'suspended',
              suspendedAt: change.now,
              suspendedBy: change.actorId,
              suspensionReason: change.reason,
            }
          : { status: 'active', suspendedAt: null, suspendedBy: null, suspensionReason: null },
      });
      if (updated.count !== 1) throw new AccountStatusChangedError();
      if (suspend) {
        // Effet immédiat sur les renouvellements ; un jeton d'accès déjà émis expire seul (15 minutes).
        await tx.session.updateMany({
          where: { userId: change.userId, revokedAt: null },
          data: { revokedAt: change.now, revokeReason: 'account_suspended' },
        });
      }
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        suspend
          ? createEnvelope(
              'identity.user.suspended',
              { userId: change.userId, reason: change.reason, suspendedBy: change.actorId },
              { producer: 'identity', occurredAt: change.now },
            )
          : createEnvelope(
              'identity.user.reactivated',
              { userId: change.userId, reactivatedBy: change.actorId },
              { producer: 'identity', occurredAt: change.now },
            ),
      );
      await tx.auditEntry.create({
        data: {
          id: change.auditId,
          actorId: change.actorId,
          action: STATUS_EVENTS[change.action],
          entityType: 'user',
          entityId: change.userId,
          at: change.now,
          details: { from: change.from, to: change.to, reason: change.reason },
        },
      });
    });
  }

  async resetMfa(change: {
    userId: string;
    actorId: string;
    reason: string;
    auditId: string;
    now: Date;
    enrollBefore: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const factors = await tx.mfaFactor.deleteMany({ where: { userId: change.userId } });
      const codes = await tx.mfaRecoveryCode.deleteMany({ where: { userId: change.userId } });
      if (factors.count === 0 && codes.count === 0) return false;
      // Les sessions ouvertes avec l'ancienne application, et les connexions en cours, sont fermées.
      await tx.session.updateMany({
        where: { userId: change.userId, clientKind: 'backoffice', revokedAt: null },
        data: { revokedAt: change.now, revokeReason: 'mfa_reset' },
      });
      await tx.mfaChallenge.updateMany({
        where: { userId: change.userId, consumedAt: null },
        data: { consumedAt: change.now },
      });
      await tx.auditEntry.create({
        data: {
          id: change.auditId,
          actorId: change.actorId,
          action: 'user.mfa_reset',
          entityType: 'user',
          entityId: change.userId,
          at: change.now,
          details: { reason: change.reason, recoveryCodesRemoved: codes.count },
        },
      });
      // Reconfiguration ouverte peu de temps, et titulaire prévenu (ADR-050).
      await tx.user.update({
        where: { id: change.userId },
        data: { mfaEnrollmentDeadline: change.enrollBefore },
      });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope(
          'identity.user.mfa_reset',
          { userId: change.userId, enrollBefore: change.enrollBefore.toISOString() },
          { producer: 'identity', occurredAt: change.now },
        ),
      );
      return true;
    });
  }

  /** Noms affichés des auteurs (prénom et nom) ; un auteur sans nom est absent. */
  private async namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id && isUuid(id)))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(
      users.flatMap((user) => {
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        return name ? [[user.id, name] as const] : [];
      }),
    );
  }
}
