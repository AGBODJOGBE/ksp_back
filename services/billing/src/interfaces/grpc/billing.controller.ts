import { billingV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { parsePage } from '../../application/shared/validation';
import { BILLING_USE_CASES, type BillingUseCases } from '../../application/use-cases';
import { presentInvoice, presentSettings } from './presenters';

/** Adaptateur gRPC de l'espace client : « Mes factures ». Aucune règle métier ici. */
@Controller()
@billingV1.BillingServiceControllerMethods()
export class BillingGrpcController implements billingV1.BillingServiceController {
  constructor(@Inject(BILLING_USE_CASES) private readonly useCases: BillingUseCases) {}

  async listMyInvoices(request: billingV1.ListMyInvoicesRequest): Promise<billingV1.ListMyInvoicesResponse> {
    const page = await this.useCases.listMyInvoices.execute({
      page: parsePage(request.page),
      status: request.status,
    });
    return { invoices: page.items.map(presentInvoice), nextCursor: page.nextCursor ?? '' };
  }

  async getMyInvoice(request: billingV1.GetMyInvoiceRequest): Promise<billingV1.GetMyInvoiceResponse> {
    return { invoice: presentInvoice(await this.useCases.getMyInvoice.execute(request.invoiceId)) };
  }
}

/** Adaptateur gRPC du back-office : factures, paiement manuel, réglages. Droits vérifiés par les cas d'usage. */
@Controller()
@billingV1.BillingAdminServiceControllerMethods()
export class BillingAdminGrpcController implements billingV1.BillingAdminServiceController {
  constructor(@Inject(BILLING_USE_CASES) private readonly useCases: BillingUseCases) {}

  async listInvoices(request: billingV1.ListInvoicesRequest): Promise<billingV1.ListInvoicesResponse> {
    const page = await this.useCases.listInvoices.execute({
      page: parsePage(request.page),
      status: request.status,
      customerId: request.customerId,
      organizationId: request.organizationId,
      contractId: request.contractId,
    });
    return { invoices: page.items.map(presentInvoice), nextCursor: page.nextCursor ?? '' };
  }

  async getInvoice(request: billingV1.GetInvoiceRequest): Promise<billingV1.GetInvoiceResponse> {
    return { invoice: presentInvoice(await this.useCases.getInvoice.execute(request.invoiceId)) };
  }

  async recordInvoicePayment(
    request: billingV1.RecordInvoicePaymentRequest,
  ): Promise<billingV1.RecordInvoicePaymentResponse> {
    const invoice = await this.useCases.recordInvoicePayment.execute({
      invoiceId: request.invoiceId,
      amount: Number(request.amount?.amount ?? 0),
      method: request.method,
      reference: request.reference,
    });
    return { invoice: presentInvoice(invoice) };
  }

  async getBillingSettings(): Promise<billingV1.GetBillingSettingsResponse> {
    return { settings: presentSettings(await this.useCases.getSettings.execute()) };
  }

  async updateBillingSettings(
    request: billingV1.UpdateBillingSettingsRequest,
  ): Promise<billingV1.UpdateBillingSettingsResponse> {
    const saved = await this.useCases.updateSettings.execute({
      paymentTermDays: request.settings?.paymentTermDays ?? 0,
    });
    return { settings: presentSettings(saved) };
  }
}
