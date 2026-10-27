import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Messages de la facturation mensuelle des contrats d'entreprise (cahier des charges Nettoyage,
 * partie 10 ; ADR-025), en français. Les variables arrivent déjà mises en forme (dates, montants
 * en FCFA entiers) ; `first_name` est ajouté par le service à partir du compte du destinataire.
 *
 * Nature : `document` pour les trois messages (la facture et ses suites) → e-mail si l'adresse est
 * vérifiée (ADR-026), WhatsApp sinon ou en bascule. L'avertissement et la suspension pour impayés
 * restent les messages du Nettoyage (`cleaning.messages.ts`) : la facture impayée n'en reprend pas
 * les conséquences, elle désigne la facture et son montant.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const TEXT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;
const COUNT_OR_ZERO = /^(0|[1-9][0-9]{0,4})$/;
const INVOICE_NUMBER = /^FAC-[0-9]{4}-[0-9]{6}$/;
/** Raison sociale de l'organisation facturée ; vide pour un particulier ou une fiche inconnue. */
const ORGANIZATION_NAME = /^[^\n]{0,200}$/;

/** Moyens de règlement enregistrés au back-office (paiement en ligne au lot Paiement). */
const HOW_TO_PAY = "en espèces, par virement ou par Mobile Money auprès de l'équipe KSP";

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

/** Objet de l'e-mail, suivi de la raison sociale quand la facture appartient à une organisation. */
function subject(text: string, variables: Readonly<Record<string, string>>): string {
  const organization = variables['organization_name']?.trim();
  return organization ? `${text} — ${organization}` : text;
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

function template(
  code: string,
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
): EventTemplateDefinition {
  return { code, channels: ['whatsapp', 'email'], secret: false, kind: 'document', variables, render };
}

export const BILLING_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'billing.invoice_issued.customer',
    {
      first_name: FIRST_NAME,
      organization_name: ORGANIZATION_NAME,
      invoice_number: INVOICE_NUMBER,
      period: TEXT,
      total: AMOUNT,
      due_on: TEXT,
      link: LINK,
    },
    (v) => ({
      subject: subject(`Votre facture ${v['invoice_number']}`, v),
      text: lines(
        greeting(v),
        `Votre facture ${v['invoice_number']} est disponible : période ${v['period']}, ` +
          `montant ${v['total']}.`,
        `Elle est à régler avant le ${v['due_on']}, ${HOW_TO_PAY}.`,
        `Consultez-la dans Mon espace KSP, rubrique « Mes factures » : ${v['link']}`,
      ),
    }),
  ),
  template(
    'billing.invoice_overdue.customer',
    {
      first_name: FIRST_NAME,
      organization_name: ORGANIZATION_NAME,
      invoice_number: INVOICE_NUMBER,
      total: AMOUNT,
      due_on: TEXT,
      link: LINK,
    },
    (v) => ({
      subject: subject(`Facture ${v['invoice_number']} impayée`, v),
      text: lines(
        greeting(v),
        `Votre facture ${v['invoice_number']} de ${v['total']}, à régler avant le ${v['due_on']}, ` +
          "n'est pas entièrement réglée : elle est désormais impayée.",
        `Merci de la régler au plus vite, ${HOW_TO_PAY}.`,
        `Détail et règlements reçus dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'billing.invoice_paid.customer',
    {
      first_name: FIRST_NAME,
      organization_name: ORGANIZATION_NAME,
      invoice_number: INVOICE_NUMBER,
      total: AMOUNT,
      paid_on: TEXT,
      unpaid_left: COUNT_OR_ZERO,
      link: LINK,
    },
    (v) => ({
      subject: subject(`Facture ${v['invoice_number']} réglée`, v),
      text: lines(
        greeting(v),
        `Merci pour votre règlement : votre facture ${v['invoice_number']} de ${v['total']} ` +
          `est réglée en totalité depuis le ${v['paid_on']}.`,
        ...(v['unpaid_left'] !== '0'
          ? [
              v['unpaid_left'] === '1'
                ? 'Il reste 1 facture impayée sur ce contrat.'
                : `Il reste ${v['unpaid_left']} factures impayées sur ce contrat.`,
            ]
          : []),
        `Détail : ${v['link']}`,
      ),
    }),
  ),
];
