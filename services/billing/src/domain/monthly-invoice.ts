import { beninDay, beninMidnight } from './contract';
import {
  balance,
  dueDate,
  type Invoice,
  type InvoiceLine,
  type InvoiceLineKind,
  type InvoiceOrganization,
} from './invoice';

/**
 * Facture mensuelle d'une organisation (lot F ; CDC Nettoyage v2, partie 11.2 ; ADR-055 décision 5).
 *
 * - R-PE-01 : le 1er de chaque mois, une facture par organisation pour le mois écoulé, avec toutes
 *   les séances réalisées et les séances manquées facturées, groupées par programme et par lieu,
 *   avec la date de chaque séance. Pas de prorata : on facture ce qui a été fait. Le mois d'une
 *   séance est le mois civil (Africa/Porto-Novo, UTC+1 sans heure d'été) de sa réalisation, ou de
 *   son absence constatée pour une séance manquée (RV-92) ; l'année du numéro est celle de la
 *   période facturée (`invoiceYear`).
 * - R-PE-07 : une séance arrivée après l'émission de la facture de son mois part sur la facture
 *   suivante : une facture prend toutes les séances non facturées réalisées avant la fin de sa
 *   période.
 * - R-FV-05 (RV-96) : les frais de visite déduits, portés par l'événement de séance, deviennent une
 *   ligne négative juste après la séance qui les porte.
 * - R-PE-03 : échéance = émission + délai de règlement (10 jours par défaut). R-PE-06 : la facture
 *   est « impayée » le lendemain de son échéance (jour civil du Bénin).
 * - R-PE-05 : relances 3 jours avant l'échéance, le jour même, 3 et 7 jours après.
 */

/** Ligne facturable apprise par `cleaning.session.completed` ou `cleaning.session.missed`. */
export type BillableLineKind = Extract<InvoiceLineKind, 'session' | 'missed_session' | 'late_cancellation'>;

export interface BillableSession {
  sessionId: string;
  organizationId: string;
  /** Compte du client (titulaire ou auteur de la demande). */
  customerId: string;
  programId: string;
  programNumber: string;
  placeId: string;
  rank: number;
  sessionsCount: number;
  kind: BillableLineKind;
  /** Réalisation, ou absence constatée pour une séance manquée : fixe le mois facturé. */
  occurredAt: Date;
  /** Montant dû après déduction des frais de visite (entier XOF, jamais négatif). */
  amountDue: number;
  /** Frais de visite déduits de cette séance (ligne négative), 0 sinon. */
  visitFeeDeduction: number;
  /** Facture qui porte la séance ; null tant qu'elle n'est pas facturée. */
  invoiceId: string | null;
}

/** Nature de la ligne d'une séance manquée : annulation tardive ou absence (R-EX-02, partie 12). */
export function missedLineKind(cause: string): BillableLineKind {
  return cause === 'late_cancellation' ? 'late_cancellation' : 'missed_session';
}

const DAY_MS = 86_400_000;

/** Mois civil facturé : bornes à minuit, heure du Bénin ; `end` est exclusive. */
export interface BillingMonth {
  year: number;
  /** 1 à 12. */
  month: number;
  start: Date;
  end: Date;
}

/** Mois civil (Bénin) d'une année et d'un mois donnés ; mois hors 1..12 : reportés sur l'année. */
export function billingMonth(year: number, month: number): BillingMonth {
  const first = Date.UTC(year, month - 1, 1);
  const next = Date.UTC(year, month, 1);
  const date = new Date(first);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    start: beninMidnight(first / DAY_MS),
    end: beninMidnight(next / DAY_MS),
  };
}

/** Mois civil au Bénin d'un instant (RV-92 : le 31 à 23:30 UTC est déjà le mois suivant). */
export function monthOf(date: Date): BillingMonth {
  const local = new Date(beninDay(date) * DAY_MS);
  return billingMonth(local.getUTCFullYear(), local.getUTCMonth() + 1);
}

