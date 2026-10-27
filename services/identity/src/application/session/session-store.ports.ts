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
    lastSeenAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
    /** Double authentification passée à l'ouverture (back-office), sinon null. */
    mfaAt: Date | null;
    /** Organisation active de la session (UC-ID-15) ; null pour le contexte personnel. */
    activeOrgId: string | null;
  };
  account: Account;
}

/** Une session retrouvée par son identifiant, avec son compte (changement de contexte). */
export interface StoredSession {
  id: string;
  userId: string;
  clientKind: ClientKind;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  account: Account;
}

export interface RefreshRotation {
  oldTokenId: string;
  newToken: { id: string; hash: string };
  sessionId: string;
  /** Nouvelle échéance de la session (prolongée sur le web et le mobile, inchangée au back-office). */
  sessionExpiresAt: Date;
  /** Organisation active après le renouvellement : null si elle n'est plus utilisable (ADR-027). */
  activeOrgId: string | null;
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
  findSession(sessionId: string): Promise<StoredSession | null>;
  /**
   * Change l'organisation active d'une session encore ouverte de l'utilisateur (null : contexte
   * personnel). Renvoie false si la session a été fermée entre-temps.
   */
  setActiveOrganization(sessionId: string, userId: string, organizationId: string | null): Promise<boolean>;
}
