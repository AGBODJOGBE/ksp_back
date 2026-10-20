import { InMemoryRateLimiter } from './in-memory-rate-limiter';

function setup(sweepEvery?: number) {
  let now = new Date('2026-10-20T10:00:00Z').getTime();
  const limiter = new InMemoryRateLimiter({ now: () => new Date(now) }, sweepEvery);
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const rule = { limit: 5, windowSeconds: 60 };

describe('InMemoryRateLimiter', () => {
  it('accepte jusqu’à la limite, puis refuse avec le délai restant', async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i += 1) {
      await expect(limiter.consume('k', rule)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    advance(15_500);
    await expect(limiter.consume('k', rule)).resolves.toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it('une nouvelle fenêtre remet le compteur à zéro', async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 6; i += 1) await limiter.consume('k', rule);
    advance(60_000);
    await expect(limiter.consume('k', rule)).resolves.toMatchObject({ allowed: true });
  });

  it('le délai annoncé vaut au moins une seconde', async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.consume('k', rule);
    advance(59_999);
    await expect(limiter.consume('k', rule)).resolves.toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('chaque clé a son compteur', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.consume('a', rule);
    await expect(limiter.consume('b', rule)).resolves.toMatchObject({ allowed: true });
  });

  it('les fenêtres expirées sont nettoyées', async () => {
    const { limiter, advance } = setup(3);
    await limiter.consume('a', rule);
    await limiter.consume('b', rule);
    advance(61_000);
    await limiter.consume('c', rule);
    expect(limiter.size).toBe(1);
  });
});
