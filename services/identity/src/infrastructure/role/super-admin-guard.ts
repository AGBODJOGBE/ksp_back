import { LastSuperAdminError } from '../../application/role/role.ports';
import { SUPER_ADMIN_ROLE } from '../../domain/role/role-administration';
import { type Prisma } from '../../../prisma/generated';

/**
 * Garde « jamais sans super administrateur » (ADR-038), à appeler dans la transaction qui retire le
 * rôle super_admin d'un compte ou suspend un compte. Verrouille la ligne du rôle super_admin : deux
 * retraits simultanés (deux super administrateurs qui se retirent l'un l'autre) passent l'un après
 * l'autre, et le second voit le premier. Lève LastSuperAdminError si aucun autre compte actif ne
 * garderait le rôle.
 */
export async function ensureAnotherSuperAdmin(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "roles" WHERE "code" = ${SUPER_ADMIN_ROLE} FOR UPDATE`;
  const others = await tx.roleAssignment.count({
    where: {
      role: { code: SUPER_ADMIN_ROLE },
      revokedAt: null,
      userId: { not: userId },
      user: { status: 'active' },
    },
  });
  if (others === 0) throw new LastSuperAdminError();
}

/** Le compte a-t-il le rôle super_admin actif ? */
export async function holdsSuperAdmin(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  const held = await tx.roleAssignment.count({
    where: { userId, revokedAt: null, role: { code: SUPER_ADMIN_ROLE } },
  });
  return held > 0;
}
