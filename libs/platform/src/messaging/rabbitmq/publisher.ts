import { type EventEnvelope } from '@ksp/contracts';
import { type EventPublisher } from '../ports';
import { type RabbitMqConnection } from './connection';
import { EVENTS_EXCHANGE } from './topology';

/** Publie sur l'exchange `ksp.events`, avec confirmation du broker et messages persistants. */
export class RabbitMqPublisher implements EventPublisher {
  private exchangeReady = false;

  constructor(private readonly connection: RabbitMqConnection) {}

  async publish(envelope: EventEnvelope): Promise<void> {
    const channel = await this.connection.confirmChannel();
    if (!this.exchangeReady) {
      await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
      this.exchangeReady = true;
    }
    channel.publish(EVENTS_EXCHANGE, envelope.type, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.eventId,
      correlationId: envelope.correlationId,
      type: envelope.type,
      timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
      headers: { 'x-producer': envelope.producer, 'x-event-version': envelope.version },
    });
    await channel.waitForConfirms();
  }
}
