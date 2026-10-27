import { type BillingEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';
import { eventDate } from './rule-dates';

/**
 * Messages des événements de la facturation (CDC Nettoyage, partie 10 ; ADR-025) : facture émise,
 * facture impayée, facture réglée.
 *
 * Destinataire : le compte client qui porte le contrat facturé (`customerId`) : WhatsApp et
 * notification dans l'espace KSP. Facture d'une organisation (`organizationId`) : l'e-mail part à
 * l'e-mail de facturation vérifié de l'organisation ; sans lui, à l'adresse vérifiée du compte
 * client (ADR-026) ; sinon aucun e-mail (WhatsApp, et la facture reste dans l'espace KSP). La
 * raison sociale (`organization_name`, vide par défaut) est ajoutée par le service quand la fiche de
 * l'organisation est connue : elle figure dans l'objet de l'e-mail, pas dans le modèle WhatsApp.
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
  event: { customerId: string; organizationId: string | null },
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return {
    userId: event.customerId,
    templateCode,
    variables: { ...variables, organization_name: '', link },
    link,
    ...(event.organizationId ? { billingOrganizationId: event.organizationId } : {}),
  };
}

export const BILLING_RULES: { readonly [T in BillingEventType]: EventRule<T> } = {
  'billing.invoice.issued': (event, context) => [
    customer(event, 'billing.invoice_issued.customer', invoiceLink(context, event.invoiceId), {
      invoice_number: event.invoiceNumber,
      period: period(event.periodStart, event.periodEnd, context),
      total: formatXof(event.total.amount),
      due_on: eventDate(event.dueAt, context),
    }),
  ],

  'billing.invoice.overdue': (event, context) => [
    customer(event, 'billing.invoice_overdue.customer', invoiceLink(context, event.invoiceId), {
      invoice_number: event.invoiceNumber,
      total: formatXof(event.total.amount),
      due_on: eventDate(event.dueAt, context),
    }),
  ],

  'billing.invoice.paid': (event, context) => [
    customer(event, 'billing.invoice_paid.customer', invoiceLink(context, event.invoiceId), {
      invoice_number: event.invoiceNumber,
      total: formatXof(event.total.amount),
      paid_on: eventDate(event.paidAt, context),
      unpaid_left: String(event.overdueCount),
    }),
  ],
};
