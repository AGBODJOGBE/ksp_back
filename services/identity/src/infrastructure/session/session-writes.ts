import { type LoginMethod } from '../../application/session/session.ports';
import {
  type ClientKind,
  clientKindsOf,
  sessionCategory,
  sessionsToRevoke,
} from '../../domain/session/session-policy';
import { type Prisma } from '../../../prisma/generated';

/** Écritures communes à l'ouverture d'une session, faites dans la transaction de l'appelant. */
export interface SessionToOpen {
  userId: string;
  session: {
    id: string;
    clientKind: ClientKind;
    deviceLabel: string | null;
    userAgent: string | null;
    ip: string | null;
    expiresAt: Date;
  };
  refreshToken: { id: string; hash: string };
  loginEventId: string;
  method: LoginMethod;
  maxSessions: number;
  /** Double authentification passée à l'ouverture (back-office), sinon null. */
  mfaAt: Date | null;
  now: Date;
}

/**
 * Révoque les sessions de la même catégorie au-delà de la limite (sites et applications d'un côté,
 * back-office de l'autre), ouvre la session avec son jeton et enregistre la connexion.
 */
export async function openSession(tx: Prisma.TransactionClient, input: SessionToOpen): Promise<void> {
  const active = await tx.session.findMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      expiresAt: { gt: input.now },
      clientKind: { in: clientKindsOf(sessionCategory(input.session.clientKind)) },
    },
    select: { id: true, lastSeenAt: true },
  });
  const toRevoke = sessionsToRevoke(active, input.maxSessions);
  if (toRevoke.length > 0) {
    await tx.session.updateMany({
      where: { id: { in: toRevoke } },
      data: { revokedAt: input.now, revokeReason: 'session_limit' },
    });
  }

  await tx.session.create({
    data: {
      id: input.session.id,
      userId: input.userId,
      clientKind: input.session.clientKind,
      deviceLabel: input.session.deviceLabel,
      userAgent: input.session.userAgent,
      ip: input.session.ip,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.session.expiresAt,
      mfaAt: input.mfaAt,
      refreshTokens: {
        create: { id: input.refreshToken.id, tokenHash: input.refreshToken.hash, issuedAt: input.now },
      },
    },
  });
  await tx.loginEvent.create({
    data: {
      id: input.loginEventId,
      userId: input.userId,
      method: input.method,
      success: true,
      ip: input.session.ip,
      userAgent: input.session.userAgent,
      createdAt: input.now,
    },
  });
}
