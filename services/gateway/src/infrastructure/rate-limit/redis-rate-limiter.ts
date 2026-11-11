import { createClient } from '@redis/client';
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { type RateLimiter, type RateLimitResult } from '../../application/access/access.ports';

/**
 * Fenêtre fixe atomique : incrémente le compteur, fixe sa durée au premier appel, rend le compte
 * et le temps restant (millisecondes). Une clé sans durée (cas anormal) en reçoit une.
 */
const CONSUME = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const PREFIX = 'ksp:gateway:rate-limit:';

/** Ce que la limite utilise du client Redis. */
export interface RedisScripting {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy(): void;
}

/**
 * Client Redis des limites : jamais de file d'attente hors connexion ni d'attente longue. Une
 * commande échoue tout de suite si Redis est injoignable (la limite se replie alors sur la
 * mémoire) ; le client se reconnecte seul.
 */
export function createRedisClient(url: string): RedisScripting {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: 250 },
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries: number) => Math.min(500 * 2 ** retries, 30_000),
    },
  });
  // Échec de la première connexion : signalé par l'événement « error », nouvel essai automatique.
  client.connect().catch(() => undefined);
  return client as unknown as RedisScripting;
}

/**
 * Compteurs partagés par toutes les répliques de la gateway (ADR-051), dans Redis. Si Redis ne
 * répond pas, chaque réplique compte en mémoire le temps de la panne : les limites restent
 * appliquées (par réplique) plutôt que de bloquer ou d'ouvrir toutes les routes.
 */
export class RedisRateLimiter implements RateLimiter, OnModuleDestroy {
  private readonly logger = new Logger(RedisRateLimiter.name);
  private lastWarning = 0;

  constructor(
    private readonly redis: RedisScripting,
    private readonly fallback: RateLimiter,
  ) {
    // Sans écouteur, chaque échec de connexion serait une erreur non gérée.
    redis.on('error', (error: Error) => this.warn(`Redis injoignable : ${error.message}`));
  }

  async consume(key: string, rule: { limit: number; windowSeconds: number }): Promise<RateLimitResult> {
    try {
      const [count, ttlMs] = (await this.redis.eval(CONSUME, {
        keys: [`${PREFIX}${key}`],
        arguments: [String(rule.windowSeconds * 1000)],
      })) as [number, number];
      if (count <= rule.limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
    } catch (error) {
      this.warn(`Limites en mémoire le temps de la panne de Redis : ${(error as Error).message}`);
      return this.fallback.consume(key, rule);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.destroy();
  }

  /** Un avertissement par minute au plus : une panne de Redis ne noie pas les journaux. */
  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarning < 60_000) return;
    this.lastWarning = now;
    this.logger.warn(message);
  }
}
