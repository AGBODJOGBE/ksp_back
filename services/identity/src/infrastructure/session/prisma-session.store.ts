import { Injectable } from '@nestjs/common';
import {
  type RefreshRotation,
  type SessionStore,
  type StoredRefreshToken,
} from '../../application/session/session-store.ports';
import { PrismaService } from '../prisma/prisma.service';
import { ACCOUNT_SELECT, toAccount } from './prisma-login.repository';

/** Jetons de renouvellement et révocation des sessions, en base identity. */
@Injectable()
export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async findRefreshToken(hash: string): Promise<StoredRefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      select: {
        id: true,
        usedAt: true,
        session: {
          select: {
            id: true,
            clientKind: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            user: { select: ACCOUNT_SELECT },
          },
        },
      },
    });
    if (!row) return null;
    const { user, ...session } = row.session;
    return { id: row.id, usedAt: row.usedAt, session, account: toAccount(user) };
  }

  async rotateRefreshToken(rotation: RefreshRotation): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Marquage atomique : de deux renouvellements simultanés avec le même jeton, un seul passe.
      const used = await tx.refreshToken.updateMany({
        where: { id: rotation.oldTokenId, usedAt: null },
        data: { usedAt: rotation.now, replacedById: rotation.newToken.id },
      });
      if (used.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          id: rotation.newToken.id,
          sessionId: rotation.sessionId,
          tokenHash: rotation.newToken.hash,
          issuedAt: rotation.now,
        },
      });
      await tx.session.update({
        where: { id: rotation.sessionId },
        data: { lastSeenAt: rotation.now, expiresAt: rotation.sessionExpiresAt },
      });
      return true;
    });
  }

  async revokeSession(sessionId: string, userId: string, reason: string, now: Date): Promise<number> {
    const revoked = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
    });
    return revoked.count;
  }

  async revokeAllSessions(userId: string, reason: string, now: Date): Promise<number> {
    const revoked = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
    });
    return revoked.count;
  }
}
