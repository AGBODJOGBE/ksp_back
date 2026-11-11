import { Logger } from '@nestjs/common';
import { outboxPublishFailures, trackOutbox } from './metrics';
import {
  type EventPublisher,
  type MessageRetention,
  type OutboxFailure,
  type OutboxRecord,
  type OutboxStore,
} from './ports';

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
  /**
   * Durée d'échecs, mesurée depuis le premier échec de l'événement, au-delà de laquelle il est mis
   * de côté (alerte, rejouable par `pnpm outbox:replay`).
   */
  parkAfterMs?: number;
  /** Délai maximal d'une publication (confirmation du broker comprise) ; au-delà, c'est un échec. */
  publishTimeoutMs?: number;
  /**
   * Durée maximale d'un passage : aucune publication n'est lancée si elle risque de le dépasser
   * (temps écoulé + `publishTimeoutMs`), et ce qui est fait est validé. À garder sous le délai de la
   * transaction du store (30 s pour `SqlOutboxStore`).
   */
  passBudgetMs?: number;
  /** Purge des messages anciens, lancée par le relais à intervalle régulier (ADR-047). */
  retention?: MessageRetention;
  /** Intervalle entre deux purges (1 h par défaut). */
  retentionIntervalMs?: number;
  /** Horloge, en millisecondes (tests). */
  now?: () => number;
}

export const OUTBOX_RETRY_DEFAULTS = {
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 5 * 60_000,
  parkAfterMs: 24 * 3_600_000,
  publishTimeoutMs: 5_000,
  passBudgetMs: 20_000,
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

/** Message d'une erreur quelconque, y compris un rejet sans valeur (undefined, null). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Longueur maximale du message d'erreur conservé dans l'outbox. */
const ERROR_MAX_LENGTH = 500;

interface PassResult {
  published: number;
  /** Deux échecs de suite : le broker est probablement indisponible, le passage s'est arrêté. */
  interrupted: boolean;
  /** Budget de temps atteint : des événements du lot restent à publier tout de suite. */
  truncated: boolean;
}

/**
 * Publie les événements de l'outbox sur le broker (règle d'or n° 4, ADR-005, ADR-032).
 * L'événement a été écrit dans la même transaction que la donnée métier : s'il est en base,
 * il finira publié, même si le broker était indisponible au moment de l'écriture.
 * Plusieurs instances peuvent tourner en parallèle : chaque lot est verrouillé.
 *
 * Un événement en échec ne bloque pas les suivants : il est réessayé plus tard, avec un délai qui
 * double à chaque échec (plafonné), puis mis de côté (alerte, rejouable) après `parkAfterMs`
 * d'échecs depuis le premier. Deux échecs de suite arrêtent le passage (broker probablement
 * indisponible) : le second n'est pas compté à son événement, et le relais attend avant de reprendre.
 * Chaque publication a un délai maximal, et un passage s'arrête avant de dépasser son budget de
 * temps : la transaction du lot n'expire jamais (sinon tout serait annulé et republié).
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private untrack?: () => void;
  private lastPurgeAt = 0;

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
    const { store } = this;
    if (store.stats) this.untrack = trackOutbox(() => store.stats!());
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.untrack?.();
    this.untrack = undefined;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async pass(): Promise<PassResult> {
    let interrupted = false;
    let truncated = false;
    const budget = this.options.passBudgetMs ?? OUTBOX_RETRY_DEFAULTS.passBudgetMs;
    const timeout = this.options.publishTimeoutMs ?? OUTBOX_RETRY_DEFAULTS.publishTimeoutMs;
    const published = await this.store.withUnpublishedBatch(
      this.options.batchSize ?? 100,
      async (records: OutboxRecord[]) => {
        const startedAt = this.now();
        const done: string[] = [];
        const failed: OutboxFailure[] = [];
        let previousFailed = false;
        for (const record of records) {
          // Une publication de plus risquerait de dépasser le budget : le reste attend le passage suivant.
          if (this.now() - startedAt + timeout > budget) {
            truncated = true;
            break;
          }
          try {
            await this.publishWithTimeout(record, timeout);
            done.push(record.id);
            previousFailed = false;
          } catch (error) {
            outboxPublishFailures().inc();
            const message = errorMessage(error).slice(0, ERROR_MAX_LENGTH);
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
    return { published, interrupted, truncated };
  }

  /**
   * Publication bornée dans le temps. Au-delà du délai, l'événement est compté en échec ; s'il
   * atteint finalement le broker, il sera publié une seconde fois (livraison « au moins une fois »,
   * les consommateurs sont idempotents).
   */
  private async publishWithTimeout(record: OutboxRecord, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const publishing = Promise.resolve().then(() => this.publisher.publish(record.envelope));
    // Un rejet survenu après le délai ne doit pas devenir un rejet non géré.
    publishing.catch(() => undefined);
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`délai de publication dépassé (${timeoutMs} ms)`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([publishing, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(record: OutboxRecord, error: string): OutboxFailure {
    const attempts = record.attempts + 1;
    const now = this.now();
    const failingForMs = record.firstFailedAt ? now - record.firstFailedAt.getTime() : 0;
    const parkAfterMs = this.options.parkAfterMs ?? OUTBOX_RETRY_DEFAULTS.parkAfterMs;
    if (failingForMs >= parkAfterMs) {
      // Alerte : l'événement ne sera plus publié sans intervention (pnpm outbox:replay).
      this.logger.error(
        `ALERTE outbox : ${record.envelope.type} (${record.id}) mis de côté après ${attempts} tentatives ` +
          `en échec depuis ${Math.round(failingForMs / 60_000)} min ; à rejouer une fois la cause corrigée ` +
          `(pnpm outbox:replay). Dernière erreur : ${error}`,
      );
      return { id: record.id, error, retryInMs: null };
    }
    const retryInMs = outboxRetryDelayMs(attempts, this.options);
    this.logger.warn(
      `Publication de ${record.envelope.type} (${record.id}) en échec (tentative ${attempts}), ` +
        `nouvel essai dans ${Math.round(retryInMs / 1000)} s : ${error}`,
    );
    return { id: record.id, error, retryInMs };
  }

  private async run(): Promise<void> {
    let backoff = 0;
    while (this.running) {
      let delay = this.options.idleDelayMs ?? 500;
      try {
        const { published, interrupted, truncated } = await this.pass();
        if (interrupted) {
          backoff = this.nextBackoff(backoff);
          delay = backoff;
        } else {
          backoff = 0;
          if (published > 0 || truncated) delay = 0;
        }
      } catch (error) {
        backoff = this.nextBackoff(backoff);
        delay = backoff;
        this.logger.error(`Relais outbox en échec : ${errorMessage(error)}`);
      }
      await this.purgeIfDue();
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

  /** Purge si l'intervalle est écoulé ; un échec est journalisé, sans arrêter le relais. */
  private async purgeIfDue(): Promise<void> {
    const { retention } = this.options;
    const now = this.now();
    if (!retention || now - this.lastPurgeAt < (this.options.retentionIntervalMs ?? 3_600_000)) return;
    this.lastPurgeAt = now;
    try {
      const purged = await retention.purge();
      if (purged > 0)
        this.logger.log(`Purge de la messagerie : ${purged} ligne(s) ancienne(s) supprimée(s).`);
    } catch (error) {
      this.logger.warn(`Purge de la messagerie en échec : ${errorMessage(error)}`);
    }
  }

  private nextBackoff(current: number): number {
    return Math.min(current ? current * 2 : 1000, this.options.maxBackoffMs ?? 30_000);
  }
}
