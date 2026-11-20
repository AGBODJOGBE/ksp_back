import { RabbitMqConsumer } from '@ksp/platform';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { WALLET_USE_CASES, type WalletUseCases } from '../../application/use-cases';

/**
 * Portefeuille prépayé (ADR-046) : file wallet.payment.intent.succeeded, une recharge confirmée (objet
 * wallet_top_up) est créditée au portefeuille, une seule fois (inbox et référence du paiement) ; les
 * autres objets sont ignorés. Un échec repasse par la file de reprise.
 *
 * Les remboursements et crédits du Nettoyage v1 (cleaning.mission.refunded, cleaning.mission.credited)
 * sont retirés avec la v1 (ADR-054) : le Nettoyage v2 rembourse par appel (Refund, Credit, RV-81).
 */
@Injectable()
export class PrepaidEventsConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PrepaidEventsConsumer.name);

  constructor(
    private readonly consumer: RabbitMqConsumer,
    @Inject(WALLET_USE_CASES) private readonly useCases: WalletUseCases,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.consumer.subscribe('payment.intent.succeeded', async (envelope) => {
      const payload = envelope.payload;
      if (payload.subjectType !== 'wallet_top_up') return;
      const outcome = await this.useCases.creditTopUp.execute({
        eventId: envelope.eventId,
        eventType: envelope.type,
        paymentId: payload.paymentId,
        subjectId: payload.subjectId,
        customerId: payload.customerId,
        organizationId: payload.organizationId,
        amount: payload.amount.amount,
        target: payload.target ?? null,
      });
      if (outcome === 'rejected') {
        // Paiement relu chez payment qui ne confirme pas l'événement (ADR-048) : rien n'est crédité.
        this.logger.error(
          `ALERTE wallet : recharge ${payload.paymentId} non confirmée par payment (statut, titulaire ` +
            "ou montant reçu) ; rien n'est crédité, à vérifier par la finance",
        );
        return;
      }
      if (outcome === 'ignored') {
        // Identifiants seulement : la recharge ne désigne pas le titulaire du payeur.
        this.logger.error(
          `ALERTE wallet : recharge ${payload.paymentId} pour ${payload.subjectId}, titulaire différent ` +
            "du payeur ; rien n'est crédité",
        );
        return;
      }
      this.logger.log(`Recharge ${payload.paymentId} : ${outcome}`);
    });
  }
}
