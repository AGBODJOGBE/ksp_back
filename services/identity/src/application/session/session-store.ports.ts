import { type ClientKind } from '../../domain/session/session-policy';
import { type Account } from './session.ports';

/** Un jeton de renouvellement retrouvé par son empreinte, avec sa session et son compte. */
export interface StoredRefreshToken {
  id: string;
  usedAt: Date | null;
  session: {
    id: string;
    clientKind: ClientKind;
    createdAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  };
  account: Account;
}

export interface RefreshRotation {
  oldTokenId: string;
  newToken: { id: string; hash: string };
  sessionId: string;
  /** Nouvelle échéance de la session (durée prolongée à chaque usage). */
  sessionExpiresAt: Date;
  now: Date;
}

export interface SessionStore {
  findRefreshToken(hash: string): Promise<StoredRefreshToken | null>;
  /**
   * Remplace le jeton : l'ancien est marqué utilisé et pointe vers le nouveau, la session est prolongée.
   * Renvoie false si l'ancien jeton a été utilisé entre-temps (réutilisation concurrente).
   */
  rotateRefreshToken(rotation: RefreshRotation): Promise<boolean>;
  /** Révoque une session de l'utilisateur ; renvoie le nombre de sessions révoquées (0 ou 1). */
  revokeSession(sessionId: string, userId: string, reason: string, now: Date): Promise<number>;
  /** Révoque toutes les sessions actives de l'utilisateur. */
  revokeAllSessions(userId: string, reason: string, now: Date): Promise<number>;
}
