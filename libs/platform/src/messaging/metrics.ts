import { Counter, Gauge, register } from 'prom-client';

/**
 * Métriques Prometheus de la messagerie (ADR-047), exposées par `/metrics` avec celles du service.
 * Créées une seule fois par processus (registre global de prom-client).
 */
function single<T>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

export interface OutboxStats {
  /** Événements à publier (ni publiés, ni mis de côté). */
  pending: number;
  /** Événements mis de côté, à rejouer (`pnpm outbox:replay`). */
  parked: number;
}

type Source<T> = () => Promise<T>;

const outboxSources = new Set<Source<OutboxStats>>();
const dlqSources = new Set<Source<Map<string, number>>>();

async function sum(sources: Set<Source<OutboxStats>>): Promise<OutboxStats> {
  const all = await Promise.all([...sources].map((source) => source().catch(() => null)));
  return all.reduce<OutboxStats>(
    (total, stats) => ({
      pending: total.pending + (stats?.pending ?? 0),
      parked: total.parked + (stats?.parked ?? 0),
    }),
    { pending: 0, parked: 0 },
  );
}

/** Suit l'outbox d'un service : `outbox_pending` et `outbox_parked`, lus à chaque collecte. */
export function trackOutbox(source: Source<OutboxStats>): () => void {
  single(
    'outbox_pending',
    () =>
      new Gauge({
        name: 'outbox_pending',
        help: "Événements de l'outbox en attente de publication",
        async collect() {
          this.set((await sum(outboxSources)).pending);
        },
      }),
  );
  single(
    'outbox_parked',
    () =>
      new Gauge({
        name: 'outbox_parked',
        help: "Événements de l'outbox mis de côté après des échecs (à rejouer)",
        async collect() {
          this.set((await sum(outboxSources)).parked);
        },
      }),
  );
  outboxSources.add(source);
  return () => outboxSources.delete(source);
}

/** Suit la profondeur des files d'erreurs d'un consommateur : `rabbitmq_dlq_messages{queue}`. */
export function trackDeadLetterQueues(source: Source<Map<string, number>>): () => void {
  single(
    'rabbitmq_dlq_messages',
    () =>
      new Gauge({
        name: 'rabbitmq_dlq_messages',
        help: "Messages en file d'erreurs (.dlq), par file",
        labelNames: ['queue'],
        async collect() {
          this.reset();
          for (const read of dlqSources) {
            const depths = await read().catch(() => new Map<string, number>());
            for (const [queue, count] of depths) this.set({ queue }, count);
          }
        },
      }),
  );
  dlqSources.add(source);
  return () => dlqSources.delete(source);
}

/** Échecs de publication de l'outbox (chaque tentative en échec). */
export function outboxPublishFailures(): Counter {
  return single(
    'outbox_publish_failures_total',
    () =>
      new Counter({
        name: 'outbox_publish_failures_total',
        help: "Tentatives de publication d'événements de l'outbox en échec",
      }),
  );
}

/** Messages reçus envoyés en file d'erreurs, par file et par cause. */
export function deadLetteredMessages(): Counter<'queue' | 'reason'> {
  return single(
    'messaging_dead_lettered_total',
    () =>
      new Counter({
        name: 'messaging_dead_lettered_total',
        help: "Messages reçus envoyés en file d'erreurs",
        labelNames: ['queue', 'reason'],
      }),
  );
}

/** État de la connexion RabbitMQ du service (1 : établie, 0 : coupée). */
export function rabbitMqConnectionUp(): Gauge {
  return single(
    'rabbitmq_connection_up',
    () => new Gauge({ name: 'rabbitmq_connection_up', help: 'Connexion RabbitMQ établie (1) ou non (0)' }),
  );
}
