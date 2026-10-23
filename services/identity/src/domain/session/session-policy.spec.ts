import {
  clientKindsOf,
  isIdleExpired,
  renewedExpiry,
  sessionCategory,
  sessionsToRevoke,
} from './session-policy';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 19, 12, minutes));

describe('sessionsToRevoke', () => {
  it('ne révoque rien sous la limite', () => {
    expect(sessionsToRevoke([{ id: 'a', lastSeenAt: at(1) }], 5)).toEqual([]);
  });

  it('révoque la session la moins récemment utilisée quand la limite est atteinte', () => {
    const active = [
      { id: 'recente', lastSeenAt: at(50) },
      { id: 'ancienne', lastSeenAt: at(1) },
      { id: 'moyenne', lastSeenAt: at(20) },
    ];
    expect(sessionsToRevoke(active, 3)).toEqual(['ancienne']);
    expect(sessionsToRevoke(active, 2)).toEqual(['ancienne', 'moyenne']);
  });
});

describe('règles des sessions par type de client', () => {
  const now = at(30);
  const customer = { refreshTtlSeconds: 30 * 24 * 3600, maxSessions: 5 };
  const backoffice = {
    refreshTtlSeconds: 12 * 3600,
    maxSessions: 2,
    slidingExpiry: false,
    idleTimeoutSeconds: 1800,
  };

  it('le back-office a sa propre limite de sessions, séparée de celle des sites et applications', () => {
    expect(sessionCategory('backoffice')).toBe('backoffice');
    expect(sessionCategory('web')).toBe('customer');
    expect(sessionCategory('mobile')).toBe('customer');
    expect(clientKindsOf('customer')).toEqual(['web', 'mobile']);
    expect(clientKindsOf('backoffice')).toEqual(['backoffice']);
  });

  it('sites et applications : durée prolongée à chaque renouvellement', () => {
    expect(renewedExpiry(at(40), now, customer)).toEqual(new Date(now.getTime() + 30 * 24 * 3600 * 1000));
  });

  it('back-office : 12 heures sans prolongation', () => {
    expect(renewedExpiry(at(40), now, backoffice)).toEqual(at(40));
  });

  it('back-office : déconnexion après 30 minutes d’inactivité ; jamais pour les clients', () => {
    expect(isIdleExpired(at(0), at(30), backoffice)).toBe(false);
    expect(isIdleExpired(at(0), at(31), backoffice)).toBe(true);
    expect(isIdleExpired(at(0), at(59), customer)).toBe(false);
  });
});
