import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import {
  RoleAssignmentNotFoundError,
  RoleAssignmentRevokedError,
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

  async activeRoles(userId: string): Promise<AssignedRole[]> {
    const rows = await this.prisma.roleAssignment.findMany({
      where: { userId, revokedAt: null },
      orderBy: { grantedAt: 'asc' },
      select: {
        scopeType: true,
        scopeId: true,
        role: { select: { code: true, requiresMfa: true, backofficeAccess: true } },
      },
    });
    return rows.map((row) => ({
      code: row.role.code,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      requiresMfa: row.role.requiresMfa,
      backofficeAccess: row.role.backofficeAccess,
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
    const base = { userId: input.userId, roleCode: input.roleCode, scopeType: input.scopeType };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.findUniqueOrThrow({
          where: { code: input.roleCode },
          select: { id: true },
        });
        const existing = await this.findActive(tx, input.userId, role.id, input.scopeId);
        if (existing)
          return { ...base, assignmentId: existing.id, scopeId: existing.scopeId, created: false };
        await tx.roleAssignment.create({
          data: {
            id: input.assignmentId,
            userId: input.userId,
            roleId: role.id,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
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
              grantedBy: input.grantedBy ?? 'system',
            },
            { producer: 'identity', occurredAt: input.now },
          ),
        );
        if (input.audit && input.grantedBy) {
          await tx.auditEntry.create({
            data: {
              id: input.audit.id,
              actorId: input.grantedBy,
              action: 'user.role_granted',
              entityType: 'user',
              entityId: input.userId,
              at: input.now,
              details: {
                assignmentId: input.assignmentId,
                roleCode: input.roleCode,
                scopeType: input.scopeType,
                scopeId: input.scopeId,
                reason: input.audit.reason,
              },
            },
          });
        }
        return { ...base, assignmentId: input.assignmentId, scopeId: input.scopeId, created: true };
      });
    } catch (error) {
      // Deux attributions simultanées : l'index unique partiel garde la première.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const role = await this.prisma.role.findUniqueOrThrow({ where: { code: input.roleCode } });
        const existing = await this.findActive(this.prisma, input.userId, role.id, input.scopeId);
        if (existing)
          return { ...base, assignmentId: existing.id, scopeId: existing.scopeId, created: false };
      }
      throw error;
    }
  }

  async revoke(revocation: RoleRevocation): Promise<{ roleCode: string }> {
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.roleAssignment.findFirst({
        where: { id: revocation.assignmentId, userId: revocation.userId },
        select: { revokedAt: true, role: { select: { code: true } } },
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
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope(
          'identity.role.revoked',
          {
            assignmentId: revocation.assignmentId,
            userId: revocation.userId,
            roleCode,
            revokedBy: revocation.actorId,
            reason: revocation.reason,
          },
          { producer: 'identity', occurredAt: revocation.now },
        ),
      );
      await tx.auditEntry.create({
        data: {
          id: revocation.auditId,
          actorId: revocation.actorId,
          action: 'user.role_revoked',
          entityType: 'user',
          entityId: revocation.userId,
          at: revocation.now,
          details: { assignmentId: revocation.assignmentId, roleCode, reason: revocation.reason },
        },
      });
      return { roleCode };
    });
  }

  private findActive(
    db: Prisma.TransactionClient,
    userId: string,
    roleId: string,
    scopeId: string | null,
  ): Promise<{ id: string; scopeId: string | null } | null> {
    return db.roleAssignment.findFirst({
      where: { userId, roleId, scopeId, revokedAt: null },
      select: { id: true, scopeId: true },
    });
  }
}
