import { type EventEnvelope, type KspEventPayloads, type KspEventType } from '@ksp/contracts';
import { Logger } from '@nestjs/common';
import { type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib';
import { runWithContext } from '../../context/request-context';
import { eventOwner, isDeclaredSubscription } from '../consumed-events';
import { deadLetteredMessages, trackDeadLetterQueues } from '../metrics';
import { errorMessage } from '../outbox-relay';
import { type RabbitMqConnection } from './connection';
import {
  assertConsumerTopology,
  type ConsumerQueues,
  consumerQueues,
  DEFAULT_RETRY_DELAYS_MS,
} from './topology';

export type EventHandler<T extends KspEventType> = (
  envelope: EventEnvelope<T, KspEventPayloads[T]>,
) => Promise<void>;

export interface RabbitMqConsumerOptions {
  /** Nom du service consommateur, utilisé pour nommer ses files. */
  consumer: string;
  prefetch?: number;
  /**
   * Délais croissants entre les tentatives (une file de reprise par délai) : une tentative par délai,
   * puis la file d'erreurs. Par défaut DEFAULT_RETRY_DELAYS_MS (10 s à 30 min, ADR-047).
   */
  retryDelaysMs?: readonly number[];
  /**
   * Remises d'un même message sans acquittement (le consommateur est tombé en le traitant) au-delà
   * desquelles il part en file d'erreurs sans être traité. Sous la limite de RabbitMQ (20 remises
   * par défaut pour une file quorum), au-delà de laquelle le message serait supprimé.
   */
  maxRedeliveries?: number;
  /** Délai avant de rétablir un abonnement perdu ; il double à chaque échec, jusqu'à 30 s. */
  resubscribeDelayMs?: number;
}

export interface SubscribeOptions {
  /** Versions de l'enveloppe comprises par le gestionnaire (1 par défaut). */
  versions?: readonly number[];
}

export interface DeliveryOptions {
  /** Versions de l'enveloppe comprises par le gestionnaire. */
  versions: readonly number[];
  maxRedeliveries: number;
}

export type DeliveryOutcome = 'acked' | 'retried' | 'dead-lettered' | 'requeued';

export type DeliveryChannel = Pick<ConfirmChannel, 'ack' | 'nack' | 'sendToQueue'>;

const ATTEMPTS_HEADER = 'x-attempts';
/** Remises comptées par RabbitMQ pour une file quorum. */
const DELIVERY_COUNT_HEADER = 'x-delivery-count';
const DEFAULT_MAX_REDELIVERIES = 10;
const RESUBSCRIBE_MAX_DELAY_MS = 30_000;

/** Copie confirmée par le broker : le message d'origine n'est acquitté qu'ensuite. */
function sendConfirmed(
  channel: DeliveryChannel,
  queue: string,
  content: Buffer,
  options: Options.Publish,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(queue, content, options, (error: unknown) =>
      error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(),
    );
  });
}

/**
 * Traite un message reçu. Isolé pour être testé sans broker.
 * - succès : acquittement ;
 * - échec : copie dans la file de reprise de la tentative (avec son délai), puis dans la file
 *   d'erreurs après la dernière ;
 * - message illisible, émetteur qui n'est pas le propriétaire du type, version inconnue, ou message
 *   remis trop de fois sans acquittement : directement dans la file d'erreurs, sans le traiter.
 * Une copie n'est acquittée qu'après sa confirmation par le broker ; si elle échoue, le message est
 * rendu à sa file (remis plus tard). Le gestionnaire doit être idempotent (inbox) : un message peut
 * être livré plus d'une fois.
 */
