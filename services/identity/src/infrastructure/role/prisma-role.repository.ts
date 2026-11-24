import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  RoleAssignmentNotFoundError,
  RoleAssignmentRevokedError,
  RoleInactiveError,
  type RoleGrant,
  type RoleRepository,
  type RoleRevocation,
} from '../../application/role/role.ports';
import { type AssignedRole, type RoleDefinition } from '../../domain/role/role';
import { SUPER_ADMIN_ROLE } from '../../domain/role/role-administration';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';
import { ensureAnotherSuperAdmin } from './super-admin-guard';

/** Rôles et attributions, en base identity. */
@Injectable()
export class PrismaRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rôles actifs du compte, avec leurs zones et leurs permissions cochées non retirées. super_admin
   * reçoit toutes les permissions déclarées et non retirées (ADR-057, à valider).
   */
  async activeRoles(userId: string): Promise<AssignedRole[]> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: { userId, revokedAt: null },
      orderBy: { grantedAt: 'asc' },
      select: {
        scopeType: true,
        scopeId: true,
        zoneKeys: true,
        role: {
          select: {
            code: true,
            requiresMfa: true,
            backofficeAccess: true,
            permissions: {
              where: { permission: { retiredAt: null } },
              select: { permissionCode: true },
            },
          },
        },
      },
    });
    const everything = rows.some((row) => row.role.code === SUPER_ADMIN_ROLE)
      ? (await this.prisma.permission.findMany({ where: { retiredAt: null }, select: { code: true } })).map(
          (permission) => permission.code,
        )
      : [];
    return rows.map((row) => ({
      code: row.role.code,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      requiresMfa: row.role.requiresMfa,
      backofficeAccess: row.role.backofficeAccess,
      zoneKeys: row.zoneKeys,
      permissions:
        row.role.code === SUPER_ADMIN_ROLE
          ? everything
          : row.role.permissions.map((permission) => permission.permissionCode).sort(),
    }));
  }

  async findDefinition(code: string): Promise<RoleDefinition | null> {
    return this.prisma.role.findUnique({
      where: { code },
      select: {
        service: true,
        code: true,
        scopeType: true,
        requiresMfa: true,
        backofficeAccess: true,
        description: true,
      },
    });
  }

  async grant(input: Parameters<RoleRepository['grant']>[0]): Promise<RoleGrant> {
    const base = {
      userId: input.userId,
      roleCode: input.roleCode,
      scopeType: input.scopeType,
      zoneKeys: input.zoneKeys,
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lecture partagée du rôle : une désactivation simultanée passe avant ou après (ADR-057).
        const [role] = await tx.$queryRaw<{ id: string; deactivated_at: Date | null }[]>`
          SELECT "id", "deactivated_at" FROM "roles" WHERE "code" = ${input.roleCode} FOR SHARE`;
        if (!role) throw new Error(`rôle inconnu : ${input.roleCode}`);
        if (role.deactivated_at) throw new RoleInactiveError();
        const existing = await this.findActive(tx, input.userId, role.id, input.scopeId, input.zoneKeys);
        if (existing)
          return {
            ...base,
            assignmentId: existing.id,
            scopeId: existing.scopeId,
            grantedAt: existing.grantedAt,
            created: false,
          };
        await tx.roleAssignment.create({
          data: {
            id: input.assignmentId,
            userId: input.userId,
            roleId: role.id,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            zoneKeys: input.zoneKeys,
            grantedBy: input.grantedBy,
            grantedAt: input.now,
            grantReason: input.audit?.reason ?? null,
          },
        });
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope(
            'identity.role.granted',
            {
              assignmentId: input.assignmentId,
              userId: input.userId,
              roleCode: input.roleCode,
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              ...(input.zoneKeys.length ? { zoneKeys: input.zoneKeys } : {}),
              grantedBy: input.grantedBy ?? input.audit?.service ?? 'system',
            },
            // Version 2 (portée zone) : aucun consommateur ne lit encore cet événement (RV-101).
            { producer: 'identity', occurredAt: input.now, version: 2 },
          ),
        );
        const actorId = input.grantedBy ?? input.audit?.service;
        if (input.audit && actorId) {
          await tx.auditEntry.create({
            data: {
              id: input.audit.id,
              actorId,
              action: 'user.role_granted',
              entityType: 'user',
              entityId: input.userId,
              at: input.now,
              details: {
                assignmentId: input.assignmentId,
                roleCode: input.roleCode,
                scopeType: input.scopeType,
                scopeId: input.scopeId,
                zoneKeys: input.zoneKeys,
                reason: input.audit.reason,
              },
            },
          });
        }
        return {
          ...base,
          assignmentId: input.assignmentId,
          scopeId: input.scopeId,
          grantedAt: input.now,
          created: true,
        };
      });
    } catch (error) {
      // Deux attributions simultanées : l'index unique partiel garde la première.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const role = await this.prisma.role.findUniqueOrThrow({ where: { code: input.roleCode } });
        const existing = await this.findActive(
          this.prisma,
          input.userId,
          role.id,
          input.scopeId,
          input.zoneKeys,
        );
        if (existing)
          return {
            ...base,
            assignmentId: existing.id,
            scopeId: existing.scopeId,
            grantedAt: existing.grantedAt,
            created: false,
          };
      }
      throw error;
    }
  }

  async revoke(revocation: RoleRevocation): Promise<{ roleCode: string; sessionsRevoked: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.roleAssignment.findFirst({
        where: { id: revocation.assignmentId, userId: revocation.userId },
        select: { revokedAt: true, role: { select: { code: true, sensitive: true } } },
      });
      if (!assignment) throw new RoleAssignmentNotFoundError();
      if (assignment.revokedAt) throw new RoleAssignmentRevokedError();
      const roleCode = assignment.role.code;
      // Le dernier super administrateur d'un compte actif ne se retire pas (verrou du rôle).
      if (roleCode === SUPER_ADMIN_ROLE) await ensureAnotherSuperAdmin(tx, revocation.userId);
      // Retrait conditionnel : de deux retraits simultanés, un seul passe.
      const updated = await tx.roleAssignment.updateMany({
        where: { id: revocation.assignmentId, revokedAt: null },
        data: {
          revokedAt: revocation.now,
          revokedBy: revocation.actorId,
          revokeReason: revocation.reason,
        },
      });
      if (updated.count !== 1) throw new RoleAssignmentRevokedError();
      // Rôle sensible (R-RB-05) : toutes les sessions fermées tout de suite, pas au renouvellement.
      const sessionsRevoked = assignment.role.sensitive || roleCode === SUPER_ADMIN_ROLE;
      if (sessionsRevoked) {
        await tx.session.updateMany({
          where: { userId: revocation.userId, revokedAt: null },
          data: { revokedAt: revocation.now, revokeReason: 'sensitive_role_revoked' },
        });
      }
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope(
          'identity.role.revoked',
          {
            assignmentId: revocation.assignmentId,
            userId: revocation.userId,
            roleCode,
            revokedBy: revocation.actorId ?? revocation.service ?? 'system',
            reason: revocation.reason,
            sessionsRevoked,
          },
          { producer: 'identity', occurredAt: revocation.now },
        ),
      );
      await tx.auditEntry.create({
        data: {
          id: revocation.auditId,
          actorId: revocation.actorId ?? revocation.service ?? 'system',
          action: 'user.role_revoked',
          entityType: 'user',
          entityId: revocation.userId,
          at: revocation.now,
          details: {
            assignmentId: revocation.assignmentId,
            roleCode,
            reason: revocation.reason,
            sessionsRevoked,
          },
        },
      });
      return { roleCode, sessionsRevoked };
    });
  }

  private findActive(
    db: Prisma.TransactionClient,
    userId: string,
    roleId: string,
    scopeId: string | null,
    zoneKeys: string[],
  ): Promise<{ id: string; scopeId: string | null; grantedAt: Date } | null> {
    return db.roleAssignment.findFirst({
      where: { userId, roleId, scopeId, zoneKeys: { equals: zoneKeys }, revokedAt: null },
      select: { id: true, scopeId: true, grantedAt: true },
    });
  }
}
