import { Injectable } from '@nestjs/common';
import { type MonthlyInvoiceRepository } from '../../application/monthly/ports';
import { type OutboxMessage } from '../../application/ports';
import { type CreditNote, creditNoteYear, formatCreditNoteNumber } from '../../domain/credit-note';
import { formatInvoiceNumber, type Invoice, invoiceYear } from '../../domain/invoice';
import { type BillableSession, type BillingMonth } from '../../domain/monthly-invoice';
import { PrismaService } from '../prisma/prisma.service';
import {
  INVOICE_INCLUDE,
  invoiceOrganizationColumns,
  json,
  toInvoice,
  type Tx,
  writeEvents,
} from './mappers';
import { overdueScopeWhere, toBillableSession, toCreditNote } from './monthly-mappers';

const DAY_MS = 86_400_000;

/**
 * Dépôt du lot F : séances facturables, facture mensuelle, relances, avoirs, annulation. Chaque
 * écriture et ses événements partent dans la même transaction (outbox) ; l'émission d'une facture
 * mensuelle est sérialisée par un verrou consultatif de l'organisation (deux répliques de la tâche
 * ne facturent pas deux fois), et l'index unique partiel (organisation, mois) le garantit en base.
 */
@Injectable()
export class PrismaMonthlyInvoiceRepository implements MonthlyInvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  recordBillableSession(
    session: BillableSession,
    inbox: { eventId: string; consumer: string },
  ): Promise<'recorded' | 'duplicate'> {
    return this.prisma.$transaction(async (tx) => {
      const marked = await tx.$executeRawUnsafe(
        'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
          'ON CONFLICT DO NOTHING',
        inbox.eventId,
        inbox.consumer,
      );
      if (marked === 0) return 'duplicate' as const;
      const { count } = await tx.billableSession.createMany({
        data: [
          {
            sessionId: session.sessionId,
            organizationId: session.organizationId,
            customerId: session.customerId,
            programId: session.programId,
            programNumber: session.programNumber,
            placeId: session.placeId,
            rank: session.rank,
            sessionsCount: session.sessionsCount,
            kind: session.kind,
            occurredAt: session.occurredAt,
            amountDue: session.amountDue,
            visitFeeDeduction: session.visitFeeDeduction,
            invoiceId: null,
            recordedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      return count === 0 ? ('duplicate' as const) : ('recorded' as const);
    });
  }

  async listOrganizationsToInvoice(month: BillingMonth, limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ organization_id: string }[]>(
      'SELECT DISTINCT b.organization_id::text AS organization_id FROM billable_sessions b ' +
        'WHERE b.invoice_id IS NULL AND b.occurred_at < $1 ' +
        "AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.kind = 'monthly' " +
        'AND i.organization_id = b.organization_id AND i.period_start = $2) ' +
        'ORDER BY 1 LIMIT $3',
      month.end,
      month.start,
      limit,
    );
    return rows.map((row) => row.organization_id);
  }

  issueMonthly(
    organizationId: string,
    month: BillingMonth,
    draft: (sessions: BillableSession[]) => Omit<Invoice, 'number'> | null,
    events: (invoice: Invoice) => OutboxMessage[],
  ): Promise<Invoice | null> {
    return this.prisma.$transaction(async (tx) => {
      // Verrou de l'organisation : deux émissions simultanées du même mois sont sérialisées.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('billing.monthly_invoice:' || $1::text))",
        organizationId,
      );
      const existing = await tx.invoice.findFirst({
        where: { kind: 'monthly', organizationId, periodStart: month.start },
        select: { id: true },
      });
      if (existing) return null;
      const rows = await tx.billableSession.findMany({
        where: { organizationId, invoiceId: null, occurredAt: { lt: month.end } },
        orderBy: { occurredAt: 'asc' },
      });
      const built = draft(rows.map(toBillableSession));
      if (!built) return null;
      // Numéro tiré dans la même transaction (aucun trou), année de la période facturée (RV-92).
      const year = invoiceYear(built);
      const [counter] = await tx.$queryRawUnsafe<{ last_number: number }[]>(
        'INSERT INTO invoice_counters (year, last_number) VALUES ($1, 1) ' +
          'ON CONFLICT (year) DO UPDATE SET last_number = invoice_counters.last_number + 1 ' +
          'RETURNING last_number',
        year,
      );
      const invoice: Invoice = { ...built, number: formatInvoiceNumber(year, Number(counter!.last_number)) };
      await tx.invoice.create({
        data: {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          contractId: null,
          customerId: invoice.customerId,
          organizationId: invoice.organizationId,
          source: invoice.source,
          periodIndex: null,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          lines: json(invoice.lines),
          total: invoice.total,
          issuedAt: invoice.issuedAt,
          dueAt: invoice.dueAt,
          paidAt: invoice.paidAt,
          kind: invoice.kind ?? 'monthly',
          settledBy: invoice.settledBy ?? null,
          ...invoiceOrganizationColumns(invoice.organization),
        },
      });
      await tx.billableSession.updateMany({
        where: { sessionId: { in: rows.map((row) => row.sessionId) }, invoiceId: null },
        data: { invoiceId: invoice.id },
      });
      await writeEvents(tx, events(invoice));
      return invoice;
    });
  }

  async listPendingPastDue(now: Date, limit: number): Promise<Invoice[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { kind: { not: null }, status: 'pending_payment', dueAt: { lt: now } },
      include: INVOICE_INCLUDE,
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toInvoice);
  }

  async listOpenForReminders(
    now: Date,
    offsets: readonly number[],
    limit: number,
  ): Promise<{ invoice: Invoice; handled: number[] }[]> {
    if (offsets.length === 0) return [];
    // Première relance échue : échéance au plus tard maintenant − premier décalage (+ 1 jour de marge
    // pour le passage à minuit, heure du Bénin ; le domaine tranche au jour près).
    const latestDue = new Date(now.getTime() + (1 - Math.min(...offsets)) * DAY_MS);
    const ids = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      'SELECT i.id::text AS id FROM invoices i ' +
        "WHERE i.kind = 'monthly' AND i.status IN ('pending_payment', 'overdue') AND i.due_at <= $1 " +
        'AND (SELECT count(*) FROM invoice_reminders r WHERE r.invoice_id = i.id) < $2 ' +
        'ORDER BY i.due_at, i.id LIMIT $3',
      latestDue,
      offsets.length,
      limit,
    );
    if (ids.length === 0) return [];
    const rows = await this.prisma.invoice.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      include: { ...INVOICE_INCLUDE, reminders: { select: { offsetDays: true } } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ reminders, ...row }) => ({
      invoice: toInvoice(row),
      handled: reminders.map((reminder) => reminder.offsetDays),
    }));
  }

  recordReminder(
    invoiceId: string,
    offset: number,
    skipped: readonly number[],
    at: Date,
    events: OutboxMessage[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoiceReminder.createMany({
        data: [{ invoiceId, offsetDays: offset, sent: true, handledAt: at }],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await tx.invoiceReminder.createMany({
        data: skipped.map((offsetDays) => ({ invoiceId, offsetDays, sent: false, handledAt: at })),
        skipDuplicates: true,
      });
      await writeEvents(tx, events);
      return true;
    });
  }

  countOverdueForOrganization(organizationId: string): Promise<number> {
    return this.prisma.invoice.count({ where: { kind: { not: null }, organizationId, status: 'overdue' } });
  }

  async findCreditNoteByKey(issuedBy: string, idempotencyKey: string): Promise<CreditNote | null> {
    const row = await this.prisma.creditNote.findUnique({
      where: { issuedBy_idempotencyKey: { issuedBy, idempotencyKey } },
      include: { invoice: { select: { number: true } } },
    });
    return row ? toCreditNote(row) : null;
  }

  async listCreditNotes(invoiceId: string): Promise<CreditNote[]> {
    const rows = await this.prisma.creditNote.findMany({
      where: { invoiceId },
      include: { invoice: { select: { number: true } } },
      orderBy: { id: 'asc' },
    });
    return rows.map(toCreditNote);
  }

  async saveCreditNote(
    invoice: Invoice,
    note: Omit<CreditNote, 'number'>,
    events: (note: CreditNote, overdueCount: number) => OutboxMessage[],
  ): Promise<CreditNote | 'conflict'> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id: invoice.id, version: invoice.version },
        data: {
          status: invoice.status,
          paidAt: invoice.paidAt,
          settledBy: invoice.settledBy ?? null,
          creditedAmount: invoice.creditedAmount ?? 0,
          creditNotesTotal: invoice.creditNotesTotal ?? 0,
          version: { increment: 1 },
        },
      });
      if (count === 0) return 'conflict' as const;
      const year = creditNoteYear(note.issuedAt);
      const [counter] = await tx.$queryRawUnsafe<{ last_number: number }[]>(
        'INSERT INTO credit_note_counters (year, last_number) VALUES ($1, 1) ' +
          'ON CONFLICT (year) DO UPDATE SET last_number = credit_note_counters.last_number + 1 ' +
          'RETURNING last_number',
        year,
      );
      const saved: CreditNote = {
        ...note,
        number: formatCreditNoteNumber(year, Number(counter!.last_number)),
      };
      await tx.creditNote.create({
        data: {
          id: saved.id,
          number: saved.number,
          invoiceId: saved.invoiceId,
          customerId: saved.customerId,
          organizationId: saved.organizationId,
          lines: json(saved.lines),
          total: saved.total,
          reason: saved.reason,
          issuedBy: saved.issuedBy,
          issuedAt: saved.issuedAt,
          appliedToBalance: saved.appliedToBalance,
          creditedToWallet: saved.creditedToWallet,
          walletTransactionId: saved.walletTransactionId,
          sourceObjectType: saved.source?.objectType ?? null,
          sourceObjectId: saved.source?.objectId ?? null,
          idempotencyKey: saved.idempotencyKey,
        },
      });
      await writeEvents(tx, events(saved, await this.countOverdue(tx, invoice)));
      return saved;
    });
  }

  cancel(
    invoice: Invoice,
    releaseSessions: boolean,
    events: (overdueCount: number) => OutboxMessage[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id: invoice.id, version: invoice.version, status: { in: ['pending_payment', 'overdue'] } },
        data: {
          status: 'cancelled',
          settledBy: 'cancellation',
          paidAt: null,
          cancelledAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (count === 0) return false;
      if (releaseSessions) {
        await tx.billableSession.updateMany({ where: { invoiceId: invoice.id }, data: { invoiceId: null } });
      }
      await writeEvents(tx, events(await this.countOverdue(tx, invoice)));
      return true;
    });
  }

  private countOverdue(tx: Tx, invoice: Invoice): Promise<number> {
    return tx.invoice.count({ where: { ...overdueScopeWhere(invoice), status: 'overdue' } });
  }
}