/** Dernier mois terminé à `now` : celui que le passage du 1er facture. */
export function lastClosedMonth(now: Date): BillingMonth {
  const current = monthOf(now);
  return billingMonth(current.year, current.month - 1);
}

/** Jour civil du Bénin, AAAA-MM-JJ. */
export function beninDate(date: Date): string {
  return new Date(beninDay(date) * DAY_MS).toISOString().slice(0, 10);
}

const LABELS: Record<BillableLineKind, string> = {
  session: 'Séance',
  missed_session: 'Séance manquée',
  late_cancellation: 'Annulation tardive, séance',
};

function frenchDate(day: string): string {
  const [year, month, date] = day.split('-');
  return `${date}/${month}/${year}`;
}

/**
 * Séances de la facture, dans l'ordre d'affichage : par programme, puis par lieu, puis par date
 * et par rang (R-PE-01).
 */
export function orderForInvoice(sessions: readonly BillableSession[]): BillableSession[] {
  return [...sessions].sort(
    (a, b) =>
      a.programNumber.localeCompare(b.programNumber) ||
      a.placeId.localeCompare(b.placeId) ||
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      a.rank - b.rank,
  );
}

/**
 * Lignes d'une facture mensuelle : une ligne par séance, au montant dû avant déduction, suivie de
 * la ligne négative des frais de visite qu'elle porte. Total des lignes = somme des montants dus.
 * Le libellé du lieu n'est pas connu de billing (l'événement ne porte que `placeId`) : `placeLabel`
 * reste absent, le regroupement par lieu suit l'ordre des lignes.
 */
export function monthlyInvoiceLines(sessions: readonly BillableSession[]): InvoiceLine[] {
  return orderForInvoice(sessions).flatMap((session) => {
    const serviceDate = beninDate(session.occurredAt);
    const gross = session.amountDue + session.visitFeeDeduction;
    const common = {
      serviceDate,
      programNumber: session.programNumber,
      sourceObjectId: session.sessionId,
    };
    const line: InvoiceLine = {
      label:
        `${LABELS[session.kind]} ${session.rank}/${session.sessionsCount} du ${frenchDate(serviceDate)} — ` +
        session.programNumber,
      quantity: 1,
      unitPrice: gross,
      amount: gross,
      kind: session.kind,
      ...common,
    };
    if (session.visitFeeDeduction <= 0) return [line];
    const deduction: InvoiceLine = {
      label: `Frais de visite déduits — ${session.programNumber}`,
      quantity: 1,
      unitPrice: -session.visitFeeDeduction,
      amount: -session.visitFeeDeduction,
      kind: 'visit_fee_deduction',
      ...common,
    };
    return [line, deduction];
  });
}

/** Séances à porter sur la facture d'un mois : non facturées, réalisées avant la fin du mois. */
export function sessionsToInvoice(
  sessions: readonly BillableSession[],
  month: Pick<BillingMonth, 'end'>,
): BillableSession[] {
  return sessions.filter(
    (session) => session.invoiceId === null && session.occurredAt.getTime() < month.end.getTime(),
  );
}

/**
 * Facture mensuelle à émettre (sans numéro : il est tiré dans la transaction de l'émission).
 * Total nul (frais de visite qui couvrent tout) : émise « payée ». Client de la facture : celui de
 * la première séance (interprétation : il bloque la suppression de son compte tant qu'elle n'est
 * pas réglée, comme en v1).
 */
