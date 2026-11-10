import { type Channel } from 'amqplib';

/** Exchange unique de type topic : la clé de routage est le type de l'événement. */
export const EVENTS_EXCHANGE = 'ksp.events';

/**
 * Délais croissants de nouvel essai d'un événement reçu en échec (ADR-047) : 10 s, 30 s, 1 min, 2 min,
 * 5 min, 10 min, 15 min, 30 min, soit environ 1 h 04 avant la file d'erreurs.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
];

export interface ConsumerQueues {
  main: string;
  /** Files de reprise, une par tentative, dans l'ordre des délais. */
  retry: string[];
  dlq: string;
}

/** Suffixe lisible d'un délai : 10s, 2m, 1h (ms si le délai n'est pas un nombre entier de secondes). */
export function delayLabel(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Une file par consommateur et par événement : `<consommateur>.<événement>`, ses files de reprise
 * `<file>.retry.<délai>` (une par délai) et sa file d'erreurs `<file>.dlq`.
 * Le délai fait partie du nom d'une file de reprise : changer les délais crée d'autres files, au lieu
 * d'en redéclarer une avec d'autres arguments (refusé par RabbitMQ, PRECONDITION_FAILED).
 */
export function consumerQueues(
  consumer: string,
  eventType: string,
  retryDelaysMs: readonly number[] = [],
): ConsumerQueues {
  const main = `${consumer}.${eventType}`;
  return {
    main,
    retry: retryDelaysMs.map((ms) => `${main}.retry.${delayLabel(ms)}`),
    dlq: `${main}.dlq`,
  };
}

/**
 * Crée (ou vérifie) la topologie d'un consommateur ; toutes ses files sont des files quorum,
 * répliquées (ADR-017) :
 * - file principale, liée à l'exchange sur le type d'événement ;
 * - une file de reprise par délai : le message y attend son délai, puis revient dans la file principale
 *   (remise « au moins une fois » : `at-least-once`, qui impose `reject-publish`). Une file par délai,
 *   car l'expiration n'a lieu qu'en tête de file : un message à long délai retiendrait les suivants ;
 * - file d'erreurs (.dlq) : messages en échec définitif, à examiner puis rejouer (`pnpm dlq:replay`).
 */
export async function assertConsumerTopology(
  channel: Pick<Channel, 'assertExchange' | 'assertQueue' | 'bindQueue'>,
  queues: ConsumerQueues,
  eventType: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(queues.main, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await channel.bindQueue(queues.main, EVENTS_EXCHANGE, eventType);
  for (const [index, retryQueue] of queues.retry.entries()) {
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': retryDelaysMs[index],
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queues.main,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
    });
  }
  await channel.assertQueue(queues.dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
}
