import { type Invoice, type InvoiceSettlement } from '../../domain/invoice';
import { type OutboxMessage } from '../ports';

/**
 * Événements de facture (lot F). Une facture v1 (contrat) publie la version 1, avec son contrat ;
 * une facture v2 (`kind` renseigné : séance, frais de visite, facture mensuelle) publie la version 2,
 * sans contrat, avec sa nature et le compte des impayés de son titulaire (RV-98). Identifiants et
 * montants seulement.
 */
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

/** Champs communs : la v1 porte le contrat, la v2 la nature de la facture. */
export function invoiceRef(invoice: Invoice) {
  const base = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    customerId: invoice.customerId,
    organizationId: invoice.organizationId,
    source: invoice.source,
    total: xof(invoice.total),
  };
  return invoice.kind ? { ...base, kind: invoice.kind } : { ...base, contractId: invoice.contractId ?? '' };
}

const version = (invoice: Invoice) => (invoice.kind ? { version: 2 as const } : {});

export function issuedEvent(invoice: Invoice): OutboxMessage {
  return {
    type: 'billing.invoice.issued',
    ...version(invoice),
    payload: {
      ...invoiceRef(invoice),
      periodStart: invoice.periodStart.toISOString(),
      periodEnd: invoice.periodEnd.toISOString(),
      issuedAt: invoice.issuedAt.toISOString(),
      dueAt: invoice.dueAt.toISOString(),
      ...(invoice.kind ? { status: invoice.status === 'paid' ? 'paid' : 'pending_payment' } : {}),
    },
  };
}

/** `overdueCount` : impayées du contrat (v1) ou du titulaire (v2), celle-ci comprise. */
export function overdueEvent(invoice: Invoice, overdueCount: number): OutboxMessage {
  return {
    type: 'billing.invoice.overdue',
    ...version(invoice),
    payload: {
      ...invoiceRef(invoice),
      dueAt: invoice.dueAt.toISOString(),
      overdueCount,
      ...(invoice.kind ? { holderOverdueCount: overdueCount } : {}),
    },
  };
}

/** Facture soldée (RV-87) : `overdueCount`, impayées restantes du contrat (v1) ou du titulaire (v2). */
export function paidEvent(
  invoice: Invoice,
  paidAt: Date,
  overdueCount: number,
  settledBy: InvoiceSettlement = 'payment',
): OutboxMessage {
  return {
    type: 'billing.invoice.paid',
    ...version(invoice),
    payload: {
      ...invoiceRef(invoice),
      paidAt: paidAt.toISOString(),
      overdueCount,
      ...(invoice.kind ? { holderOverdueCount: overdueCount, settledBy } : {}),
    },
  };
}
