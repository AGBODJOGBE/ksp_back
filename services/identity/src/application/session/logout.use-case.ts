import { type Clock } from '../shared/system.ports';
import { type SessionStore } from './session-store.ports';

export type LogoutScope = 'this_device' | 'all_devices';

/**
 * UC-ID-05 : se déconnecter. « Cet appareil » révoque la session du jeton d'accès ; « tous les
 * appareils » révoque toutes les sessions. Les jetons d'accès déjà émis expirent d'eux-mêmes (15 minutes).
 * Rejouer une déconnexion ne fait rien de plus.
 */
export class LogoutUseCase {
  constructor(
    private readonly sessions: SessionStore,
    private readonly clock: Clock,
  ) {}

  async execute(input: { userId: string; sessionId: string; scope: LogoutScope }): Promise<number> {
    const now = this.clock.now();
    if (input.scope === 'all_devices') {
      return this.sessions.revokeAllSessions(input.userId, 'logout_all_devices', now);
    }
    return this.sessions.revokeSession(input.sessionId, input.userId, 'logout', now);
  }
}
