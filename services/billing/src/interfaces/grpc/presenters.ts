import { type billingV1 } from '@ksp/contracts';
import { type StoredBillingSettings } from '../../application/ports';
import { balance, type Invoice, paidAmount } from '../../domain/invoice';

const money = (amount: number) => ({ amount, currency: 'XOF' });
const iso = (date: Date | null) => (date ? date.toISOString() : '');

export function presentInvoice(invoice: Invoice): billingV1.Invoice {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    customerId: invoice.customerId,
    organizationId: invoice.organizationId ?? '',
    source: invoice.source,
    contractId: invoice.contractId,
    periodIndex: invoice.periodIndex,
    periodStart: iso(invoice.periodStart),
    periodEnd: iso(invoice.periodEnd),
    lines: invoice.lines.map((line) => ({
      label: line.label,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
    total: money(invoice.total),
    paid: money(paidAmount(invoice)),
    balance: money(balance(invoice)),
    issuedAt: iso(invoice.issuedAt),
    dueAt: iso(invoice.dueAt),
    paidAt: iso(invoice.paidAt),
    payments: invoice.payments.map((payment) => ({
      id: payment.id,
      amount: money(payment.amount),
      method: payment.method,
      reference: payment.reference ?? '',
      recordedBy: payment.recordedBy,
      recordedAt: iso(payment.recordedAt),
    })),
  };
}

export function presentSettings(settings: StoredBillingSettings): billingV1.BillingSettings {
  return {
    paymentTermDays: settings.paymentTermDays,
    updatedBy: settings.updatedBy ?? '',
    updatedAt: iso(settings.updatedAt),
  };
}
