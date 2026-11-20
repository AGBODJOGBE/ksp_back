import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';
import { ExecutionTasks } from '../../application/execution/execution-tasks';
import { PrismaService } from '../prisma/prisma.service';

/** Nom du consommateur dans l'inbox (processed_events). */
const CONSUMER = 'cleaning.wallet-credited';

/**
 * Abonnement à wallet.prepaid.credited, versions 1 et 2 (file cleaning.wallet.prepaid.credited,
 * ADR-047) : un crédit qui vise une séance la débite aussitôt (paiement direct, R-WL-05) ; toute
 * recharge relance les débits en attente du titulaire (RV-93). Une seule file par type d'événement :
 * les frais de visite (lot C) se branchent sur ce même abonnement. Un échec renvoie le message en
 * file de reprise ; le traitement est idempotent (clés de débit tirées de l'objet, inbox).
 */
@Injectable()
export class WalletEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(WalletEventsConsumer.name);
  private readonly tasks: ExecutionTasks;

  constructor(
    private readonly consumer: RabbitMqConsumer,
    private readonly prisma: PrismaService,
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
  ) {
    this.tasks = new ExecutionTasks(deps as ExecutionDeps);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe(
      'wallet.prepaid.credited',
      async (envelope) => {
        const done = await this.prisma.processedEvent.findUnique({
          where: { eventId_consumer: { eventId: envelope.eventId, consumer: CONSUMER } },
        });
        if (done) return;
        const payload = envelope.payload;
        await this.tasks.onWalletCredited({
          holder: { type: payload.holder.type, id: payload.holder.id },
          forObject: payload.forObject
            ? {
                service: payload.forObject.service,
                objectType: payload.forObject.objectType,
                objectId: payload.forObject.objectId,
              }
            : null,
          paymentId: payload.paymentId,
          amount: payload.amount.amount,
        });
        await this.prisma.processedEvent.createMany({
          data: [{ eventId: envelope.eventId, consumer: CONSUMER }],
          skipDuplicates: true,
        });
        this.logger.log(`Crédit ${payload.transactionId} traité (titulaire ${payload.holder.type})`);
      },
      { versions: [1, 2] },
    );
  }
}
