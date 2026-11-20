import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { LOT_C_USE_CASES, type LotCUseCases } from '../../application/requests/lot-c-use-cases';
import { WalletEventsConsumer } from './wallet-events.consumer';

/**
 * Événements d'argent écoutés par cleaning (partie 15.5, ADR-055) :
 * - wallet.prepaid.credited (versions 1 et 2, RV-101) : seul déclencheur du débit qui suit un
 *   paiement direct ; toute recharge relance les débits en attente ;
 * - payment.intent.succeeded : suivi du paiement direct seulement, jamais de débit.
 * Un seul abonnement par type d'événement dans le service (une file par consommateur et par type) :
 * le paiement d'une séance (lot E, WalletEventsConsumer) passe par ce même abonnement. Traitement
 * idempotent (inbox) ; un échec renvoie le message en file de reprise. Journal : identifiants
 * seulement.
 */
@Injectable()
export class MoneyEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(MoneyEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(LOT_C_USE_CASES) private readonly useCases: LotCUseCases,
    private readonly sessions: WalletEventsConsumer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe(
      'wallet.prepaid.credited',
      async (envelope) => {
        const payload = envelope.payload;
        const forObject = 'forObject' in payload ? (payload.forObject ?? null) : null;
        // Un crédit qui vise une séance (lot E) la sert d'abord : la relance des frais de visite en
        // attente ne doit pas consommer le montant payé pour cette séance. Sinon, les frais d'abord.
        const sessionFirst = forObject?.service === 'cleaning' && forObject.objectType === 'cleaning_session';
        if (sessionFirst) await this.sessions.onPrepaidCredited(envelope);
        const outcome = await this.useCases.money.onPrepaidCredited({
          eventId: envelope.eventId,
          holder: payload.holder,
          forObject,
          paymentId: payload.paymentId ?? null,
        });
        if (outcome.debitedRequestIds.length || outcome.leftInWallet.length) {
          this.logger.log(
            `Crédit du wallet : ${outcome.debitedRequestIds.length} frais de visite débités, ${outcome.leftInWallet.length} montant(s) laissé(s) au wallet`,
          );
        }
        if (!sessionFirst) await this.sessions.onPrepaidCredited(envelope);
      },
      { versions: [1, 2] },
    );
    await this.consumer.subscribe('payment.intent.succeeded', async (envelope) => {
      await this.useCases.money.onPaymentSucceeded({
        eventId: envelope.eventId,
        paymentId: envelope.payload.paymentId,
        target: envelope.payload.target ?? null,
      });
    });
  }
}
