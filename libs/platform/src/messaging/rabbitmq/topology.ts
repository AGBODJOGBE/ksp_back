import { type Channel } from 'amqplib';

/** Exchange unique de type topic : la clé de routage est le type de l'événement. */
export const EVENTS_EXCHANGE = 'ksp.events';

export interface ConsumerQueues {
  main: string;
  retry: string;
  dlq: string;
  /**
   * Délais croissants : une file de reprise par tentative (`<file>.retry.1`, `.retry.2`…), chacune
   * avec son propre délai. Absent : la file `.retry` unique, à délai fixe.
   */
  retryTiers?: string[];
}

/**
 * Une file par consommateur et par événement : `<consommateur>.<événement>`, plus ses files de reprise
 * (une seule, ou une par délai quand `tiers` > 0) et d'erreurs.
 */
export function consumerQueues(consumer: string, eventType: string, tiers = 0): ConsumerQueues {
  const main = `${consumer}.${eventType}`;
  const queues: ConsumerQueues = { main, retry: `${main}.retry`, dlq: `${main}.dlq` };
  if (tiers > 0)
    queues.retryTiers = Array.from({ length: tiers }, (_, index) => `${main}.retry.${index + 1}`);
  return queues;
}

/**
 * Crée (ou vérifie) la topologie d'un consommateur :
 * - file principale (quorum, répliquée), liée à l'exchange sur le type d'événement ;
 * - file(s) de reprise : le message y attend son délai, puis revient dans la file principale. Avec des
 *   délais croissants (`retryDelaysMs`), une file par délai : une file à délai fixe évite qu'un message à
 *   long délai retienne ceux qui le suivent (l'expiration n'a lieu qu'en tête de file) ;
 * - file d'erreurs (.dlq) : messages en échec définitif, à examiner (alerte si elle n'est pas vide).
 * Les arguments d'une file existante ne peuvent pas changer : passer aux délais croissants crée de
 * nouvelles files, l'ancienne `.retry` se vide seule.
 */
export async function assertConsumerTopology(
  channel: Channel,
  queues: ConsumerQueues,
  eventType: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(queues.main, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
  await channel.bindQueue(queues.main, EVENTS_EXCHANGE, eventType);
  const retryQueues = queues.retryTiers ?? [queues.retry];
  for (const [index, retryQueue] of retryQueues.entries()) {
    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': retryDelaysMs[index] ?? retryDelaysMs[retryDelaysMs.length - 1],
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queues.main,
      },
    });
  }
  await channel.assertQueue(queues.dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
}
