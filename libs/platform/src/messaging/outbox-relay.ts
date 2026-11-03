import { Logger } from '@nestjs/common';
import { type EventPublisher, type OutboxFailure, type OutboxRecord, type OutboxStore } from './ports';

export interface OutboxRelayOptions {
  batchSize?: number;
  /** Pause entre deux passages quand l'outbox est vide. */
  idleDelayMs?: number;
  /** Pause maximale du relais après des échecs répétés (le délai double à chaque échec). */
  maxBackoffMs?: number;
  /** Délai avant la deuxième tentative d'un événement ; il double ensuite à chaque échec. */
  retryBaseDelayMs?: number;
  /** Délai maximal entre deux tentatives d'un même événement. */
  retryMaxDelayMs?: number;
  /** Tentatives au-delà desquelles un événement est mis de côté (rejouable). */
  maxAttempts?: number;
}

export const OUTBOX_RETRY_DEFAULTS = {
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 5 * 60_000,
  maxAttempts: 25,
} as const;

/** Délai avant la tentative suivante, après `attempts` échecs (1 s, 2 s, 4 s… plafonné). */
export function outboxRetryDelayMs(
  attempts: number,
  options: Pick<OutboxRelayOptions, 'retryBaseDelayMs' | 'retryMaxDelayMs'> = {},
): number {
  const base = options.retryBaseDelayMs ?? OUTBOX_RETRY_DEFAULTS.retryBaseDelayMs;
  const max = options.retryMaxDelayMs ?? OUTBOX_RETRY_DEFAULTS.retryMaxDelayMs;
  return Math.min(max, base * 2 ** Math.min(Math.max(attempts - 1, 0), 30));
}

/** Longueur maximale du message d'erreur conservé dans l'outbox. */
const ERROR_MAX_LENGTH = 500;

interface PassResult {
  published: number;
  /** Deux échecs de suite : le broker est probablement indisponible, le passage s'est arrêté. */
  interrupted: boolean;
}

/**
 * Publie les événements de l'outbox sur le broker (règle d'or n° 4, ADR-005, ADR-032).
 * L'événement a été écrit dans la même transaction que la donnée métier : s'il est en base,
 * il finira publié, même si le broker était indisponible au moment de l'écriture.
 * Plusieurs instances peuvent tourner en parallèle : chaque lot est verrouillé.
 *
 * Un événement en échec ne bloque pas les suivants : il est réessayé plus tard, avec un délai qui
 * double à chaque échec, puis mis de côté (alerte, rejouable) au-delà de `maxAttempts`. Deux échecs
 * de suite arrêtent le passage (broker probablement indisponible) : le second n'est pas compté à
 * son événement, et le relais attend avant de reprendre.
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

  /** Un passage : publie un lot, dans l'ordre d'écriture. Renvoie le nombre d'événements publiés. */
  async runOnce(): Promise<number> {
    return (await this.pass()).published;
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

  private async pass(): Promise<PassResult> {
    let interrupted = false;
    const published = await this.store.withUnpublishedBatch(
      this.options.batchSize ?? 100,
      async (records: OutboxRecord[]) => {
        const done: string[] = [];
        const failed: OutboxFailure[] = [];
        let previousFailed = false;
        for (const record of records) {
          try {
            await this.publisher.publish(record.envelope);
            done.push(record.id);
            previousFailed = false;
          } catch (error) {
            const message = ((error as Error).message ?? String(error)).slice(0, ERROR_MAX_LENGTH);
            if (previousFailed) {
              // Deux échecs de suite : le broker est probablement indisponible. Ce second échec n'est
              // pas imputé à son événement ; le premier l'est (sinon deux événements en échec
              // bloqueraient tous les suivants).
              interrupted = true;
              this.logger.warn(
                `Publication de ${record.envelope.type} (${record.id}) en échec, broker probablement indisponible : ${message}`,
              );
              break;
            }
            previousFailed = true;
            failed.push(this.failure(record, message));
          }
        }
        return { published: done, failed };
      },
    );
    return { published, interrupted };
  }

  private failure(record: OutboxRecord, error: string): OutboxFailure {
    const attempts = record.attempts + 1;
    const maxAttempts = this.options.maxAttempts ?? OUTBOX_RETRY_DEFAULTS.maxAttempts;
    if (attempts >= maxAttempts) {
      // Alerte : l'événement ne sera plus publié sans intervention (SqlOutboxStore.replayParked).
      this.logger.error(
        `ALERTE outbox : ${record.envelope.type} (${record.id}) mis de côté après ${attempts} tentatives ; ` +
          `à rejouer une fois la cause corrigée. Dernière erreur : ${error}`,
      );
      return { id: record.id, error, retryInMs: null };
    }
    const retryInMs = outboxRetryDelayMs(attempts, this.options);
    this.logger.warn(
      `Publication de ${record.envelope.type} (${record.id}) en échec (tentative ${attempts}/${maxAttempts}), ` +
        `nouvel essai dans ${Math.round(retryInMs / 1000)} s : ${error}`,
    );
    return { id: record.id, error, retryInMs };
  }

  private async run(): Promise<void> {
    let backoff = 0;
    while (this.running) {
      let delay = this.options.idleDelayMs ?? 500;
      try {
        const { published, interrupted } = await this.pass();
        if (interrupted) {
          backoff = this.nextBackoff(backoff);
          delay = backoff;
        } else {
          backoff = 0;
          if (published > 0) delay = 0;
        }
      } catch (error) {
        backoff = this.nextBackoff(backoff);
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

  private nextBackoff(current: number): number {
    return Math.min(current ? current * 2 : 1000, this.options.maxBackoffMs ?? 30_000);
  }
}
