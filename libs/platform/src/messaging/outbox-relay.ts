import { Logger } from '@nestjs/common';
import { type EventPublisher, type OutboxRecord, type OutboxStore } from './ports';

export interface OutboxRelayOptions {
  batchSize?: number;
  /** Pause entre deux passages quand l'outbox est vide. */
  idleDelayMs?: number;
  /** Pause maximale après des échecs répétés (le délai double à chaque échec). */
  maxBackoffMs?: number;
}

/**
 * Publie les événements de l'outbox sur le broker (règle d'or n° 4).
 * L'événement a été écrit dans la même transaction que la donnée métier : s'il est en base,
 * il finira publié, même si le broker était indisponible au moment de l'écriture.
 * Plusieurs instances peuvent tourner en parallèle : chaque lot est verrouillé.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions = {},
  ) {}

  /** Un passage : publie un lot, dans l'ordre, et s'arrête au premier échec pour préserver cet ordre. */
  async runOnce(): Promise<number> {
    return this.store.withUnpublishedBatch(this.options.batchSize ?? 100, async (records: OutboxRecord[]) => {
      const published: string[] = [];
      for (const record of records) {
        try {
          await this.publisher.publish(record.envelope);
          published.push(record.id);
        } catch (error) {
          this.logger.warn(
            `Publication de ${record.envelope.type} (${record.id}) en échec, nouvel essai plus tard : ${(error as Error).message}`,
          );
          break;
        }
      }
      return published;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let backoff = 0;
    while (this.running) {
      let delay = this.options.idleDelayMs ?? 500;
      try {
        const published = await this.runOnce();
        backoff = 0;
        if (published > 0) delay = 0;
      } catch (error) {
        backoff = Math.min(backoff ? backoff * 2 : 1000, this.options.maxBackoffMs ?? 30_000);
        delay = backoff;
        this.logger.error(`Relais outbox en échec : ${(error as Error).message}`);
      }
      if (delay > 0 && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
