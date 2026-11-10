import { randomUUID } from 'node:crypto';
import { type RateLimiter } from '../../application/access/access.ports';
import { InMemoryRateLimiter } from './in-memory-rate-limiter';
import { createRedisClient, RedisRateLimiter } from './redis-rate-limiter';

const rule = { limit: 2, windowSeconds: 60 };
const clock = { now: () => new Date() };

/** Compteurs partagés entre répliques : Redis réel, fourni en CI. Ignoré sans TEST_REDIS_URL. */
const redisUrl = process.env.TEST_REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describe('limites d’appels de plusieurs répliques (ADR-051)', () => {
  it('compteurs en mémoire : chaque réplique compte à part, la limite est multipliée (défaut corrigé)', async () => {
    const replicas: RateLimiter[] = [new InMemoryRateLimiter(clock), new InMemoryRateLimiter(clock)];
    const results = [];
    for (const replica of [...replicas, ...replicas]) results.push(await replica.consume('otp:ip:1', rule));
    // 4 appels pour une limite de 2 : tous acceptés, faute de compteur commun.
    expect(results.every((result) => result.allowed)).toBe(true);
  });

  it('Redis injoignable : repli sur les compteurs en mémoire, sans bloquer les requêtes', async () => {
    const redis = createRedisClient('redis://127.0.0.1:1');
    const limiter = new RedisRateLimiter(redis, new InMemoryRateLimiter(clock));
    try {
      const results = [];
      for (let i = 0; i < 3; i += 1) results.push(await limiter.consume(`k:${randomUUID()}`, rule));
      expect(results.every((result) => result.allowed)).toBe(true);
      await expect(limiter.consume('same', rule)).resolves.toMatchObject({ allowed: true });
      await limiter.consume('same', rule);
      await expect(limiter.consume('same', rule)).resolves.toMatchObject({ allowed: false });
    } finally {
      await limiter.onModuleDestroy();
    }
  });

  describeWithRedis('avec Redis', () => {
    it('deux répliques partagent le même compteur ; délai restant de la fenêtre', async () => {
      const a = new RedisRateLimiter(createRedisClient(redisUrl!), new InMemoryRateLimiter(clock));
      const b = new RedisRateLimiter(createRedisClient(redisUrl!), new InMemoryRateLimiter(clock));
      const key = `otp:ip:${randomUUID()}`;
      try {
        await expect(a.consume(key, rule)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
        await expect(b.consume(key, rule)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
        const refused = await a.consume(key, rule);
        expect(refused.allowed).toBe(false);
        expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(59);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
      } finally {
        await a.onModuleDestroy();
        await b.onModuleDestroy();
      }
    });

    it('une nouvelle fenêtre remet le compteur à zéro', async () => {
      const limiter = new RedisRateLimiter(createRedisClient(redisUrl!), new InMemoryRateLimiter(clock));
      const key = `k:${randomUUID()}`;
      const short = { limit: 1, windowSeconds: 1 };
      try {
        await limiter.consume(key, short);
        await expect(limiter.consume(key, short)).resolves.toMatchObject({ allowed: false });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await expect(limiter.consume(key, short)).resolves.toMatchObject({ allowed: true });
      } finally {
        await limiter.onModuleDestroy();
      }
    });
  });
});
