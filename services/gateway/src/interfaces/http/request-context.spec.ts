import { type AuthenticatedCaller } from '../../application/access/access.ports';
import { userContextOf } from './request-context';

const caller = (permissions: AuthenticatedCaller['permissions']): AuthenticatedCaller =>
  ({
    user: {
      userId: 'u-1',
      sessionId: 's-1',
      activeContext: 'personal',
      roles: [{ role: 'cleaning_supervisor', scopeType: 'domain', scopeId: 'cleaning' }],
      mfa: true,
      authTime: 1_760_000_000,
    },
    permissions,
  }) as AuthenticatedCaller;

describe('contexte transmis aux services (ADR-057, décision 4)', () => {
  it('porte les permissions du jeton, pour que le service les revérifie', () => {
    const user = userContextOf(
      caller({ global: ['cleaning.catalog.read'], byZone: { 'porto-novo': ['cleaning.request.process'] } }),
    );
    expect(user).toMatchObject({
      userId: 'u-1',
      permissions: ['cleaning.catalog.read'],
      zonePermissions: { 'porto-novo': ['cleaning.request.process'] },
    });
  });

  it('sans permission (session des sites et applications), le contexte reste celui d’avant', () => {
    const user = userContextOf(caller({ global: [], byZone: {} }));
    expect(user).not.toHaveProperty('permissions');
    expect(user).not.toHaveProperty('zonePermissions');
  });
});
