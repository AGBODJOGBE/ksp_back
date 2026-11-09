import { ReadinessRegistry } from '@ksp/platform';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../../prisma/generated';

/** Accès à la base du service. Seule la couche infrastructure l'utilise. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly readiness: ReadinessRegistry) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.readiness.register('database', () => this.$queryRaw`SELECT 1`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
