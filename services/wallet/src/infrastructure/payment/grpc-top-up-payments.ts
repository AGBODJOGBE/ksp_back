import { type paymentV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { type TopUpPayment, type TopUpPayments, type TopUpRecord } from '../../application/ports';

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

  /**
   * Paiement de recharge relu chez payment (TopUpPaymentService.GetTopUpPayment, ADR-048) avant tout
   * crédit ; inconnu de payment : null. Une panne lève l'erreur (l'appelant réessaie).
   */
  async get(paymentId: string): Promise<TopUpRecord | null> {
    let res;
    try {
      res = await this.caller.call(
        'getTopUpPayment',
        (metadata) => this.client.getTopUpPayment({ paymentId }, metadata),
        { idempotent: true, deadlineMs: 5_000 },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'PAYMENT_NOT_FOUND') return null;
      throw error;
    }
    const payment = res.payment;
    if (!payment?.id || !payment.subject) throw new Error('Réponse de payment sans paiement.');
    return {
      paymentId: payment.id,
      status: payment.status,
      holderId: payment.subject.id,
      customerId: payment.customerId || null,
      organizationId: payment.organizationId || null,
      amount: Number(payment.amount?.amount ?? 0),
      receivedAmount: res.receivedAmount ? Number(res.receivedAmount.amount) : null,
    };
  }
}
