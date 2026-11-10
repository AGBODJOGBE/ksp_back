import { Logger } from '@nestjs/common';
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';
import { rabbitMqConnectionUp } from '../metrics';

/**
 * Connexion RabbitMQ partagée par le publieur et les consommateurs d'un service.
 * La connexion est rétablie automatiquement après une coupure, au prochain usage.
 */
export class RabbitMqConnection {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private connection?: Promise<ChannelModel>;
  private publishChannel?: Promise<ConfirmChannel>;
  private closedByService = false;

  constructor(private readonly url: string) {}

  /** Vrai après `close()` : les abonnements perdus ne sont plus rétablis. */
  get closed(): boolean {
    return this.closedByService;
  }

  private getConnection(): Promise<ChannelModel> {
    if (!this.connection) {
      this.connection = connect(this.url).then((connection) => {
        rabbitMqConnectionUp().set(1);
        connection.on('error', (error: Error) =>
          this.logger.error(`Connexion RabbitMQ en erreur : ${error.message}`),
        );
        connection.on('close', () => {
          rabbitMqConnectionUp().set(0);
          if (!this.closedByService)
            this.logger.warn('Connexion RabbitMQ fermée ; elle sera rétablie au prochain usage.');
          this.connection = undefined;
          this.publishChannel = undefined;
        });
        return connection;
      });
      this.connection.catch(() => {
        this.connection = undefined;
      });
    }
    return this.connection;
  }

  /** Canal avec confirmations : une publication n'est considérée faite qu'une fois confirmée par le broker. */
  confirmChannel(): Promise<ConfirmChannel> {
    if (!this.publishChannel) {
      const channel = this.getConnection().then(async (connection) => {
        const created = await connection.createConfirmChannel();
        // Canal fermé seul (erreur de canal, connexion réinitialisée) : un nouveau au prochain usage,
        // sinon toutes les publications suivantes échoueraient sur un canal mort (ADR-032).
        const forget = () => {
          if (this.publishChannel === channel) this.publishChannel = undefined;
        };
        created.on('close', forget);
        created.on('error', (error: Error) => {
          this.logger.warn(`Canal de publication RabbitMQ en erreur : ${error.message}`);
          forget();
        });
        return created;
      });
      this.publishChannel = channel;
      channel.catch(() => {
        if (this.publishChannel === channel) this.publishChannel = undefined;
      });
    }
    return this.publishChannel;
  }

  /** Nouveau canal dédié à un consommateur. */
  async consumerChannel(prefetch: number): Promise<ConfirmChannel> {
    const channel = await (await this.getConnection()).createConfirmChannel();
    await channel.prefetch(prefetch);
    return channel;
  }

  /** Utilisé par la sonde de disponibilité. */
  async ping(): Promise<void> {
    await this.getConnection();
  }

  async close(): Promise<void> {
    this.closedByService = true;
    const connection = this.connection;
    this.connection = undefined;
    this.publishChannel = undefined;
    if (connection) await (await connection).close();
  }
}
