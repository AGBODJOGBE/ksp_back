/**
 * Amorçage des comptes internes, tant que l'écran d'administration n'existe pas (UC-ID-18, UC-ID-19) :
 *   pnpm --filter @ksp/identity-service build
 *   pnpm --filter @ksp/identity-service roles:grant <+229…> <rôle>
 * Le compte doit exister (une première connexion par téléphone sur le site ou l'application).
 * La portée est celle du rôle : globale, ou le métier qui le déclare. Relancer la commande ne
 * crée pas de doublon. L'attribution publie identity.role.granted (grantedBy = "system").
 * Lit DATABASE_URL (fichier .env du service s'il existe).
 */
import { AppError, ReadinessRegistry } from '@ksp/platform';
import { GrantRoleUseCase } from '../application/role/grant-role.use-case';
import { INITIAL_BACKOFFICE_ROLES } from '../domain/role/role';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { PrismaRoleRepository } from '../infrastructure/role/prisma-role.repository';
import { PrismaLoginRepository } from '../infrastructure/session/prisma-login.repository';
import { SystemClock, UuidV7Generator } from '../infrastructure/system/system';

async function main(): Promise<number> {
  const [phone, roleCode] = process.argv.slice(2);
  if (!phone || !roleCode) {
    const roles = INITIAL_BACKOFFICE_ROLES.map((role) => role.code).join(', ');
    process.stderr.write(`Usage : roles:grant <+229…> <rôle>\nRôles du back-office : ${roles}\n`);
    return 2;
  }
  const prisma = new PrismaService(new ReadinessRegistry());
  try {
    const grant = await new GrantRoleUseCase(
      new PrismaLoginRepository(prisma),
      new PrismaRoleRepository(prisma),
      new UuidV7Generator(),
      new SystemClock(),
    ).execute({ phone, roleCode });
    const scope = grant.scopeId ? `${grant.scopeType}:${grant.scopeId}` : grant.scopeType;
    process.stdout.write(
      grant.created
        ? `Rôle ${grant.roleCode} (${scope}) attribué au compte ${grant.userId}.\n`
        : `Le compte ${grant.userId} a déjà le rôle ${grant.roleCode} (${scope}).\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      process.stderr.write(`${error.code} : ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
