import { Injectable } from '@nestjs/common';

export type ReadinessCheck = () => Promise<unknown>;

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, 'ok' | 'failed'>;
}

/**
 * Registre des vérifications « prêt à recevoir du trafic » (base de données, broker…).
 * Chaque service y inscrit ses dépendances au démarrage.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): void {
    this.checks.set(name, check);
  }

  async run(timeoutMs = 2000): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.checks.entries()].map(async ([name, check]) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            check(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            }),
          ]);
          return [name, 'ok'] as const;
        } catch {
          return [name, 'failed'] as const;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    return { ready: entries.every(([, result]) => result === 'ok'), checks };
  }
}
