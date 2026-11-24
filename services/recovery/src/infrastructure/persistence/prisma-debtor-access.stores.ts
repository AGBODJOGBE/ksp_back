import { Injectable } from '@nestjs/common';
import { type DebtorAccess as AccessRow, type Prisma } from '../../../prisma/generated';
import {
  type CaseDebtor,
  type DebtorAccessChange,
  type DebtorAccessStore,
  type DebtorCaseReader,
  type EncryptedContact,
  type NewDebtorAccess,
  type StoredDebtorAccess,
  type StoredDebtorSession,
} from '../../application/debtor-access/debtor-access.ports';
import { PrismaService } from '../prisma/prisma.service';

/** Ligne de `debtor_accesses` → lien, code en cours et compteurs. */
function toAccess(row: AccessRow): StoredDebtorAccess {
  return {
    id: row.id,
    caseId: row.caseId,
    debtorId: row.debtorId,
    link: { issuedAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt },
    code:
      row.codeHash !== null && row.codeExpiresAt !== null
        ? { hash: row.codeHash, expiresAt: row.codeExpiresAt }
        : null,
    codeSentAt: row.codeSentAt,
    codesSent: row.codesSentCount,
    attempts: { failures: row.failedAttempts, lockedUntil: row.lockedUntil },
  };
}

/** Changement décidé par le cas d'usage → colonnes ; un champ absent reste inchangé. */
function columnsOf(change: DebtorAccessChange): Prisma.DebtorAccessUpdateInput {
  return {
    ...(change.code !== undefined
      ? { codeHash: change.code?.hash ?? null, codeExpiresAt: change.code?.expiresAt ?? null }
      : {}),
    ...(change.codeSentAt !== undefined ? { codeSentAt: change.codeSentAt } : {}),
    ...(change.countCodeSent ? { codesSentCount: { increment: 1 } } : {}),
    ...(change.attempts
      ? { failedAttempts: change.attempts.failures, lockedUntil: change.attempts.lockedUntil }
      : {}),
  };
}

/** Révoque des liens et leurs sessions encore ouvertes, dans la transaction en cours. */
async function revokeAccesses(tx: Prisma.TransactionClient, ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.debtorAccess.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: at } });
  await tx.debtorSession.updateMany({
    where: { accessId: { in: ids }, revokedAt: null },
    data: { revokedAt: at },
  });
}

/**
 * Liens et sessions du débiteur (ADR-061) : seules les empreintes des jetons et du code sont en base.
 * L'émission d'un lien se fait sous le verrou du débiteur ; chaque envoi de code, essai ou ouverture
 * de session, sous le verrou de la ligne du lien (ADR-050).
 */
@Injectable()
export class PrismaDebtorAccessStore implements DebtorAccessStore {
  constructor(private readonly prisma: PrismaService) {}

  async findByTokenHash(tokenHash: string): Promise<StoredDebtorAccess | null> {
    const row = await this.prisma.debtorAccess.findUnique({ where: { tokenHash } });
    return row ? toAccess(row) : null;
  }

  async issue(access: NewDebtorAccess): Promise<{ replaced: number } | null> {
    return this.prisma.$transaction(async (tx) => {
      // Verrou du débiteur : deux émissions simultanées ne laissent qu'un lien actif.
      const debtor = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM debtors
        WHERE id = ${access.debtorId}::uuid AND case_id = ${access.caseId}::uuid FOR UPDATE`;
      if (debtor.length === 0) return null;
      const active = await tx.debtorAccess.findMany({
        where: { caseId: access.caseId, debtorId: access.debtorId, revokedAt: null },
        select: { id: true },
      });
      await revokeAccesses(
        tx,
        active.map((row) => row.id),
        access.link.issuedAt,
      );
      await tx.debtorAccess.create({
        data: {
          id: access.id,
          caseId: access.caseId,
          debtorId: access.debtorId,
          tokenHash: access.tokenHash,
          expiresAt: access.link.expiresAt,
          revokedAt: access.link.revokedAt,
          createdAt: access.link.issuedAt,
        },
      });
      return { replaced: active.length };
    });
  }

  async revoke(scope: { caseId: string; debtorId?: string }, at: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const active = await tx.debtorAccess.findMany({
        where: {
          caseId: scope.caseId,
          ...(scope.debtorId ? { debtorId: scope.debtorId } : {}),
          revokedAt: null,
        },
        select: { id: true },
      });
      await revokeAccesses(
        tx,
        active.map((row) => row.id),
        at,
      );
      return active.length;
    });
  }

  async updateLocked<T>(
    accessId: string,
    decide: (access: StoredDebtorAccess) => { change: DebtorAccessChange | null; result: T },
  ): Promise<T | null> {
    return this.prisma.$transaction(async (tx) => {
      // Verrou du lien jusqu'à la fin de la transaction : les envois et les essais passent un à un.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM debtor_accesses WHERE id = ${accessId}::uuid FOR UPDATE`;
      if (locked.length === 0) return null;
      const row = await tx.debtorAccess.findUniqueOrThrow({ where: { id: accessId } });
      const { change, result } = decide(toAccess(row));
      if (change) {
        const data = columnsOf(change);
        if (Object.keys(data).length > 0) await tx.debtorAccess.update({ where: { id: accessId }, data });
        if (change.session) {
          await tx.debtorSession.create({
            data: {
              id: change.session.id,
              accessId,
              tokenHash: change.session.tokenHash,
              expiresAt: change.session.expiresAt,
              createdAt: change.session.createdAt,
            },
          });
        }
      }
      return result;
    });
  }

  async findSession(tokenHash: string): Promise<StoredDebtorSession | null> {
    const row = await this.prisma.debtorSession.findUnique({
      where: { tokenHash },
      include: { access: { select: { caseId: true, debtorId: true, revokedAt: true } } },
    });
    if (!row) return null;
    return {
      id: row.id,
      accessId: row.accessId,
      caseId: row.access.caseId,
      debtorId: row.access.debtorId,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      accessRevokedAt: row.access.revokedAt,
    };
  }

  async endSession(sessionId: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.debtorSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: at },
    });
    return count === 1;
  }
}

/**
 * Lecture du dossier et du débiteur pour son accès : statut, numéro, créancier, coordonnées encore
 * valables (chiffrées, déchiffrées par le cas d'usage au moment de servir).
 */
@Injectable()
export class PrismaDebtorCaseReader implements DebtorCaseReader {
  constructor(private readonly prisma: PrismaService) {}

  async caseDebtor(caseId: string, debtorId: string): Promise<CaseDebtor | null> {
    const debtor = await this.prisma.debtor.findFirst({
      where: { id: debtorId, caseId },
      select: { case: { select: { number: true, status: true, creditorType: true, creditorId: true } } },
    });
    if (!debtor) return null;
    const recoveryCase = debtor.case;
    return {
      caseNumber: recoveryCase.number,
      caseStatus: recoveryCase.status,
      creditor: { type: recoveryCase.creditorType, id: recoveryCase.creditorId },
    };
  }

  async contacts(debtorId: string): Promise<EncryptedContact[]> {
    const rows = await this.prisma.debtorContact.findMany({
      where: { debtorId, valid: true, channel: { in: ['phone', 'email'] } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { channel: true, valueEnc: true },
    });
    return rows.map((row) => ({
      channel: row.channel as EncryptedContact['channel'],
      valueEnc: row.valueEnc,
    }));
  }
}
