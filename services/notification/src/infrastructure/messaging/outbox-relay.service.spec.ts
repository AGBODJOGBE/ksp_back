import { RabbitMqConnection, RabbitMqPublisher, ReadinessRegistry } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxRelayService } from './outbox-relay.service';

/** Base vide : le relais tourne sans rien publier. */
const prisma = {
  $queryRawUnsafe: async () => [],
  $executeRawUnsafe: async () => 0,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0 }),
};

describe('OutboxRelayService', () => {
  it('une panne de RabbitMQ ne rend pas le service « non prêt » (ADR-032, ADR-047)', async () => {
    const readiness = new ReadinessRegistry();
    readiness.register('database', async () => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxRelayService,
        { provide: PrismaService, useValue: prisma },
        { provide: RabbitMqPublisher, useValue: { publish: async () => undefined } },
        {
          provide: RabbitMqConnection,
          useValue: {
            ping: async () => Promise.reject(new Error('ECONNREFUSED')),
            close: async () => undefined,
          },
        },
        { provide: ReadinessRegistry, useValue: readiness },
      ],
    }).compile();
    await moduleRef.init();
    try {
      await expect(readiness.run()).resolves.toEqual({ ready: true, checks: { database: 'ok' } });
    } finally {
      await moduleRef.close();
    }
  });
});
