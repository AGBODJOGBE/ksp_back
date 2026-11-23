import { type paymentV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type PaymentLink, type PaymentLinks } from '../../application/ports';
import { callDependency } from './dependency';

function present(link: paymentV1.PaymentLink | undefined): PaymentLink {
  if (!link?.id) throw new Error('Réponse de payment sans lien.');
  return {
    id: link.id,
    status: link.status,
    url: link.url,
    amount: Number(link.amount?.amount ?? 0),
    expiresAt: link.expiresAt,
    paidAt: link.paidAt || null,
  };
}

/**
 * Liens de paiement sans compte chez payment (PaymentLinkService, ADR-040), émis par recovery avec
 * son jeton de service. Création idempotente par (émetteur, clé) ; un seul lien payable par objet.
 */
export class GrpcPaymentLinks implements PaymentLinks {
  constructor(
    private readonly client: paymentV1.PaymentLinkServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async create(input: Parameters<PaymentLinks['create']>[0]): Promise<PaymentLink> {
    const res = await callDependency<paymentV1.CreatePaymentLinkResponse>(
      'payment',
      this.caller,
      'createPaymentLink',
      (metadata) =>
        this.client.createPaymentLink(
          {
            idempotencyKey: input.idempotencyKey,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            reference: input.reference,
            beneficiaryName: input.beneficiaryName,
            description: input.description,
            amount: { amount: input.amount, currency: 'XOF' },
            dueDate: input.dueDate ?? '',
            expiresAt: input.expiresAt.toISOString(),
            // Ni nom ni téléphone du débiteur chez payment : ils restent chiffrés dans recovery.
            payerName: '',
            payerPhone: '',
          },
          metadata,
        ),
      { idempotent: true },
    );
    return present(res.link);
  }

  async get(linkId: string): Promise<PaymentLink> {
    const res = await callDependency<paymentV1.GetPaymentLinkResponse>(
      'payment',
      this.caller,
      'getPaymentLink',
      (metadata) => this.client.getPaymentLink({ linkId }, metadata),
      { idempotent: true },
    );
    return present(res.link);
  }

  async revoke(linkId: string, reason: string): Promise<PaymentLink> {
    const res = await callDependency<paymentV1.RevokePaymentLinkResponse>(
      'payment',
      this.caller,
      'revokePaymentLink',
      (metadata) => this.client.revokePaymentLink({ linkId, reason }, metadata),
      { idempotent: true },
    );
    return present(res.link);
  }
}
