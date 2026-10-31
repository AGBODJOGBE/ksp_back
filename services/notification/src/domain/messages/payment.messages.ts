import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Reçu d'un paiement en ligne par Mobile Money (ADR-031), en français. Les variables arrivent déjà
 * mises en forme (date, montant en FCFA entiers) ; `first_name` est ajouté par le service à partir
 * du compte du payeur. Nature `document` : e-mail si l'adresse est vérifiée (ADR-026), WhatsApp
 * sinon ou en bascule.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const TEXT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;
/** Référence de la transaction chez le prestataire (ou du paiement KSP), sans espace. */
const REFERENCE = /^[A-Za-z0-9_.-]{1,100}$/;
/** Raison sociale de l'organisation payeuse ; vide pour un particulier ou une fiche inconnue. */
const ORGANIZATION_NAME = /^[^\n]{0,200}$/;

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

function subject(text: string, variables: Readonly<Record<string, string>>): string {
  const organization = variables['organization_name']?.trim();
  return organization ? `${text} — ${organization}` : text;
}

function render(v: Readonly<Record<string, string>>): RenderedMessage {
  return {
    subject: subject(`Reçu de paiement — ${v['amount']}`, v),
    text: [
      greeting(v),
      `Nous avons bien reçu votre paiement Mobile Money de ${v['amount']} pour ${v['object']}, ` +
        `le ${v['paid_on']}.`,
      `Référence de la transaction : ${v['reference']}.`,
      `Détail dans Mon espace KSP : ${v['link']}`,
    ].join('\n'),
  };
}

export const PAYMENT_TEMPLATES: readonly EventTemplateDefinition[] = [
  {
    code: 'payment.receipt.customer',
    channels: ['whatsapp', 'email'],
    secret: false,
    kind: 'document',
    variables: {
      first_name: FIRST_NAME,
      organization_name: ORGANIZATION_NAME,
      amount: AMOUNT,
      object: TEXT,
      paid_on: TEXT,
      reference: REFERENCE,
      link: LINK,
    },
    render,
  },
];
