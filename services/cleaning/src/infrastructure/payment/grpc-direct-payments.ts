import { type paymentV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type DirectPaymentPage, type DirectPayments } from '../../application/money/money.ports';

/**
 * Paiement direct par Mobile Money (payment, TopUpPaymentService.CreatePaymentRequest, ADR-055),
 * avec le jeton de service de cleaning : une recharge du wallet qui porte l'objet visé. Idempotent
 * par clé chez payment (même page renvoyée) : l'appel peut être rejoué. Les erreurs de payment sont
 * transmises telles quelles.
 */
export class GrpcDirectPayments implements DirectPayments {
  constructor(
    private readonly client: paymentV1.TopUpPaymentServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async createPaymentRequest(
    input: Parameters<DirectPayments['createPaymentRequest']>[0],
  ): Promise<DirectPaymentPage> {
    const response = await this.caller.call(
      'createPaymentRequest',
      (metadata) =>
        this.client.createPaymentRequest(
          {
            idempotencyKey: input.idempotencyKey,
            customerId: input.customerId,
            organizationId: input.organizationId ?? '',
            amount: { amount: input.amount, currency: 'XOF' },
            target: {
              service: '',
              objectType: input.target.objectType,
              objectId: input.target.objectId,
              part: input.target.part ?? '',
              reference: input.target.reference,
            },
            description: input.description.slice(0, 140),
            expiresAt: input.expiresAt ? input.expiresAt.toISOString() : '',
          },
          metadata,
        ),
      { idempotent: true },
    );
    const payment = response.payment;
    if (!payment?.id) throw new Error('Réponse de payment sans paiement.');
    return {
      paymentId: payment.id,
      checkoutUrl: payment.checkoutUrl || null,
      expiresAt: payment.expiresAt ? new Date(payment.expiresAt) : null,
      created: response.created,
    };
  }
}
