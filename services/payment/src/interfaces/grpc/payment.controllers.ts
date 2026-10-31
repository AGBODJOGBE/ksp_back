import { paymentV1 } from '@ksp/contracts';
import { Controller, Inject, Logger } from '@nestjs/common';
import { parsePage } from '../../application/shared/validation';
import { PAYMENT_USE_CASES, type PaymentUseCases } from '../../application/use-cases';
import { presentPayment } from './presenters';

/** Adaptateur gRPC de l'espace client. Aucune règle métier ici. */
@Controller()
@paymentV1.PaymentServiceControllerMethods()
export class PaymentGrpcController implements paymentV1.PaymentServiceController {
  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async createPayment(request: paymentV1.CreatePaymentRequest): Promise<paymentV1.CreatePaymentResponse> {
    const result = await this.useCases.createPayment.execute({
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      part: request.part,
      idempotencyKey: request.idempotencyKey,
    });
    return { payment: presentPayment(result.payment), created: result.created };
  }

  async getMyPayment(request: paymentV1.GetMyPaymentRequest): Promise<paymentV1.GetMyPaymentResponse> {
    return { payment: presentPayment(await this.useCases.getMyPayment.execute(request.paymentId)) };
  }

  async listMyPayments(request: paymentV1.ListMyPaymentsRequest): Promise<paymentV1.ListMyPaymentsResponse> {
    const page = await this.useCases.listMyPayments.execute({
      page: parsePage(request.page),
      status: request.status,
    });
    return { payments: page.items.map(presentPayment), nextCursor: page.nextCursor ?? '' };
  }

  async simulatePayment(
    request: paymentV1.SimulatePaymentRequest,
  ): Promise<paymentV1.SimulatePaymentResponse> {
    const payment = await this.useCases.simulatePayment.execute({
      paymentId: request.paymentId,
      outcome: request.outcome,
    });
    return { payment: presentPayment(payment) };
  }
}

/**
 * Notifications du prestataire relayées par la gateway. Le corps n'est jamais journalisé : seule
 * l'issue l'est (identifiants seulement).
 */
@Controller()
@paymentV1.PaymentWebhookServiceControllerMethods()
export class PaymentWebhookGrpcController implements paymentV1.PaymentWebhookServiceController {
  private readonly logger = new Logger('PaymentWebhook');

  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async receiveProviderNotification(
    request: paymentV1.ReceiveProviderNotificationRequest,
  ): Promise<paymentV1.ReceiveProviderNotificationResponse> {
    const outcome = await this.useCases.receiveProviderNotification.execute({
      provider: request.provider,
      payload: request.payload,
      signature: request.signature,
    });
    if (outcome === 'amount_mismatch') {
      this.logger.error('Notification : montant confirmé différent du montant du paiement (aucun effet).');
    } else {
      this.logger.log(`Notification ${request.provider} : ${outcome}`);
    }
    return { outcome };
  }
}

/** Adaptateur gRPC du back-office. Droits vérifiés par les cas d'usage. */
@Controller()
@paymentV1.PaymentAdminServiceControllerMethods()
export class PaymentAdminGrpcController implements paymentV1.PaymentAdminServiceController {
  constructor(@Inject(PAYMENT_USE_CASES) private readonly useCases: PaymentUseCases) {}

  async listPayments(request: paymentV1.ListPaymentsRequest): Promise<paymentV1.ListPaymentsResponse> {
    const page = await this.useCases.listPayments.execute({
      page: parsePage(request.page),
      status: request.status,
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      customerId: request.customerId,
      organizationId: request.organizationId,
    });
    return { payments: page.items.map(presentPayment), nextCursor: page.nextCursor ?? '' };
  }
}
