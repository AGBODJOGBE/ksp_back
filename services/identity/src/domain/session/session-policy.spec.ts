import { sessionsToRevoke } from './session-policy';

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
