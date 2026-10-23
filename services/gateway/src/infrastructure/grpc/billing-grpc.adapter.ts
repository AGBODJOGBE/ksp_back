import { type Metadata } from '@grpc/grpc-js';
import { type billingV1, type moneyV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import {
  type BillingApi,
  type InvoiceFilters,
  type InvoicePaymentInput,
} from '../../application/billing/billing.ports';
import { type Json, type Page } from '../../application/cleaning/cleaning.ports';
import { toUpstreamError } from './upstream-error';

export interface BillingClients {
  invoices: billingV1.BillingServiceClient;
  admin: billingV1.BillingAdminServiceClient;
}

/** Réponse de billing qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de billing inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);
const money = (value: moneyV1.Money | undefined) =>
  value ? { amount: value.amount, currency: value.currency } : { amount: 0, currency: 'XOF' };
const page = (value: Page): billingV1.Page => ({ limit: value.limit ?? 0, cursor: value.cursor ?? '' });

/** Traduction d'une facture ksp.billing.v1 vers le JSON du contrat OpenAPI. */
export function presentInvoice(value: billingV1.Invoice | undefined) {
  if (!value) throw malformed('facture');
  return {
    id: value.id,
    number: value.number,
    status: value.status,
    customerId: value.customerId,
    organizationId: orNull(value.organizationId),
    source: value.source,
    contractId: value.contractId,
    periodIndex: value.periodIndex,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    lines: value.lines.map((line) => ({
      label: line.label,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
    total: money(value.total),
    paid: money(value.paid),
    balance: money(value.balance),
    issuedAt: value.issuedAt,
    dueAt: value.dueAt,
    paidAt: orNull(value.paidAt),
    payments: value.payments.map((payment) => ({
      id: payment.id,
      amount: money(payment.amount),
      method: payment.method,
      reference: orNull(payment.reference),
      recordedBy: payment.recordedBy,
      recordedAt: payment.recordedAt,
    })),
  };
}

export function presentBillingSettings(value: billingV1.BillingSettings | undefined) {
  if (!value) throw malformed('réglages');
  return {
    paymentTermDays: value.paymentTermDays,
    updatedBy: orNull(value.updatedBy),
    updatedAt: orNull(value.updatedAt),
  };
}

const list = (res: { invoices: billingV1.Invoice[]; nextCursor: string }) => ({
  data: res.invoices.map(presentInvoice),
  nextCursor: res.nextCursor || null,
});

/**
 * Client gRPC de billing : délai, coupe-circuit et jeton de service par GrpcCaller. Seules les
 * lectures sont rejouées ; une écriture (paiement, réglages) ne l'est jamais.
 */
export class BillingGrpcAdapter implements BillingApi {
  private readonly logger = new Logger('BillingGrpc');

  constructor(
    private readonly clients: BillingClients,
    private readonly caller: GrpcCaller,
  ) {}

  async listMyInvoices(value: Page, status: string | undefined): Promise<Json> {
    return list(
      await this.read('listMyInvoices', (m) =>
        this.clients.invoices.listMyInvoices({ page: page(value), status: status ?? '' }, m),
      ),
    );
  }

  async getMyInvoice(id: string): Promise<Json> {
    const res = await this.read('getMyInvoice', (m) =>
      this.clients.invoices.getMyInvoice({ invoiceId: id }, m),
    );
    return presentInvoice(res.invoice);
  }

  async listInvoices(value: Page, filters: InvoiceFilters): Promise<Json> {
    return list(
      await this.read('listInvoices', (m) =>
        this.clients.admin.listInvoices(
          {
            page: page(value),
            status: filters.status ?? '',
            customerId: filters.customerId ?? '',
            organizationId: filters.organizationId ?? '',
            contractId: filters.contractId ?? '',
          },
          m,
        ),
      ),
    );
  }

  async getInvoice(id: string): Promise<Json> {
    const res = await this.read('getInvoice', (m) => this.clients.admin.getInvoice({ invoiceId: id }, m));
    return presentInvoice(res.invoice);
  }

  async recordInvoicePayment(id: string, input: InvoicePaymentInput): Promise<Json> {
    const res = await this.write('recordInvoicePayment', (m) =>
      this.clients.admin.recordInvoicePayment(
        {
          invoiceId: id,
          amount: { amount: input.amount, currency: 'XOF' },
          method: input.method,
          reference: input.reference ?? '',
        },
        m,
      ),
    );
    return presentInvoice(res.invoice);
  }

  async getSettings(): Promise<Json> {
    const res = await this.read('getBillingSettings', (m) => this.clients.admin.getBillingSettings({}, m));
    return presentBillingSettings(res.settings);
  }

  async updateSettings(input: { paymentTermDays: number }): Promise<Json> {
    const res = await this.write('updateBillingSettings', (m) =>
      this.clients.admin.updateBillingSettings({ settings: { ...input, updatedBy: '', updatedAt: '' } }, m),
    );
    return presentBillingSettings(res.settings);
  }

  // --- Appels -----------------------------------------------------------------------------------

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true });
  }

  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, {});
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('billing', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`billing.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
