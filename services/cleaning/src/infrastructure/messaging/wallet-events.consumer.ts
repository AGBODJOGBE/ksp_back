import { type EventHandler } from '@ksp/platform';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';
import { ExecutionTasks } from '../../application/execution/execution-tasks';
import { PrismaService } from '../prisma/prisma.service';

/** Nom du consommateur dans l'inbox (processed_events). */
const CONSUMER = 'cleaning.wallet-credited';

/**
 * Crédit du wallet côté séances (lot E), versions 1 et 2 de wallet.prepaid.credited : un crédit qui
 * vise une séance la débite aussitôt (paiement direct, R-WL-05) ; toute recharge relance les débits
 * en attente du titulaire (RV-93). Appelé par MoneyEventsConsumer, seul abonné de ce type
 * d'événement dans le service (une seule file par type, ADR-047) : deux abonnés se partageraient
 * les messages. Un échec renvoie le message en file de reprise ; le traitement est idempotent
 * (clés de débit tirées de l'objet, inbox).
 */
@Injectable()
export class WalletEventsConsumer {
  private readonly logger = new Logger(WalletEventsConsumer.name);
  private readonly tasks: ExecutionTasks;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
  ) {
    this.tasks = new ExecutionTasks(deps as ExecutionDeps);
  }

  /** Gestionnaire du crédit pour les séances ; rejouable sans double effet. */
  readonly onPrepaidCredited: EventHandler<'wallet.prepaid.credited'> = async (envelope) => {
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
  };
}