export async function handleDelivery(
  channel: DeliveryChannel,
  queues: ConsumerQueues,
  message: ConsumeMessage,
  handler: (envelope: EventEnvelope) => Promise<void>,
  options: DeliveryOptions,
  logger: Pick<Logger, 'warn' | 'error'> = new Logger('RabbitMqConsumer'),
): Promise<DeliveryOutcome> {
  const headers = message.properties.headers ?? {};
  const attempts = Number(headers[ATTEMPTS_HEADER] ?? 0);

  const copy = async (queue: string, extra: Record<string, unknown>): Promise<boolean> => {
    // Le compteur de remises appartient à la file d'origine : une copie repart de zéro.
    const kept: Record<string, unknown> = { ...headers, ...extra };
    delete kept[DELIVERY_COUNT_HEADER];
    try {
      await sendConfirmed(channel, queue, message.content, { ...message.properties, headers: kept });
      channel.ack(message);
      return true;
    } catch (error) {
      logger.warn(
        `Copie vers ${queue} non confirmée, message rendu à ${queues.main} : ${errorMessage(error)}`,
      );
      try {
        channel.nack(message, false, true);
      } catch {
        // Canal fermé : le broker rend lui-même le message non acquitté.
      }
      return false;
    }
  };
  const deadLetter = async (reason: string, label: string): Promise<DeliveryOutcome> => {
    if (!(await copy(queues.dlq, { 'x-failure-reason': reason.slice(0, 500) }))) return 'requeued';
    deadLetteredMessages().inc({ queue: queues.main, reason: label });
    return 'dead-lettered';
  };

  let envelope: EventEnvelope;
  try {
    envelope = JSON.parse(message.content.toString('utf8')) as EventEnvelope;
    if (!envelope?.eventId || !envelope?.type) throw new Error('enveloppe incomplète');
  } catch (error) {
    logger.error(`Message illisible dans ${queues.main} : ${errorMessage(error)}`);
    return deadLetter('invalid_envelope', 'invalid_envelope');
  }
  const event = `${envelope.type} (${envelope.eventId})`;

  if (Number(headers[DELIVERY_COUNT_HEADER] ?? 0) >= options.maxRedeliveries) {
    logger.error(
      `ALERTE messagerie : ${event} remis ${String(headers[DELIVERY_COUNT_HEADER])} fois sans ` +
        `acquittement dans ${queues.main} (le consommateur tombe en le traitant) ; envoyé en file d'erreurs`,
    );
    return deadLetter('redelivery_limit', 'redelivery_limit');
  }
  if (envelope.producer !== eventOwner(envelope.type)) {
    logger.error(
      `ALERTE messagerie : ${event} publié par « ${String(envelope.producer)} » au lieu de ` +
        `« ${eventOwner(envelope.type)} » ; refusé, envoyé en file d'erreurs`,
    );
    return deadLetter('unexpected_producer', 'unexpected_producer');
  }
  if (!options.versions.includes(envelope.version)) {
    logger.error(
      `ALERTE messagerie : ${event} en version ${String(envelope.version)}, non comprise par ` +
        `${queues.main} (versions ${options.versions.join(', ')}) ; envoyé en file d'erreurs`,
    );
    return deadLetter('unsupported_version', 'unsupported_version');
  }

  try {
    await runWithContext({ correlationId: envelope.correlationId, causationId: envelope.eventId }, () =>
      handler(envelope),
    );
    channel.ack(message);
    return 'acked';
  } catch (error) {
    // Un rejet sans valeur (undefined, null) ne doit pas faire échouer le traitement de l'échec.
    const reason = errorMessage(error);
    const retryQueue = queues.retry[attempts];
    if (retryQueue) {
      logger.warn(`${event} en échec, tentative ${attempts + 1}/${queues.retry.length} : ${reason}`);
      const copied = await copy(retryQueue, {
        [ATTEMPTS_HEADER]: attempts + 1,
        'x-last-error': reason.slice(0, 500),
      });
      return copied ? 'retried' : 'requeued';
    }
    logger.error(`${event} en échec définitif, envoyé en file d'erreurs : ${reason}`);
    return deadLetter(reason, 'retries_exhausted');
  }
}

interface Subscription {
  eventType: KspEventType;
  handler: (envelope: EventEnvelope) => Promise<void>;
  queues: ConsumerQueues;
  versions: readonly number[];
  channel?: ConfirmChannel;
  timer?: NodeJS.Timeout;
}

/**
 * Abonnement d'un service aux événements dont il a besoin. Un abonnement perdu (canal fermé par le
 * broker, connexion coupée, consommateur annulé) est rétabli, avec un délai croissant, tant que le
 * consommateur et la connexion ne sont pas fermés par le service.
 */
export class RabbitMqConsumer {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private readonly subscriptions: Subscription[] = [];
  private readonly retryDelaysMs: readonly number[];
  private closed = false;
  private untrack?: () => void;

