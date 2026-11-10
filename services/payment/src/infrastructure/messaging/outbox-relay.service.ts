import {
  OutboxRelay,
  RabbitMqConnection,
  RabbitMqPublisher,
  SqlMessageRetention,
  SqlOutboxStore,
  type TransactionalSqlClient,
} from '@ksp/platform';
import { type BeforeApplicationShutdown, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Publie en continu les événements de l'outbox du service sur RabbitMQ, et purge les messages
 * anciens (outbox publiée, inbox). RabbitMQ n'entre pas dans la sonde « prêt » (ADR-032, ADR-047) :
 * l'outbox garde les événements pendant une panne du broker, qui ne doit pas retirer le service du
 * trafic ; l'état de la connexion est suivi par la métrique `rabbitmq_connection_up`.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly relay: OutboxRelay;

  constructor(
    prisma: PrismaService,
    publisher: RabbitMqPublisher,
    private readonly connection: RabbitMqConnection,
  ) {
    const client = prisma as unknown as TransactionalSqlClient;
    this.relay = new OutboxRelay(new SqlOutboxStore(client), publisher, {
      retention: new SqlMessageRetention(client),
    });
  }

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.relay.stop();
    await this.connection.close();
  }
}
