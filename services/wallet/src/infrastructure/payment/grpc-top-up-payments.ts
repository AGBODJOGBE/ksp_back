import { type paymentV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type TopUpPayment, type TopUpPayments } from '../../application/ports';

/**
 * Recharges créées chez payment (TopUpPaymentService.CreateTopUpPayment, ADR-046) avec le jeton de
 * service de wallet ; l'utilisateur de la requête (payeur) est transmis dans les métadonnées par le
 * kit. Idempotent chez payment par (payeur, clé) : l'appel peut être rejoué. Délai long : payment
 * appelle le prestataire pour obtenir la page de paiement.
 */
export class GrpcTopUpPayments implements TopUpPayments {
  constructor(
    private readonly client: paymentV1.TopUpPaymentServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async create(input: { idempotencyKey: string; amount: number }): Promise<TopUpPayment> {
    const res = await this.caller.call(
      'createTopUpPayment',
      (metadata) =>
        this.client.createTopUpPayment(
          { idempotencyKey: input.idempotencyKey, amount: { amount: input.amount, currency: 'XOF' } },
          metadata,
        ),
      { idempotent: true, deadlineMs: 15_000 },
    );
    const payment = res.payment;
    if (!payment?.id) throw new Error('Réponse de payment sans paiement.');
    return {
      paymentId: payment.id,
      amount: Number(payment.amount?.amount ?? input.amount),
      status: payment.status,
      checkoutUrl: payment.checkoutUrl || null,
      expiresAt: payment.expiresAt ? new Date(payment.expiresAt) : null,
      created: res.created,
    };
  }
}
