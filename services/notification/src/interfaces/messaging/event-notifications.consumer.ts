import { type EventEnvelope } from '@ksp/contracts';
import { RabbitMqConsumer } from '@ksp/platform';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { LISTENED_EVENTS } from '../../application/events/listened-events';
import { NotifyEventUseCase } from '../../application/events/notify-event.use-case';

/**
 * Adaptateur RabbitMQ : abonne notification aux événements écoutés (file `notification.<événement>`,
 * reprise puis file d'erreurs, gérées par le kit) et délègue au cas d'usage.
 * Ne journalise que l'identifiant, le type et les compteurs : jamais de coordonnées ni de texte.
 */
@Injectable()
export class EventNotificationsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(EventNotificationsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    private readonly notifyEventUseCase: NotifyEventUseCase,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const eventType of LISTENED_EVENTS) {
      await this.consumer.subscribe(eventType, (envelope) => this.handle(envelope));
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.close();
  }

  /** Une erreur levée ici renvoie l'événement en file de reprise (puis en file d'erreurs). */
  async handle(envelope: EventEnvelope): Promise<void> {
    const result = await this.notifyEventUseCase.execute(envelope);
    if (result.status !== 'processed') {
      this.logger.debug(`${envelope.type} (${envelope.eventId}) : ${result.status}.`);
      return;
    }
    const message =
      `${envelope.type} (${envelope.eventId}) : ${result.accepted} message(s) pris en charge, ` +
      `${result.failed} en échec, ${result.replayed} déjà envoyé(s), ${result.inApp} dans l'espace, ` +
      `${result.recipientsNotFound} destinataire(s) introuvable(s), ${result.unreachable} sans coordonnées.`;
    if (result.failed > 0 || result.recipientsNotFound > 0) this.logger.warn(message);
    else this.logger.log(message);
  }
}
