import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Messages du portefeuille prépayé (ADR-046), en français : paiement effectué depuis le portefeuille,
 * et crédit du portefeuille (remboursement, ou crédit de la finance). La recharge réussie a déjà son
 * message : le reçu du paiement Mobile Money (`payment.receipt.customer`). Les variables arrivent
 * mises en forme (montants en FCFA entiers) ; `first_name` est ajouté par le service.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;
/** Libellé du relevé : « Nettoyage de maison — acompte », « Facture FAC-2026-000042 », motif… */
const OBJECT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const ORGANIZATION_NAME = /^[^\n]{0,200}$/;

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

function subject(text: string, variables: Readonly<Record<string, string>>): string {
  const organization = variables['organization_name']?.trim();
  return organization ? `${text} — ${organization}` : text;
}

function template(
  code: string,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
): EventTemplateDefinition {
  return {
    code,
    channels: ['whatsapp', 'email'],
    secret: false,
    kind: 'short',
    variables: {
      first_name: FIRST_NAME,
      organization_name: ORGANIZATION_NAME,
      amount: AMOUNT,
      object: OBJECT,
      balance: AMOUNT,
      link: LINK,
    },
    render,
  };
}

export const WALLET_TEMPLATES: readonly EventTemplateDefinition[] = [
  template('wallet.payment.customer', (v) => ({
    subject: subject(`Paiement effectué depuis votre portefeuille — ${v['amount']}`, v),
    text: [
      greeting(v),
      `Un paiement de ${v['amount']} a été effectué depuis votre portefeuille KSP pour : ${v['object']}.`,
      `Solde restant : ${v['balance']}.`,
      `Détail dans Mon espace KSP : ${v['link']}`,
    ].join('\n'),
  })),
  template('wallet.credit.customer', (v) => ({
    subject: subject(`Portefeuille crédité — ${v['amount']}`, v),
    text: [
      greeting(v),
      `${v['amount']} ont été crédités sur votre portefeuille KSP : ${v['object']}.`,
      `Nouveau solde : ${v['balance']}.`,
      `Détail dans Mon espace KSP : ${v['link']}`,
    ].join('\n'),
  })),
];
