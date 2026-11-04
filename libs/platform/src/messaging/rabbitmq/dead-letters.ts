import { type ConfirmChannel } from 'amqplib';
import { type ConsumerQueues } from './topology';

/** En-têtes du parcours d'échec, retirés au rejeu : le message repart comme neuf. */
const FAILURE_HEADERS = ['x-attempts', 'x-last-error', 'x-failure-reason'] as const;

export type DeadLetterChannel = Pick<
  ConfirmChannel,
  'checkQueue' | 'get' | 'sendToQueue' | 'waitForConfirms' | 'ack'
>;

/**
 * Remet dans la file principale les messages de la file d'erreurs (.dlq) d'un consommateur, une fois
 * la cause corrigée (ADR-032). Seuls les messages présents au départ sont repris : un message qui
 * échoue encore et revient en file d'erreurs n'est pas rejoué en boucle. Chaque message n'est retiré
 * de la file d'erreurs qu'après la confirmation de sa republication par le broker.
 * Le gestionnaire étant idempotent (inbox), un message rejoué deux fois est sans effet.
 */
export async function replayDeadLetters(channel: DeadLetterChannel, queues: ConsumerQueues): Promise<number> {
  const { messageCount } = await channel.checkQueue(queues.dlq);
  let replayed = 0;
  for (let index = 0; index < messageCount; index += 1) {
    const message = await channel.get(queues.dlq, { noAck: false });
    if (!message) break;
    const headers: Record<string, unknown> = { ...(message.properties.headers ?? {}) };
    for (const header of FAILURE_HEADERS) delete headers[header];
    headers['x-replayed-at'] = new Date().toISOString();
    channel.sendToQueue(queues.main, message.content, { ...message.properties, headers });
    await channel.waitForConfirms();
    channel.ack(message);
    replayed += 1;
  }
  return replayed;
}
