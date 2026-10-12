import { runWithContext, type UserContext } from '../context/request-context';
import { hasRole, requireRecentMfa, requireRole, requireUser } from './user-context';

const agent: UserContext = {
  userId: 'u-1',
  sessionId: 's-1',
  activeContext: 'personal',
  roles: [{ role: 'recovery_agent', scopeType: 'domain', scopeId: 'recovery' }],
  mfa: true,
  authTime: 1_000_000,
};

describe('contrôles d’accès', () => {
  it('exige un utilisateur connecté', () => {
    runWithContext({ correlationId: 'c' }, () => {
      expect(() => requireUser()).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    });
  });

  it('vérifie le rôle et sa portée', () => {
    expect(hasRole(agent, 'recovery_agent', { type: 'domain', id: 'recovery' })).toBe(true);
    expect(hasRole(agent, 'recovery_agent', { type: 'domain', id: 'cleaning' })).toBe(false);
    runWithContext({ correlationId: 'c', user: agent }, () => {
      expect(() => requireRole('recovery_admin')).toThrow(
        expect.objectContaining({ kind: 'PERMISSION_DENIED' }),
      );
    });
  });

  it('exige une double authentification de moins de 10 minutes pour les actions sensibles', () => {
    runWithContext({ correlationId: 'c', user: agent }, () => {
      expect(requireRecentMfa(600, (1_000_000 + 300) * 1000).userId).toBe('u-1');
      expect(() => requireRecentMfa(600, (1_000_000 + 900) * 1000)).toThrow(
        expect.objectContaining({ code: 'AUTH_MFA_REQUIRED' }),
      );
    });
  });
});
