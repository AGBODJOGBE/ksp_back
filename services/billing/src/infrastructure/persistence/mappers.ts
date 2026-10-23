import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import {
  type BillingContract as ContractRow,
  type Invoice as InvoiceRow,
  type InvoicePayment as PaymentRow,
  type Prisma,
} from '../../../prisma/generated';
import { type OutboxMessage } from '../../application/ports';
import { type BillingContract, type SuspensionInterval } from '../../domain/contract';
import { type Invoice, type InvoiceLine, type InvoiceStatus, type PaymentMethod } from '../../domain/invoice';

export type Tx = Prisma.TransactionClient;
export const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Événements écrits dans l'outbox, dans la transaction de l'état. */
export async function writeEvents(tx: Tx, events: OutboxMessage[]): Promise<void> {
  for (const event of events) {
    await appendToOutbox(
      tx as unknown as SqlExecutor,
      createEnvelope(event.type, event.payload as never, { producer: 'billing' }),
    );
  }
}

type StoredInterval = { from: string; to: string };

export function toContract(row: ContractRow): BillingContract {
  return {
    id: row.id,
    source: row.source as BillingContract['source'],
    customerId: row.customerId,
    organizationId: row.organizationId,
    total: row.total,
    durationMonths: row.durationMonths,
    startsAt: row.startsAt,
    terminatedAt: row.terminatedAt,
    suspendedSince: row.suspendedSince,
    suspensions: (row.suspensions as unknown as StoredInterval[]).map((interval): SuspensionInterval => ({
      from: new Date(interval.from),
      to: new Date(interval.to),
    })),
    lastResumedAt: row.lastResumedAt,
    createdAt: row.createdAt,
  };
}

export function contractColumns(contract: BillingContract) {
  return {
    source: contract.source,
    customerId: contract.customerId,
    organizationId: contract.organizationId,
    total: contract.total,
    durationMonths: contract.durationMonths,
    startsAt: contract.startsAt,
    terminatedAt: contract.terminatedAt,
    suspendedSince: contract.suspendedSince,
    suspensions: json(
      contract.suspensions.map((interval) => ({
        from: interval.from.toISOString(),
        to: interval.to.toISOString(),
      })),
    ),
    lastResumedAt: contract.lastResumedAt,
  };
}

export const INVOICE_INCLUDE = { payments: { orderBy: { recordedAt: 'asc' as const } } };

export function toInvoice(row: InvoiceRow & { payments: PaymentRow[] }): Invoice {
  return {
    id: row.id,
    number: row.number,
    status: row.status as InvoiceStatus,
    contractId: row.contractId,
    customerId: row.customerId,
    organizationId: row.organizationId,
    source: row.source as Invoice['source'],
    periodIndex: row.periodIndex,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    lines: row.lines as unknown as InvoiceLine[],
    total: row.total,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    payments: row.payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      method: payment.method as PaymentMethod,
      reference: payment.reference,
      recordedBy: payment.recordedBy,
      recordedAt: payment.recordedAt,
    })),
    version: row.version,
  };
}

/** Page par curseur : identifiants UUID v7 décroissants (les plus récents d'abord). */
export function pageArgs(page: { limit: number; cursor: string | null }) {
  return {
    take: page.limit + 1,
    orderBy: { id: 'desc' as const },
    ...(page.cursor ? { where: { id: { lt: page.cursor } } } : {}),
  };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}
