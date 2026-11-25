import { Body, Controller, Headers, Inject, Param, Query } from '@nestjs/common';
import { type BillingApi } from '../../application/billing/billing.ports';
import { BILLING_API } from '../../tokens';
import { billingParams } from './billing-schemas';
import { idFrom, keyFrom, pageFrom, parseParam } from './params';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

const statusFrom = (query: Query) => parseParam(billingParams.invoiceStatus, query['status'], 'status');
const optionalId = (query: Query, name: string) => parseParam(billingParams.optionalId, query[name], name);
const optionalDate = (query: Query, name: string) =>
  parseParam(billingParams.optionalDate, query[name], name);
// Recouvrement (ADR-064) : état et mois facturé d'une facture de commission.
const commissionFilters = (query: Query) => ({
  status: parseParam(billingParams.commissionInvoiceStatus, query['status'], 'status'),
  period: parseParam(billingParams.optionalPeriod, query['period'], 'period'),
});

/**
 * Routes /api/v1/billing/* (« Mes factures ») et /api/v1/admin/billing/* (back-office). Rôles et
 * double authentification contrôlés par le garde d'après le manifeste, puis revérifiés par billing.
 */
@Controller()
export class BillingHttpController {
  constructor(@Inject(BILLING_API) private readonly billing: BillingApi) {}

  @Route('listMyInvoices')
  listMyInvoices(@Query() query: Query) {
    const status = statusFrom(query);
    return this.billing.listMyInvoices(pageFrom(query), status);
  }

  @Route('getMyInvoice')
  getMyInvoice(@Param('id') id: unknown) {
    return this.billing.getMyInvoice(idFrom(id));
  }

  @Route('payMyInvoiceFromWallet')
  payFromWallet(@Param('id') id: unknown, @Headers('idempotency-key') key: unknown) {
    const invoiceId = idFrom(id);
    return this.billing.payMyInvoiceFromWallet(invoiceId, keyFrom(key));
  }

  @Route('listInvoices')
  listInvoices(@Query() query: Query) {
    const filters = {
      status: statusFrom(query),
      customerId: optionalId(query, 'customerId'),
      organizationId: optionalId(query, 'organizationId'),
      contractId: optionalId(query, 'contractId'),
      from: optionalDate(query, 'from'),
      to: optionalDate(query, 'to'),
    };
    return this.billing.listInvoices(pageFrom(query), filters);
  }

  @Route('getInvoice')
  getInvoice(@Param('id') id: unknown) {
    return this.billing.getInvoice(idFrom(id));
  }

  @Route('recordInvoicePayment')
  recordInvoicePayment(
    @Param('id') id: unknown,
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
  ) {
    const invoiceId = idFrom(id);
    // Facultative : un front qui ne l'envoie pas encore reste servi (comme le paiement manuel du Nettoyage).
    const idempotencyKey = parseParam(billingParams.optionalIdempotencyKey, key, 'Idempotency-Key');
    return this.billing.recordInvoicePayment(invoiceId, {
      ...parseBody(requestBodies.recordInvoicePayment, body),
      idempotencyKey,
    });
  }

  @Route('getBillingSettings')
  getSettings() {
    return this.billing.getSettings();
  }

  @Route('updateBillingSettings')
  updateSettings(@Body() body: unknown) {
    return this.billing.updateSettings(parseBody(requestBodies.updateBillingSettings, body));
  }

  // --- Recouvrement (ADR-064) : factures de commission et reçus des frais de dossier ------------

  @Route('listMyCommissionInvoices')
  listMyCommissionInvoices(@Query() query: Query) {
    const filters = commissionFilters(query);
    return this.billing.listMyCommissionInvoices(pageFrom(query), filters);
  }

  @Route('getMyCommissionInvoice')
  getMyCommissionInvoice(@Param('id') id: unknown) {
    return this.billing.getMyCommissionInvoice(idFrom(id));
  }

  @Route('listMyFeeReceipts')
  listMyFeeReceipts(@Query() query: Query) {
    const caseId = optionalId(query, 'caseId');
    return this.billing.listMyFeeReceipts(pageFrom(query), caseId);
  }

  @Route('listCommissionInvoices')
  listCommissionInvoices(@Query() query: Query) {
    const filters = { ...commissionFilters(query), creditorId: optionalId(query, 'creditorId') };
    return this.billing.listCommissionInvoices(pageFrom(query), filters);
  }

  @Route('getCommissionInvoice')
  getCommissionInvoice(@Param('id') id: unknown) {
    return this.billing.getCommissionInvoice(idFrom(id));
  }
}
