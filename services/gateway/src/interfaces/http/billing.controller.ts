import { Body, Controller, Inject, Param, Query } from '@nestjs/common';
import { type BillingApi } from '../../application/billing/billing.ports';
import { BILLING_API } from '../../tokens';
import { billingParams } from './billing-schemas';
import { idFrom, pageFrom } from './cleaning.controller';
import { parseParam } from './cleaning-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

type Query = Record<string, unknown>;

const statusFrom = (query: Query) => parseParam(billingParams.invoiceStatus, query['status'], 'status');
const optionalId = (query: Query, name: string) => parseParam(billingParams.optionalId, query[name], name);

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

  @Route('listInvoices')
  listInvoices(@Query() query: Query) {
    const filters = {
      status: statusFrom(query),
      customerId: optionalId(query, 'customerId'),
      organizationId: optionalId(query, 'organizationId'),
      contractId: optionalId(query, 'contractId'),
    };
    return this.billing.listInvoices(pageFrom(query), filters);
  }

  @Route('getInvoice')
  getInvoice(@Param('id') id: unknown) {
    return this.billing.getInvoice(idFrom(id));
  }

  @Route('recordInvoicePayment')
  recordInvoicePayment(@Param('id') id: unknown, @Body() body: unknown) {
    const invoiceId = idFrom(id);
    return this.billing.recordInvoicePayment(invoiceId, parseBody(requestBodies.recordInvoicePayment, body));
  }

  @Route('getBillingSettings')
  getSettings() {
    return this.billing.getSettings();
  }

  @Route('updateBillingSettings')
  updateSettings(@Body() body: unknown) {
    return this.billing.updateSettings(parseBody(requestBodies.updateBillingSettings, body));
  }
}
