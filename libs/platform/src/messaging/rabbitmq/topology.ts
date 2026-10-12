import { type Channel } from 'amqplib';

/** Exchange unique de type topic : la clé de routage est le type de l'événement. */
export const EVENTS_EXCHANGE = 'ksp.events';

export interface ConsumerQueues {
  main: string;
  retry: string;
  dlq: string;
}

/** Une file par consommateur et par événement : `<consommateur>.<événement>`, plus ses files de reprise et d'erreurs. */
export function consumerQueues(consumer: string, eventType: string): ConsumerQueues {
  const main = `${consumer}.${eventType}`;
  return { main, retry: `${main}.retry`, dlq: `${main}.dlq` };
}

/**
 * Crée (ou vérifie) la topologie d'un consommateur :
 * - file principale (quorum, répliquée), liée à l'exchange sur le type d'événement ;
 * - file de reprise : le message y attend `retryDelayMs`, puis revient dans la file principale ;
 * - file d'erreurs (.dlq) : messages en échec définitif, à examiner (alerte si elle n'est pas vide).
 */
export async function assertConsumerTopology(
  channel: Channel,
  queues: ConsumerQueues,
  eventType: string,
  retryDelayMs: number,
): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(queues.main, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await channel.bindQueue(queues.main, EVENTS_EXCHANGE, eventType);
  await channel.assertQueue(queues.retry, {
    durable: true,
    arguments: {
      'x-message-ttl': retryDelayMs,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': queues.main,
    },
  });
  await channel.assertQueue(queues.dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
}
