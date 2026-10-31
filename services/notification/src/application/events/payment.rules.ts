import { type PaymentEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { type EventRule } from './event-rules';
import { eventDate } from './rule-dates';

/**
 * Messages des paiements en ligne (ADR-031) : reçu au payeur quand le prestataire a confirmé le
 * paiement. L'échec (`payment.intent.failed`) n'envoie rien : le client le voit sur le portail, et
 * le montant reste à payer.
 *
 * Destinataire : le payeur (`customerId`), WhatsApp et notification dans l'espace KSP. Paiement
 * d'une facture d'organisation : l'e-mail part à l'e-mail de facturation vérifié de l'organisation,
 * sinon à l'adresse vérifiée du payeur (comme les factures, ADR-026 et ADR-028).
 *
 * Lien : la mission (/mon-espace/nettoyage/missions/<id>) ou la facture (/mon-espace/factures/<id>).
 */
export const PAYMENT_RULES: { readonly [T in PaymentEventType]?: EventRule<T> } = {
  'payment.intent.succeeded': (event, context) => {
    const invoice = event.subjectType === 'billing_invoice';
    const link = invoice
      ? `${context.portalBaseUrl}/mon-espace/factures/${encodeURIComponent(event.subjectId)}`
      : `${context.portalBaseUrl}/mon-espace/nettoyage/missions/${encodeURIComponent(event.subjectId)}`;
    const object = invoice
      ? `la facture ${event.subjectReference ?? ''}`.trim()
      : event.part === 'deposit'
        ? "l'acompte de votre prestation de nettoyage"
        : 'le solde de votre prestation de nettoyage';
    return [
      {
        userId: event.customerId,
        templateCode: 'payment.receipt.customer',
        variables: {
          amount: formatXof(event.amount.amount),
          object,
          paid_on: eventDate(event.succeededAt, context),
          reference: event.providerReference ?? event.paymentId,
          organization_name: '',
          link,
        },
        link,
        ...(event.organizationId ? { billingOrganizationId: event.organizationId } : {}),
      },
    ];
  },
};
