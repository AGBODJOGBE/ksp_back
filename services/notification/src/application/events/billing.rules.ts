import { type BillingEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';
import { eventDate } from './rule-dates';

/**
 * Messages des événements de la facturation (CDC Nettoyage, partie 10 ; ADR-025) : facture émise,
 * facture impayée, facture réglée.
 *
 * Destinataire : le compte client qui porte le contrat facturé (`customerId`). identity n'a pas
 * encore d'organisations : l'entreprise reçoit ses factures sur ce compte. L'e-mail ne part que
 * vers une adresse vérifiée (ADR-026, appliqué par l'annuaire des destinataires) ; sinon WhatsApp,
 * et la notification reste dans l'espace KSP.
 *
 * Lien : la facture dans « Mes factures » du portail, /mon-espace/factures/<invoiceId>.
 */

function invoiceLink(context: RuleContext, invoiceId: string): string {
  return `${context.portalBaseUrl}/mon-espace/factures/${encodeURIComponent(invoiceId)}`;
}

/**
 * Période facturée « du 1 novembre 2026 au 30 novembre 2026 ». La fin publiée par billing est
 * exclue (minuit, heure du Bénin, du lendemain du dernier jour facturé) : le dernier jour écrit
 * est celui qui la précède.
 */
function period(startIso: string, endIso: string, context: RuleContext): string {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!(end > start)) throw new Error(`période illisible dans l'événement : ${startIso} – ${endIso}`);
  const lastDay = new Date(Math.max(start, end - 1)).toISOString();
  return `du ${eventDate(startIso, context)} au ${eventDate(lastDay, context)}`;
}

function customer(
  userId: string,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return { userId, templateCode, variables: { ...variables, link }, link };
}

export const BILLING_RULES: { readonly [T in BillingEventType]: EventRule<T> } = {
  'billing.invoice.issued': (event, context) => [
    customer(event.customerId, 'billing.invoice_issued.customer', invoiceLink(context, event.invoiceId), {
      invoice_number: event.invoiceNumber,
      period: period(event.periodStart, event.periodEnd, context),
      total: formatXof(event.total.amount),
      due_on: eventDate(event.dueAt, context),
    }),
  ],

  'billing.invoice.overdue': (event, context) => [
    customer(event.customerId, 'billing.invoice_overdue.customer', invoiceLink(context, event.invoiceId), {
      invoice_number: event.invoiceNumber,
      total: formatXof(event.total.amount),
      due_on: eventDate(event.dueAt, context),
    }),
  ],

  'billing.invoice.paid': (event, context) => [
    customer(event.customerId, 'billing.invoice_paid.customer', invoiceLink(context, event.invoiceId), {
      invoice_number: event.invoiceNumber,
      total: formatXof(event.total.amount),
      paid_on: eventDate(event.paidAt, context),
      unpaid_left: String(event.overdueCount),
    }),
  ],
};
