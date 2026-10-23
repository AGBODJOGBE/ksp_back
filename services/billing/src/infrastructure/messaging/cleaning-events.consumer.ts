import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { BILLING_USE_CASES, type BillingUseCases } from '../../application/use-cases';

/**
 * Contrats appris par événements (une base par service : billing ne lit jamais celle de
 * cleaning) : mission d'entreprise confirmée, annulée, suspendue, reprise. Files
 * billing.<événement> ; traitement idempotent (inbox).
 */
@Injectable()
export class CleaningEventsConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(BILLING_USE_CASES) private readonly useCases: BillingUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('cleaning.booking.confirmed', async (envelope) => {
      await this.useCases.registerContract.execute(envelope);
    });
    await this.consumer.subscribe('cleaning.request.cancelled', async (envelope) => {
      await this.useCases.terminateContract.execute(envelope);
    });
    await this.consumer.subscribe('cleaning.contract.suspended', async (envelope) => {
      await this.useCases.suspendContract.execute(envelope);
    });
    await this.consumer.subscribe('cleaning.contract.resumed', async (envelope) => {
      await this.useCases.resumeContract.execute(envelope);
    });
  }
}
