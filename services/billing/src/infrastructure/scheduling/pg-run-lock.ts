import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Verrou consultatif PostgreSQL d'une tâche planifiée (lot F) : une seule réplique fait le passage,
 * les autres le sautent. Verrou de transaction (`pg_try_advisory_xact_lock`) : il est rendu à la fin
 * du passage, ou si la connexion tombe (réplique arrêtée). La transaction qui le porte n'écrit rien ;
 * les écritures du passage ont leurs propres transactions, idempotentes.
 */
@Injectable()
export class PgRunLock {
  constructor(private readonly prisma: PrismaService) {}

  async tryRun<T>(
    name: string,
    run: () => Promise<T>,
    maxDurationMs: number,
  ): Promise<{ ran: true; result: T } | { ran: false }> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
          'SELECT pg_try_advisory_xact_lock(hashtext($1::text)) AS locked',
          name,
        );
        if (!row?.locked) return { ran: false as const };
        return { ran: true as const, result: await run() };
      },
      { timeout: maxDurationMs, maxWait: 10_000 },
    );
  }
}
