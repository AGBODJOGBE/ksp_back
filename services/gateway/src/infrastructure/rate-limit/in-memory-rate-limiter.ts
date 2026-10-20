import { type Clock, type RateLimiter, type RateLimitResult } from '../../application/access/access.ports';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Compteurs à fenêtre fixe, en mémoire. Valable pour une seule instance de la gateway :
 * avec plusieurs répliques, chacune aurait ses propres compteurs (limite multipliée d'autant).
 * Le stockage partagé (Redis, INCR + EXPIRE) remplacera cet adaptateur derrière le même port.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();
  private calls = 0;

  constructor(
    private readonly clock: Clock,
    /** Nombre d'appels entre deux nettoyages des fenêtres expirées. */
    private readonly sweepEvery = 1000,
  ) {}

  async consume(key: string, rule: { limit: number; windowSeconds: number }): Promise<RateLimitResult> {
    const now = this.clock.now().getTime();
    this.sweep(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + rule.windowSeconds * 1000 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= rule.limit) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
  }

  /** Nombre de compteurs gardés (surveillance de la mémoire, tests). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    this.calls += 1;
    if (this.calls % this.sweepEvery !== 0) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
