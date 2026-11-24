import { type billingV1, type paymentV1, type walletV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import {
  type DirectPaymentGateway,
  type InvoiceIssuer,
  type SessionInvoiceRequest,
  type WalletBalances,
} from '../../application/execution/execution.ports';

/**
 * Appels du lot E vers les autres services, avec le jeton de service de cleaning : solde prépayé
 * (wallet), facture de séance (billing), paiement direct par Mobile Money (payment). Les trois
 * appels sont idempotents (lecture, ou clé tirée de l'objet) : ils peuvent être rejoués. Les erreurs
 * des services sont transmises telles quelles.
 */
const xof = (amount: number) => ({ amount, currency: 'XOF' });

/** wallet.GetPrepaidBalance (le « GetBalance » de la partie 15.4). */
export class GrpcWalletBalances implements WalletBalances {
  constructor(
    private readonly client: walletV1.WalletServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async balance(holder: { type: 'user' | 'organization'; id: string }): Promise<number> {
    const res = await this.caller.call(
      'getPrepaidBalance',
      (metadata) => this.client.getPrepaidBalance({ holder }, metadata),
      { idempotent: true },
    );
    return Number(res.wallet?.balance?.amount ?? 0);
  }
}

/** billing.InvoiceIssuanceService.IssueInvoice : facture de séance déjà payée (R-PP-06). */
export class GrpcInvoiceIssuer implements InvoiceIssuer {
  constructor(
    private readonly client: billingV1.InvoiceIssuanceServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async issueSessionInvoice(request: SessionInvoiceRequest): Promise<{ invoiceId: string }> {
    const res = await this.caller.call(
      'issueInvoice',
      (metadata) =>
        this.client.issueInvoice(
          {
            idempotencyKey: request.idempotencyKey,
            kind: 'session',
            customerId: request.customerId,
            organizationId: '',
            sourceObject: { objectType: 'cleaning_session', objectId: request.sessionId },
            requestNumber: request.requestNumber,
            programNumber: request.programNumber,
            sessionRank: request.sessionRank,
            placeLabel: request.placeLabel,
            serviceDate: request.serviceDate,
            lines: request.lines.map((line) => ({
              label: line.label,
              quantity: 1,
              unitPrice: xof(line.amount),
              amount: xof(line.amount),
              kind: line.kind,
              serviceDate: request.serviceDate,
              programNumber: request.programNumber,
              placeLabel: request.placeLabel,
              sourceObjectId: request.sessionId,
            })),
            payment: {
              method: 'wallet',
              reference: request.payment.reference ?? '',
              amount: xof(request.payment.amount),
              paidAt: request.payment.paidAt.toISOString(),
            },
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.invoice?.id) throw new Error('Réponse de billing sans facture.');
    return { invoiceId: res.invoice.id };
  }
}

/** payment.TopUpPaymentService.CreatePaymentRequest : paiement direct de ce qui manque (R-WL-05). */
export class GrpcDirectPaymentGateway implements DirectPaymentGateway {
  constructor(
    private readonly client: paymentV1.TopUpPaymentServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async create(input: Parameters<DirectPaymentGateway['create']>[0]) {
    const res = await this.caller.call(
      'createPaymentRequest',
      (metadata) =>
        this.client.createPaymentRequest(
          {
            idempotencyKey: input.idempotencyKey,
            customerId: input.customerId,
            organizationId: input.organizationId ?? '',
            amount: xof(input.amount),
            target: {
              service: '',
              objectType: input.target.objectType,
              objectId: input.target.objectId,
              part: '',
              reference: input.target.reference,
            },
            description: input.description,
            expiresAt: input.expiresAt ? input.expiresAt.toISOString() : '',
          },
          metadata,
        ),
      { idempotent: true },
    );
    if (!res.payment?.id) throw new Error('Réponse de payment sans paiement.');
    return {
      paymentId: res.payment.id,
      checkoutUrl: res.payment.checkoutUrl,
      expiresAt: res.payment.expiresAt ? new Date(res.payment.expiresAt) : null,
    };
  }
}
