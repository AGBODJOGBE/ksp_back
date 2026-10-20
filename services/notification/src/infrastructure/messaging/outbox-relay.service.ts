import {
  OutboxRelay,
  RabbitMqConnection,
  RabbitMqPublisher,
  ReadinessRegistry,
  SqlOutboxStore,
  type TransactionalSqlClient,
} from '@ksp/platform';
import { type BeforeApplicationShutdown, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Publie en continu les événements de l'outbox du service sur RabbitMQ. */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly relay: OutboxRelay;

  constructor(
    prisma: PrismaService,
    publisher: RabbitMqPublisher,
    private readonly connection: RabbitMqConnection,
    private readonly readiness: ReadinessRegistry,
  ) {
    this.relay = new OutboxRelay(new SqlOutboxStore(prisma as unknown as TransactionalSqlClient), publisher);
  }

  onApplicationBootstrap(): void {
    this.readiness.register('rabbitmq', () => this.connection.ping());
    this.relay.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.relay.stop();
    await this.connection.close();
  }
}
