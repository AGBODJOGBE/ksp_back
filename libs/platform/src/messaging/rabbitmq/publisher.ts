import { type EventEnvelope } from '@ksp/contracts';
import { type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { CONSUMED_EVENT_TYPES } from '../consumed-events';
import { type EventPublisher } from '../ports';
import { type RabbitMqConnection } from './connection';
import { EVENTS_EXCHANGE } from './topology';

export interface RabbitMqPublisherOptions {
  /** Exchange de publication (`ksp.events` ; autre valeur pour les tests). */
  exchange?: string;
  /** Types attendus par au moins un consommateur : non routés, ils sont en échec (EVENT_CONSUMERS). */
  consumedEventTypes?: ReadonlySet<string>;
}

/**
 * Publie sur l'exchange `ksp.events`, avec confirmation du broker et messages persistants.
 * Publication « mandatory » : un événement attendu par un consommateur que le broker n'a pu remettre
 * à aucune file (consommateur pas encore démarré, file pas encore déclarée) est un échec ; l'outbox
 * le garde et réessaie (ADR-047). L'exchange est déclaré sur chaque nouveau canal (reconnexion).
 */
export class RabbitMqPublisher implements EventPublisher {
  private readonly exchange: string;
  private readonly consumedEventTypes: ReadonlySet<string>;
  /** Canal sur lequel l'exchange est déclaré et les retours sont écoutés. */
  private readyChannel?: ConfirmChannel;
  /** Identifiants des événements renvoyés par le broker (non routés). */
  private readonly returned = new Set<string>();

  constructor(
    private readonly connection: RabbitMqConnection,
    options: RabbitMqPublisherOptions = {},
  ) {
    this.exchange = options.exchange ?? EVENTS_EXCHANGE;
    this.consumedEventTypes = options.consumedEventTypes ?? CONSUMED_EVENT_TYPES;
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const channel = await this.connection.confirmChannel();
    if (this.readyChannel !== channel) {
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      this.returned.clear();
      channel.on('return', (message: ConsumeMessage) => {
        const id: unknown = message.properties.messageId;
        if (typeof id === 'string') this.returned.add(id);
      });
      this.readyChannel = channel;
    }
    channel.publish(this.exchange, envelope.type, Buffer.from(JSON.stringify(envelope)), {
      mandatory: true,
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.eventId,
      correlationId: envelope.correlationId,
      type: envelope.type,
      timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
      headers: { 'x-producer': envelope.producer, 'x-event-version': envelope.version },
    });
    await channel.waitForConfirms();
    // Le broker renvoie un message non routé avant de le confirmer.
    if (this.returned.delete(envelope.eventId) && this.consumedEventTypes.has(envelope.type)) {
      throw new Error(
        `${envelope.type} non routé : aucune file liée (consommateur pas encore démarré ?), nouvel essai`,
      );
    }
  }
}