  constructor(
    private readonly connection: RabbitMqConnection,
    private readonly options: RabbitMqConsumerOptions,
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async subscribe<T extends KspEventType>(
    eventType: T,
    handler: EventHandler<T>,
    options: SubscribeOptions = {},
  ): Promise<void> {
    if (!isDeclaredSubscription(this.options.consumer, eventType)) {
      this.logger.error(
        `ALERTE messagerie : abonnement de ${this.options.consumer} à ${eventType} absent de ` +
          "EVENT_CONSUMERS (libs/platform) : publié avant le démarrage de ce consommateur, l'événement serait perdu",
      );
    }
    const subscription: Subscription = {
      eventType,
      handler: handler as (envelope: EventEnvelope) => Promise<void>,
      queues: consumerQueues(this.options.consumer, eventType, this.retryDelaysMs),
      versions: options.versions ?? [1],
    };
    await this.open(subscription);
    this.subscriptions.push(subscription);
    this.untrack ??= trackDeadLetterQueues(() => this.deadLetterDepths());
    this.logger.log(`Abonné à ${eventType} (file ${subscription.queues.main})`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.untrack?.();
    for (const subscription of this.subscriptions) clearTimeout(subscription.timer);
    await Promise.allSettled(this.subscriptions.map((subscription) => subscription.channel?.close()));
  }

  /** Ouvre un canal, déclare la topologie et consomme ; échoue sans rien laisser derrière. */
  private async open(subscription: Subscription): Promise<void> {
    const channel = await this.connection.consumerChannel(this.options.prefetch ?? 10);
    channel.on('error', (error: Error) =>
      this.logger.warn(`Canal de ${subscription.queues.main} en erreur : ${error.message}`),
    );
    channel.once('close', () => this.lost(subscription, channel));
    try {
      await assertConsumerTopology(channel, subscription.queues, subscription.eventType, this.retryDelaysMs);
      const delivery: DeliveryOptions = {
        versions: subscription.versions,
        maxRedeliveries: this.options.maxRedeliveries ?? DEFAULT_MAX_REDELIVERIES,
      };
      await channel.consume(subscription.queues.main, (message) => {
        // Consommateur annulé par le broker (file supprimée) : le canal est refait, la file redéclarée.
        if (!message) {
          void channel.close().catch(() => undefined);
          return;
        }
        handleDelivery(
          channel,
          subscription.queues,
          message,
          subscription.handler,
          delivery,
          this.logger,
        ).catch((error: unknown) =>
          this.logger.error(
            `Traitement d'un message de ${subscription.queues.main} : ${errorMessage(error)}`,
          ),
        );
      });
      subscription.channel = channel;
    } catch (error) {
      await channel.close().catch(() => undefined);
      throw error;
    }
  }

  private lost(subscription: Subscription, channel: ConfirmChannel): void {
    if (subscription.channel !== channel) return;
    subscription.channel = undefined;
    if (this.closed || this.connection.closed) return;
    this.logger.warn(`Abonnement à ${subscription.eventType} perdu ; il va être rétabli.`);
    this.reopen(subscription, this.options.resubscribeDelayMs ?? 1_000);
  }

  private reopen(subscription: Subscription, delayMs: number): void {
    subscription.timer = setTimeout(() => {
      if (this.closed || this.connection.closed) return;
      this.open(subscription).then(
        () => this.logger.log(`Abonnement à ${subscription.eventType} rétabli.`),
        (error: unknown) => {
          this.logger.warn(
            `Abonnement à ${subscription.eventType} non rétabli : ${errorMessage(error)} ; nouvel essai.`,
          );
          this.reopen(subscription, Math.min(delayMs * 2, RESUBSCRIBE_MAX_DELAY_MS));
        },
      );
    }, delayMs);
    subscription.timer.unref();
  }

  /** Profondeur des files d'erreurs des abonnements actifs (métrique rabbitmq_dlq_messages). */
  private async deadLetterDepths(): Promise<Map<string, number>> {
    const depths = new Map<string, number>();
    for (const { channel, queues } of this.subscriptions) {
      if (!channel) continue;
      const { messageCount } = await channel.checkQueue(queues.dlq);
      depths.set(queues.dlq, messageCount);
    }
    return depths;
  }
}
