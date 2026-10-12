import { Logger } from '@nestjs/common';
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';

/**
 * Connexion RabbitMQ partagée par le publieur et les consommateurs d'un service.
 * La connexion est rétablie automatiquement après une coupure, au prochain usage.
 */
export class RabbitMqConnection {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private connection?: Promise<ChannelModel>;
  private publishChannel?: Promise<ConfirmChannel>;

  constructor(private readonly url: string) {}

  private getConnection(): Promise<ChannelModel> {
    if (!this.connection) {
      this.connection = connect(this.url).then((connection) => {
        connection.on('error', (error: Error) =>
          this.logger.error(`Connexion RabbitMQ en erreur : ${error.message}`),
        );
        connection.on('close', () => {
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
      this.publishChannel = this.getConnection().then((connection) => connection.createConfirmChannel());
      this.publishChannel.catch(() => {
        this.publishChannel = undefined;
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
    const connection = this.connection;
    this.connection = undefined;
    this.publishChannel = undefined;
    if (connection) await (await connection).close();
  }
}