export function draftMonthlyInvoice(input: {
  id: string;
  organizationId: string;
  month: BillingMonth;
  sessions: readonly BillableSession[];
  organization: InvoiceOrganization;
  now: Date;
  paymentTermDays: number;
}): Omit<Invoice, 'number'> {
  const sessions = orderForInvoice(input.sessions);
  const first = sessions[0];
  if (!first) throw new Error('Facture mensuelle sans séance.');
  const lines = monthlyInvoiceLines(sessions);
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const free = total === 0;
  return {
    id: input.id,
    status: free ? 'paid' : 'pending_payment',
    contractId: null,
    customerId: first.customerId,
    organizationId: input.organizationId,
    source: 'cleaning',
    periodIndex: null,
    periodStart: input.month.start,
    periodEnd: input.month.end,
    lines,
    total,
    issuedAt: input.now,
    dueAt: dueDate(input.now, input.paymentTermDays),
    paidAt: free ? input.now : null,
    payments: [],
    organization: input.organization,
    version: 0,
    kind: 'monthly',
    settledBy: free ? 'payment' : null,
    creditedAmount: 0,
    creditNotesTotal: 0,
  };
}

/** R-PE-06 : « impayée » le lendemain de l'échéance, à minuit (heure du Bénin). */
export function overdueFrom(dueAt: Date): Date {
  return beninMidnight(beninDay(dueAt) + 1);
}

/** Facture v2 à passer « impayée » : encore en attente, reste dû positif, lendemain de l'échéance. */
export function isPastDueV2(
  invoice: Pick<Invoice, 'status' | 'dueAt' | 'total' | 'payments' | 'creditedAmount'>,
  now: Date,
): boolean {
  return (
    invoice.status === 'pending_payment' &&
    balance(invoice) > 0 &&
    now.getTime() >= overdueFrom(invoice.dueAt).getTime()
  );
}

/** R-PE-05 : décalages par défaut des relances, en jours par rapport à l'échéance. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [-3, 0, 3, 7];

/** Début (minuit, heure du Bénin) du jour de relance `offset` d'une échéance. */
export function reminderAt(dueAt: Date, offset: number): Date {
  return beninMidnight(beninDay(dueAt) + offset);
}

/**
 * Relance à envoyer maintenant : la plus récente des relances échues et pas encore traitées. Une
 * relance plus ancienne et jamais envoyée (tâche arrêtée plusieurs jours) est sautée : le client ne
 * reçoit pas deux relances d'un coup. Rien pour une facture soldée, annulée ou sans reste dû.
 */
export function dueReminder(
  invoice: Pick<Invoice, 'status' | 'dueAt' | 'total' | 'payments' | 'creditedAmount'>,
  offsets: readonly number[],
  handled: ReadonlySet<number>,
  now: Date,
): { offset: number | null; skipped: number[] } {
  const open = invoice.status === 'pending_payment' || invoice.status === 'overdue';
  if (!open || balance(invoice) === 0) return { offset: null, skipped: [] };
  const due = [...new Set(offsets)]
    .filter((offset) => !handled.has(offset) && reminderAt(invoice.dueAt, offset).getTime() <= now.getTime())
    .sort((a, b) => a - b);
  const offset = due.at(-1) ?? null;
  return { offset, skipped: due.slice(0, -1) };
}

/** Décalages valides : entiers de −30 à 60, sans doublon (billing.proto, ReminderSchedule). */
export function reminderOffsetsProblems(offsets: readonly number[]): string[] {
  const valid = offsets.every((offset) => Number.isInteger(offset) && offset >= -30 && offset <= 60);
  return valid && new Set(offsets).size === offsets.length ? [] : ['reminders'];
}

/**
 * Factures comptées avec `reference` dans les impayés publiés : celles du même contrat (v1), ou
 * celles du même titulaire (v2 : l'organisation, sinon le client en personnel).
 */
export function inOverdueScope(
  reference: Pick<Invoice, 'contractId' | 'kind' | 'organizationId' | 'customerId'>,
  other: Pick<Invoice, 'contractId' | 'kind' | 'organizationId' | 'customerId'>,
): boolean {
  if (!reference.kind) return reference.contractId !== null && other.contractId === reference.contractId;
  if (!other.kind) return false;
  return reference.organizationId
    ? other.organizationId === reference.organizationId
    : other.organizationId === null && other.customerId === reference.customerId;
}
