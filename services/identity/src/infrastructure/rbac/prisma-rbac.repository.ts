import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import { rbacErrors } from '../../application/rbac/rbac-errors';
import {
  type CatalogRegistration,
  type CatalogRegistrationResult,
  type DeclaredPermission,
  type DefaultRole,
  type ManagedRoleRepository,
  type ManagedRoleView,
  type PermissionCatalog,
  RoleCodeTakenError,
  RoleInUseError,
  type StaffDirectory,
} from '../../application/rbac/rbac.ports';
import { SUPER_ADMIN_ROLE } from '../../domain/role/role-administration';
import { Prisma } from '../../../prisma/generated';
import { PrismaService } from '../prisma/prisma.service';

const ROLE_SELECT = {
  code: true,
  name: true,
  description: true,
  service: true,
  origin: true,
  scopeType: true,
  sensitive: true,
  backofficeAccess: true,
  requiresMfa: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  deactivatedAt: true,
  deactivatedBy: true,
  permissions: { select: { permissionCode: true }, orderBy: { permissionCode: 'asc' } },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof ROLE_SELECT }>;

const toDefaultRole = (row: RoleRow): DefaultRole & { service: string } => ({
  code: row.code,
  name: row.name ?? row.code,
  description: row.description,
  service: row.service,
  scopeType: row.scopeType,
  requiresMfa: row.requiresMfa,
  backofficeAccess: row.backofficeAccess,
  sensitive: row.sensitive,
  permissions: row.permissions.map((permission) => permission.permissionCode),
});

/**
 * Catalogue des permissions et rôles gérés (ADR-057), en base identity. Chaque écriture d'un rôle
 * publie son événement (outbox) et sa trace d'audit (avant, après) dans la même transaction (R-RB-06).
 */
