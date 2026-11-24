import { type CleaningEventPayloads } from '@ksp/contracts';
import { type InvoiceOrganization } from '../../domain/invoice';
import {
  type BillableSession,
  DEFAULT_REMINDER_OFFSETS,
  draftMonthlyInvoice,
  dueReminder,
  isPastDueV2,
  lastClosedMonth,
  missedLineKind,
} from '../../domain/monthly-invoice';
import { balance } from '../../domain/invoice';
import { issuedEvent, overdueEvent } from './invoice-events';
import { type MonthlyBillingDeps } from './ports';

/** Consommateur inscrit dans l'inbox pour les événements de séance (lot F). */
export const SESSION_EVENTS_CONSUMER = 'billing.monthly';

/** R-PE-01, UC-NT-47 : lots de 200 au plus par passage ; la suite au passage suivant. */
export const MONTHLY_BATCH_SIZE = 200;

type SessionEvent =
  | { type: 'cleaning.session.completed'; payload: CleaningEventPayloads['cleaning.session.completed'] }
  | { type: 'cleaning.session.missed'; payload: CleaningEventPayloads['cleaning.session.missed'] };

/**
 * Séance réalisée ou manquée d'une organisation (`cleaning.session.completed`, `.missed`) : gardée
 * comme ligne facturable du mois de sa réalisation (ou de son absence constatée). Le montant dû
 * vient de l'événement : billing ne rappelle jamais cleaning (15.5). Une séance d'un particulier est
 * ignorée : elle est payée une par une (partie 11.1).
 */
export class RecordBillableSessionUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(input: { eventId: string } & SessionEvent): Promise<'recorded' | 'duplicate' | 'ignored'> {
    const { payload } = input;
    if (payload.payerKind !== 'organization' || !payload.organizationId) return 'ignored';
    const missed = input.type === 'cleaning.session.missed' ? input.payload : null;
    const session: BillableSession = {
      sessionId: payload.sessionId,
      organizationId: payload.organizationId,
      customerId: payload.customerId,
      programId: payload.programId,
      programNumber: payload.programNumber,
      placeId: payload.placeId,
      rank: payload.rank,
      sessionsCount: payload.sessionsCount,
      kind: missed ? missedLineKind(missed.cause) : 'session',
      occurredAt: new Date(
        missed
          ? missed.missedAt
          : (payload as CleaningEventPayloads['cleaning.session.completed']).completedAt,
      ),
      amountDue: payload.amountDue.amount,
      visitFeeDeduction: payload.visitFeeDeduction.amount,
      invoiceId: null,
    };
    return this.deps.monthly.recordBillableSession(session, {
      eventId: input.eventId,
      consumer: `${SESSION_EVENTS_CONSUMER}.${input.type}`,
    });
  }
}

/**
 * Tâche planifiée du 1er du mois (R-PE-01, R-PE-02, R-PE-03) : une facture par organisation pour
 * le dernier mois terminé (heure du Bénin), avec ses séances non facturées. Idempotente : une
 * seule facture par organisation et par mois, même avec plusieurs passages ou répliques.
 *
 * En-tête figé à l'émission, lu dans identity : jamais de facture sans en-tête. identity
 * indisponible → erreur, rien n'est émis, le passage suivant réessaie ; organisation introuvable →
 * reportée (`deferredOrganizationIds`, alerte journalisée par la tâche), les autres sont facturées.
 */
export class IssueMonthlyInvoicesUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(): Promise<{ issued: number; deferredOrganizationIds: string[] }> {
    const now = this.deps.clock.now();
    const month = lastClosedMonth(now);
    const organizationIds = await this.deps.monthly.listOrganizationsToInvoice(month, MONTHLY_BATCH_SIZE);
    if (organizationIds.length === 0) return { issued: 0, deferredOrganizationIds: [] };
    const headers = await this.headers(organizationIds);
    const { paymentTermDays } = await this.deps.settings.get();
    let issued = 0;
    const deferredOrganizationIds: string[] = [];
    for (const organizationId of organizationIds) {
      const organization = headers.get(organizationId.toLowerCase());
      if (!organization) {
        deferredOrganizationIds.push(organizationId);
        continue;
      }
      const invoice = await this.deps.monthly.issueMonthly(
        organizationId,
        month,
        (sessions) =>
          sessions.length === 0
            ? null
            : draftMonthlyInvoice({
                id: this.deps.ids.next(),
                organizationId,
                month,
                sessions,
                organization,
                now,
                paymentTermDays,
              }),
        (created) => [issuedEvent(created)],
      );
      if (invoice) issued += 1;
    }
    return { issued, deferredOrganizationIds };
  }

  private async headers(organizationIds: readonly string[]): Promise<Map<string, InvoiceOrganization>> {
    const profiles = await this.deps.organizations.findByIds(organizationIds);
    return new Map(
      profiles.map(({ id, legalName, address, ifu, rccm }) => [
        id.toLowerCase(),
        { legalName, address, ifu, rccm },
      ]),
    );
  }
}

/**
 * R-PE-06 : une facture v2 est « impayée » le lendemain de son échéance
 * (`billing.invoice.overdue` v2, avec les impayées du titulaire, celle-ci comprise).
 */
export class MarkMonthlyInvoicesOverdueUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(): Promise<{ overdue: number }> {
    const now = this.deps.clock.now();
    let overdue = 0;
    for (const invoice of await this.deps.monthly.listPendingPastDue(now, MONTHLY_BATCH_SIZE)) {
      if (!isPastDueV2(invoice, now)) continue;
      const updated = { ...invoice, status: 'overdue' as const };
      if (await this.deps.invoices.markOverdue(updated, (count) => [overdueEvent(updated, count)]))
        overdue += 1;
    }
    return { overdue };
  }
}

/**
 * R-PE-05 : relances automatiques des factures mensuelles ouvertes, 3 jours avant l'échéance, le
 * jour même, 3 et 7 jours après (`billing.invoice.reminded`, une fois par facture et par décalage).
 */
export class SendInvoiceRemindersUseCase {
  constructor(
    private readonly deps: MonthlyBillingDeps,
    private readonly offsets: readonly number[] = DEFAULT_REMINDER_OFFSETS,
  ) {}

  async execute(): Promise<{ reminded: number }> {
    const now = this.deps.clock.now();
    let reminded = 0;
    for (const { invoice, handled } of await this.deps.monthly.listOpenForReminders(
      now,
      this.offsets,
      MONTHLY_BATCH_SIZE,
    )) {
      const { offset, skipped } = dueReminder(invoice, this.offsets, new Set(handled), now);
      if (offset === null) continue;
      const sent = await this.deps.monthly.recordReminder(invoice.id, offset, skipped, now, [
        {
          type: 'billing.invoice.reminded',
          payload: {
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            customerId: invoice.customerId,
            organizationId: invoice.organizationId,
            total: { amount: invoice.total, currency: 'XOF' },
            balance: { amount: balance(invoice), currency: 'XOF' },
            dueAt: invoice.dueAt.toISOString(),
            offsetDays: offset,
            remindedAt: now.toISOString(),
          },
        },
      ]);
      if (sent) reminded += 1;
    }
    return { reminded };
  }
}

/**
 * Compte des factures impayées d'une organisation tenu par billing (R-PE-06), publié à titre
 * d'information dans `holderOverdueCount` : cleaning tient son propre compte (RV-87).
 */
export class CountOrganizationUnpaidInvoicesUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(organizationId: string): Promise<number> {
    return this.deps.monthly.countOverdueForOrganization(organizationId);
  }
}
