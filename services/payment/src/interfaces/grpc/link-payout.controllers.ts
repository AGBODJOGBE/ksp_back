import { paymentV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { type LinkView } from '../../application/links.use-cases';
import { parsePage } from '../../application/shared/validation';
import { PAYMENT_USE_CASES, type PaymentUseCases } from '../../application/use-cases';
import { lastAttempt, paidAttempt } from '../../domain/payment-link';
import { CURRENCY, type PaymentIntent } from '../../domain/payment-intent';
import { type Payout } from '../../domain/payout';

const iso = (value: Date | null) => (value ? value.toISOString() : '');

/** Lien vu par son émetteur : adresse, jeton, payeur, essais. */
export function presentLink(view: LinkView): paymentV1.PaymentLink {
  const { link } = view;
  const paid = paidAttempt(view.attempts);
  const last = lastAttempt(view.attempts);
  return {
    id: link.id,
    status: view.status,
    subjectType: link.subjectType,
    subjectId: link.subjectId,
    reference: link.reference,
    beneficiaryName: link.beneficiaryName,
    description: link.description,
    amount: { amount: link.amount, currency: CURRENCY },
    dueDate: link.dueDate ?? '',
    expiresAt: iso(link.expiresAt),
    url: view.url,
    token: view.token,
    payerName: link.payerName ?? '',
    payerPhone: link.payerPhone ?? '',
    paidPaymentId: paid?.id ?? '',
    paidAt: iso(paid ? (paid.completedAt ?? paid.updatedAt) : null),
    revokedAt: iso(link.revokedAt),
    revokedReason: link.revokedReason ?? '',
    createdAt: iso(link.createdAt),
    updatedAt: iso(link.updatedAt),
    lastPaymentId: last?.id ?? '',
    lastPaymentStatus: last?.status ?? '',
  };
}

/** Essai de paiement vu par le payeur : page du prestataire en attente seulement. */
export function presentLinkPayment(intent: PaymentIntent): paymentV1.PublicLinkPayment {
  return {
    id: intent.id,
    status: intent.status,
    checkoutUrl: intent.status === 'pending' ? (intent.checkoutUrl ?? '') : '',
    expiresAt: iso(intent.expiresAt),
    failureReason: intent.failureReason ?? '',
  };
}

/** Lien vu par le payeur : ni identifiant interne, ni donnée personnelle. */
export function presentPublicLink(view: LinkView): paymentV1.PublicPaymentLink {
  const { link } = view;
  const paid = paidAttempt(view.attempts);
  const last = lastAttempt(view.attempts);
  return {
    status: view.status,
    beneficiaryName: link.beneficiaryName,
    description: link.description,
    reference: link.reference,
    amount: { amount: link.amount, currency: CURRENCY },
    dueDate: link.dueDate ?? '',
    expiresAt: iso(link.expiresAt),
    paidAt: iso(paid ? (paid.completedAt ?? paid.updatedAt) : null),
    ...(last ? { payment: presentLinkPayment(last) } : {}),
  };
}

export function presentPayout(payout: Payout): paymentV1.Payout {
  return {
    id: payout.id,
    status: payout.status,
    issuer: payout.issuer,
    reference: payout.reference,
    amount: { amount: payout.amount, currency: CURRENCY },
    beneficiary: { ...payout.beneficiary },
    provider: payout.provider,
    providerReference: payout.providerReference ?? '',
    failureReason: payout.failureReason ?? '',
    createdAt: iso(payout.createdAt),
    updatedAt: iso(payout.updatedAt),
    completedAt: iso(payout.completedAt),
    failedAt: iso(payout.failedAt),
    settledBy: payout.settledBy ?? '',
  };
}

/** Liens de paiement des services émetteurs (ADR-040). Droits vérifiés par les cas d'usage. */
@Controller()
@paymentV1.PaymentLinkServiceControllerMethods()
export class PaymentLinkGrpcController implements paymentV1.PaymentLinkServiceController {
  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async createPaymentLink(
    request: paymentV1.CreatePaymentLinkRequest,
  ): Promise<paymentV1.CreatePaymentLinkResponse> {
    const { view, created } = await this.useCases.createPaymentLink.execute({
      idempotencyKey: request.idempotencyKey,
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      reference: request.reference,
      beneficiaryName: request.beneficiaryName,
      description: request.description,
      amount: request.amount,
      dueDate: request.dueDate,
      expiresAt: request.expiresAt,
      payerName: request.payerName,
      payerPhone: request.payerPhone,
    });
    return { link: presentLink(view), created };
  }

  async getPaymentLink(request: paymentV1.GetPaymentLinkRequest): Promise<paymentV1.GetPaymentLinkResponse> {
    return { link: presentLink(await this.useCases.getPaymentLink.execute(request.linkId)) };
  }

  async revokePaymentLink(
    request: paymentV1.RevokePaymentLinkRequest,
  ): Promise<paymentV1.RevokePaymentLinkResponse> {
    const view = await this.useCases.revokePaymentLink.execute({
      linkId: request.linkId,
      reason: request.reason,
    });
    return { link: presentLink(view) };
  }
}

/** Page publique d'un lien, appelée par la gateway. Aucune donnée personnelle dans les réponses. */
@Controller()
@paymentV1.PaymentLinkPublicServiceControllerMethods()
export class PaymentLinkPublicGrpcController implements paymentV1.PaymentLinkPublicServiceController {
  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async getPublicPaymentLink(
    request: paymentV1.GetPublicPaymentLinkRequest,
  ): Promise<paymentV1.GetPublicPaymentLinkResponse> {
    return { link: presentPublicLink(await this.useCases.getPublicPaymentLink.execute(request.token)) };
  }

  async payPaymentLink(request: paymentV1.PayPaymentLinkRequest): Promise<paymentV1.PayPaymentLinkResponse> {
    const { payment, created } = await this.useCases.payPaymentLink.execute({
      token: request.token,
      idempotencyKey: request.idempotencyKey,
    });
    return { payment: presentLinkPayment(payment), created };
  }

  async simulatePaymentLinkPayment(
    request: paymentV1.SimulatePaymentLinkPaymentRequest,
  ): Promise<paymentV1.SimulatePaymentLinkPaymentResponse> {
    const payment = await this.useCases.simulatePaymentLinkPayment.execute({
      token: request.token,
      outcome: request.outcome,
    });
    return { payment: presentLinkPayment(payment) };
  }
}

/** Reversements demandés par un service (ADR-041). */
@Controller()
@paymentV1.PayoutServiceControllerMethods()
export class PayoutGrpcController implements paymentV1.PayoutServiceController {
  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async requestPayout(request: paymentV1.RequestPayoutRequest): Promise<paymentV1.RequestPayoutResponse> {
    const { payout, created } = await this.useCases.requestPayout.execute({
      idempotencyKey: request.idempotencyKey,
      reference: request.reference,
      amount: request.amount,
      beneficiary: request.beneficiary,
    });
    return { payout: presentPayout(payout), created };
  }

  async getPayout(request: paymentV1.GetPayoutRequest): Promise<paymentV1.GetPayoutResponse> {
    return { payout: presentPayout(await this.useCases.getPayout.execute(request.payoutId)) };
  }
}

/** Back-office des reversements (finance). */
@Controller()
@paymentV1.PayoutAdminServiceControllerMethods()
export class PayoutAdminGrpcController implements paymentV1.PayoutAdminServiceController {
  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async listPayouts(request: paymentV1.ListPayoutsRequest): Promise<paymentV1.ListPayoutsResponse> {
    const page = await this.useCases.listPayouts.execute({
      page: parsePage(request.page),
      status: request.status,
      issuer: request.issuer,
    });
    return { payouts: page.items.map(presentPayout), nextCursor: page.nextCursor ?? '' };
  }

  async confirmPayout(request: paymentV1.ConfirmPayoutRequest): Promise<paymentV1.ConfirmPayoutResponse> {
    const payout = await this.useCases.confirmPayout.execute({
      payoutId: request.payoutId,
      text: request.transferReference,
      idempotencyKey: request.idempotencyKey,
    });
    return { payout: presentPayout(payout) };
  }

  async failPayout(request: paymentV1.FailPayoutRequest): Promise<paymentV1.FailPayoutResponse> {
    const payout = await this.useCases.failPayout.execute({
      payoutId: request.payoutId,
      text: request.reason,
      idempotencyKey: request.idempotencyKey,
    });
    return { payout: presentPayout(payout) };
  }
}