@Injectable()
export class PrismaRbacRepository implements PermissionCatalog, ManagedRoleRepository, StaffDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async staffWith(permission: string, zoneKey: string | null): Promise<string[]> {
    // Permission retirée : plus personne ne la porte, super_admin compris.
    const declared = await this.prisma.permission.count({ where: { code: permission, retiredAt: null } });
    if (!declared) return [];
    const rows = await this.prisma.roleAssignment.findMany({
      where: {
        revokedAt: null,
        user: { status: 'active' },
        role: {
          deactivatedAt: null,
          OR: [{ code: SUPER_ADMIN_ROLE }, { permissions: { some: { permissionCode: permission } } }],
        },
        // Attribution sans limite de zone, ou limitée à la zone demandée.
        OR: [{ zoneKeys: { isEmpty: true } }, ...(zoneKey ? [{ zoneKeys: { has: zoneKey } }] : [])],
      },
      select: { userId: true },
      distinct: ['userId'],
      orderBy: { userId: 'asc' },
    });
    return rows.map((row) => row.userId);
  }

  async accountStatus(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    return user?.status ?? null;
  }

  async assignment(
    assignmentId: string,
  ): Promise<{ userId: string; roleCode: string; revoked: boolean } | null> {
    const row = await this.prisma.roleAssignment.findUnique({
      where: { id: assignmentId },
      select: { userId: true, revokedAt: true, role: { select: { code: true } } },
    });
    return row ? { userId: row.userId, roleCode: row.role.code, revoked: row.revokedAt !== null } : null;
  }

  async register(input: CatalogRegistration): Promise<CatalogRegistrationResult> {
    return this.prisma.$transaction(async (tx) => {
      // Une ligne par service, verrouillée : deux déploiements simultanés passent l'un après l'autre.
      await tx.$executeRaw`INSERT INTO "catalog_registrations" ("service", "version", "registered_at")
        VALUES (${input.service}, 0, ${input.now}) ON CONFLICT ("service") DO NOTHING`;
      const [registered] = await tx.$queryRaw<{ version: number }[]>`
        SELECT "version" FROM "catalog_registrations" WHERE "service" = ${input.service} FOR UPDATE`;
      if ((registered?.version ?? 0) >= input.version) {
        return { permissionsAdded: 0, permissionsRetired: 0, rolesCreated: 0 };
      }

      const known = new Map(
        (
          await tx.permission.findMany({
            where: { service: input.service },
            select: { code: true, retiredAt: true },
          })
        ).map((row) => [row.code, row.retiredAt]),
      );
      let permissionsAdded = 0;
      for (const permission of input.permissions) {
        const retiredAt = known.get(permission.code);
        if (retiredAt === undefined || retiredAt !== null) permissionsAdded += 1;
        await tx.permission.upsert({
          where: { code: permission.code },
          create: {
            code: permission.code,
            service: input.service,
            description: permission.description,
            registeredAt: input.now,
          },
          update: { description: permission.description, retiredAt: null },
        });
      }
      const retired = await tx.permission.updateMany({
        where: {
          service: input.service,
          retiredAt: null,
          code: { notIn: input.permissions.map((permission) => permission.code) },
        },
        data: { retiredAt: input.now },
      });

      let rolesCreated = 0;
      for (const role of input.roles) {
        if (await tx.role.findUnique({ where: { code: role.code }, select: { id: true } })) {
          await this.completeDefaultRole(tx, input, role);
          continue;
        }
        const usable = await tx.permission.count({
          where: { code: { in: role.permissions }, retiredAt: null },
        });
        if (usable !== new Set(role.permissions).size)
          throw rbacErrors.catalogInvalid(`roles.${role.code}.permissions`);
        await tx.role.create({
          data: {
            id: input.newRoleId(),
            service: input.service,
            code: role.code,
            name: role.name || null,
            description: role.description,
            scopeType: role.scopeType,
            requiresMfa: role.requiresMfa,
            backofficeAccess: role.backofficeAccess,
            sensitive: role.sensitive,
            origin: 'default',
            createdAt: input.now,
            permissions: {
              create: [...new Set(role.permissions)].map((permissionCode) => ({ permissionCode })),
            },
          },
        });
        rolesCreated += 1;
      }
      await tx.catalogRegistration.update({
        where: { service: input.service },
        data: { version: input.version, registeredAt: input.now },
      });
      return { permissionsAdded, permissionsRetired: retired.count, rolesCreated };
    });
  }

  /**
   * Rôle déjà en base, déclaré de nouveau par un service. S'il est livré par défaut et qu'aucun
   * administrateur ne l'a modifié ni désactivé, il reçoit celles des permissions du service déclarant,
   * déclarées pour lui, qui lui manquent : ajout seulement, jamais de retrait, jamais la permission
   * d'un autre service. Tout autre rôle (modifié au back-office, créé au back-office, désactivé) reste
   * tel quel (R-RB-02). Les colonnes de modification ne sont pas touchées : un autre service peut
   * encore compléter le même rôle avec ses propres permissions.
   */
  private async completeDefaultRole(
    tx: Prisma.TransactionClient,
    input: CatalogRegistration,
    role: DefaultRole,
  ): Promise<void> {
    // Verrou du rôle : une modification simultanée au back-office passe avant ou après.
    const [locked] = await tx.$queryRaw<
      {
        id: string;
        origin: string;
        updated_at: Date | null;
        updated_by: string | null;
        deactivated_at: Date | null;
      }[]
    >`SELECT "id", "origin", "updated_at", "updated_by", "deactivated_at"
        FROM "roles" WHERE "code" = ${role.code} FOR UPDATE`;
    if (!locked || locked.origin !== 'default') return;
    if (locked.updated_at !== null || locked.updated_by !== null || locked.deactivated_at !== null) return;
    const held = (
      await tx.rolePermission.findMany({ where: { roleId: locked.id }, select: { permissionCode: true } })
    ).map((row) => row.permissionCode);
    const declared = new Set(input.permissions.map((permission) => permission.code));
    const missing = [...new Set(role.permissions)]
      .filter((code) => declared.has(code) && !held.includes(code))
      .sort();
    if (!missing.length) return;
    await tx.rolePermission.createMany({
      data: missing.map((permissionCode) => ({ roleId: locked.id, permissionCode })),
    });
    await tx.auditEntry.create({
      data: {
        id: input.newAuditId(),
        actorId: input.service,
        action: 'role.default_permissions_added',
        entityType: 'role',
        entityId: role.code,
        at: input.now,
        details: {
          service: input.service,
          catalogVersion: input.version,
          permissionsAdded: missing,
          before: [...held].sort(),
          after: [...held, ...missing].sort(),
        } as Prisma.InputJsonValue,
      },
    });
  }

  async permissions(filter: {
    service: string | null;
    includeRetired: boolean;
  }): Promise<DeclaredPermission[]> {
    const rows = await this.prisma.permission.findMany({
      where: {
        ...(filter.service ? { service: filter.service } : {}),
        ...(filter.includeRetired ? {} : { retiredAt: null }),
      },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) => ({
      code: row.code,
      description: row.description,
      service: row.service,
      retired: row.retiredAt !== null,
    }));
  }

  async roles(service: string | null): Promise<(DefaultRole & { service: string })[]> {
    const rows = await this.prisma.role.findMany({
      where: service ? { service } : {},
      select: ROLE_SELECT,
      orderBy: { code: 'asc' },
    });
    return rows.map(toDefaultRole);
  }

  async find(code: string): Promise<ManagedRoleView | null> {
    const row = await this.prisma.role.findUnique({ where: { code }, select: ROLE_SELECT });
    if (!row) return null;
    const activeAssignments = await this.prisma.roleAssignment.count({
      where: { role: { code }, revokedAt: null },
    });
    return {
      ...toDefaultRole(row),
      origin: row.origin === 'custom' ? 'custom' : 'default',
      active: row.deactivatedAt === null,
      activeAssignments,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      deactivatedAt: row.deactivatedAt,
      deactivatedBy: row.deactivatedBy,
    };
  }

  async unusablePermissions(codes: readonly string[]): Promise<string[]> {
    const usable = new Set(
      (
        await this.prisma.permission.findMany({
          where: { code: { in: [...codes] }, retiredAt: null },
          select: { code: true },
        })
      ).map((row) => row.code),
    );
    return codes.filter((code) => !usable.has(code));
  }

  async create(input: Parameters<ManagedRoleRepository['create']>[0]): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.role.create({
          data: {
            id: input.id,
            service: 'identity',
            code: input.code,
            name: input.name,
            description: input.description,
            // Rôle créé au back-office : portée globale, titulaires limitables à des zones (R-RB-03).
            scopeType: 'global',
            requiresMfa: true,
            backofficeAccess: true,
            sensitive: input.sensitive,
            origin: 'custom',
            createdAt: input.now,
            createdBy: input.actorId,
            permissions: { create: input.permissions.map((permissionCode) => ({ permissionCode })) },
          },
        });
        const after = {
          name: input.name,
          description: input.description,
          sensitive: input.sensitive,
          permissions: input.permissions,
        };
        await this.trace(tx, input, 'role.created', input.code, { after });
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope(
            'identity.role.created',
            {
              roleCode: input.code,
              name: input.name,
              permissions: input.permissions,
              sensitive: input.sensitive,
              createdBy: input.actorId,
            },
            { producer: 'identity', occurredAt: input.now },
          ),
        );
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new RoleCodeTakenError();
      }
      throw error;
    }
  }

  async update(input: Parameters<ManagedRoleRepository['update']>[0]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "roles" WHERE "code" = ${input.code} FOR UPDATE`;
      const before = await tx.role.findUniqueOrThrow({ where: { code: input.code }, select: ROLE_SELECT });
      const previous = before.permissions.map((permission) => permission.permissionCode);
      const next = input.permissions ?? previous;
      const added = next.filter((code) => !previous.includes(code));
      const removed = previous.filter((code) => !next.includes(code));
      await tx.role.update({
        where: { code: input.code },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
          updatedAt: input.now,
          updatedBy: input.actorId,
        },
      });
      if (removed.length) {
        await tx.rolePermission.deleteMany({
          where: { roleId: locked?.id, permissionCode: { in: removed } },
        });
      }
      if (added.length && locked) {
        await tx.rolePermission.createMany({
          data: added.map((permissionCode) => ({ roleId: locked.id, permissionCode })),
        });
      }
      const snapshot = (
        name: string | null,
        description: string,
        sensitive: boolean,
        permissions: string[],
      ) => ({
        name,
        description,
        sensitive,
        permissions,
      });
      await this.trace(tx, input, 'role.updated', input.code, {
        before: snapshot(before.name, before.description, before.sensitive, previous),
        after: snapshot(
          input.name ?? before.name,
          input.description ?? before.description,
          input.sensitive ?? before.sensitive,
          [...next].sort(),
        ),
      });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope(
          'identity.role.updated',
          {
            roleCode: input.code,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
            permissionsAdded: added,
            permissionsRemoved: removed,
            updatedBy: input.actorId,
          },
          { producer: 'identity', occurredAt: input.now },
        ),
      );
    });
  }

  async deactivate(input: Parameters<ManagedRoleRepository['deactivate']>[0]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Verrou du rôle : une attribution simultanée (qui le lit en partage) passe avant ou après.
      await tx.$queryRaw`SELECT "id" FROM "roles" WHERE "code" = ${input.code} FOR UPDATE`;
      const activeAssignments = await tx.roleAssignment.count({
        where: { role: { code: input.code }, revokedAt: null },
      });
      if (activeAssignments > 0) throw new RoleInUseError(activeAssignments);
      await tx.role.update({
        where: { code: input.code },
        data: {
          deactivatedAt: input.now,
          deactivatedBy: input.actorId,
          updatedAt: input.now,
          updatedBy: input.actorId,
        },
      });
      await this.trace(tx, input, 'role.deactivated', input.code, { reason: input.reason });
      await appendToOutbox(
        tx as unknown as SqlExecutor,
        createEnvelope(
          'identity.role.deactivated',
          { roleCode: input.code, deactivatedBy: input.actorId, reason: input.reason },
          { producer: 'identity', occurredAt: input.now },
        ),
      );
    });
  }

  /** Trace d'audit d'une écriture de rôle (qui, quoi, quand, avant, après ; R-RB-06). */
  private trace(
    tx: Prisma.TransactionClient,
    input: { actorId: string; reason: string; auditId: string; now: Date },
    action: string,
    code: string,
    details: Record<string, unknown>,
  ) {
    return tx.auditEntry.create({
      data: {
        id: input.auditId,
        actorId: input.actorId,
        action,
        entityType: 'role',
        entityId: code,
        at: input.now,
        details: { reason: input.reason, ...details } as Prisma.InputJsonValue,
      },
    });
  }
}
