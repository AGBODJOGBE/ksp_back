import { type EventEnvelope, type KspEventPayloads, type KspEventType } from '@ksp/contracts';
import { Logger } from '@nestjs/common';
import { type Channel, type ConsumeMessage } from 'amqplib';
import { runWithContext } from '../../context/request-context';
import { type RabbitMqConnection } from './connection';
import { assertConsumerTopology, type ConsumerQueues, consumerQueues } from './topology';

export type EventHandler<T extends KspEventType> = (
  envelope: EventEnvelope<T, KspEventPayloads[T]>,
) => Promise<void>;

export interface RabbitMqConsumerOptions {
  /** Nom du service consommateur, utilisé pour nommer ses files. */
  consumer: string;
  prefetch?: number;
  /** Nombre de nouvelles tentatives avant la file d'erreurs (5 par défaut). */
  maxRetries?: number;
  retryDelayMs?: number;
}

const ATTEMPTS_HEADER = 'x-attempts';

/**
 * Traite un message reçu. Isolé pour être testé sans broker.
 * - succès : acquittement ;
 * - échec : renvoi dans la file de reprise (avec un délai), puis dans la file d'erreurs après `maxRetries` ;
 * - message illisible : directement dans la file d'erreurs.
 * Le gestionnaire doit être idempotent (inbox) : un message peut être livré plus d'une fois.
 */
export async function handleDelivery(
  channel: Pick<Channel, 'ack' | 'sendToQueue'>,
  queues: ConsumerQueues,
  message: ConsumeMessage,
  handler: (envelope: EventEnvelope) => Promise<void>,
  maxRetries: number,
  logger: Pick<Logger, 'warn' | 'error'> = new Logger('RabbitMqConsumer'),
): Promise<'acked' | 'retried' | 'dead-lettered'> {
  const headers = message.properties.headers ?? {};
  const attempts = Number(headers[ATTEMPTS_HEADER] ?? 0);
  let envelope: EventEnvelope;
  try {
    envelope = JSON.parse(message.content.toString('utf8')) as EventEnvelope;
    if (!envelope?.eventId || !envelope?.type) throw new Error('enveloppe incomplète');
  } catch (error) {
    logger.error(`Message illisible dans ${queues.main} : ${(error as Error).message}`);
    channel.sendToQueue(queues.dlq, message.content, {
      ...message.properties,
      headers: { ...headers, 'x-failure-reason': 'invalid_envelope' },
    });
    channel.ack(message);
    return 'dead-lettered';
  }

  try {
    await runWithContext({ correlationId: envelope.correlationId, causationId: envelope.eventId }, () =>
      handler(envelope),
    );
    channel.ack(message);
    return 'acked';
  } catch (error) {
    const reason = (error as Error).message ?? String(error);
    if (attempts < maxRetries) {
      logger.warn(
        `${envelope.type} (${envelope.eventId}) en échec, tentative ${attempts + 1}/${maxRetries} : ${reason}`,
      );
      channel.sendToQueue(queues.retry, message.content, {
        ...message.properties,
        headers: { ...headers, [ATTEMPTS_HEADER]: attempts + 1, 'x-last-error': reason.slice(0, 500) },
      });
      channel.ack(message);
      return 'retried';
    }
    logger.error(
      `${envelope.type} (${envelope.eventId}) en échec définitif, envoyé en file d'erreurs : ${reason}`,
    );
    channel.sendToQueue(queues.dlq, message.content, {
      ...message.properties,
      headers: { ...headers, 'x-failure-reason': reason.slice(0, 500) },
    });
    channel.ack(message);
    return 'dead-lettered';
  }
}

/** Abonnement d'un service aux événements dont il a besoin. */
export class RabbitMqConsumer {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private readonly channels: Channel[] = [];

  constructor(
    private readonly connection: RabbitMqConnection,
    private readonly options: RabbitMqConsumerOptions,
  ) {}

  async subscribe<T extends KspEventType>(eventType: T, handler: EventHandler<T>): Promise<void> {
    const channel = await this.connection.consumerChannel(this.options.prefetch ?? 10);
    this.channels.push(channel);
    const queues = consumerQueues(this.options.consumer, eventType);
    await assertConsumerTopology(channel, queues, eventType, this.options.retryDelayMs ?? 10_000);
    await channel.consume(queues.main, (message) => {
      if (!message) return;
      void handleDelivery(
        channel,
        queues,
        message,
        handler as (envelope: EventEnvelope) => Promise<void>,
        this.options.maxRetries ?? 5,
        this.logger,
      );
    });
    this.logger.log(`Abonné à ${eventType} (file ${queues.main})`);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.channels.map((channel) => channel.close()));
  }
}
