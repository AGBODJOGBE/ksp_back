import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Messages des comptes entreprise (ADR-027), en français : demande à valider pour l'équipe KSP,
 * décision (validation, refus, suspension, réactivation) pour le client qui a fait la demande. `first_name` est ajouté par
 * le service à partir du compte du destinataire (vide s'il n'a pas renseigné son nom).
 *
 * Nature : `short` (message court transactionnel) → WhatsApp, e-mail en bascule si l'adresse est
 * vérifiée ; la notification reste aussi dans l'espace KSP.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const LEGAL_NAME = /^[^\n]{1,200}$/;
const REASON = /^[^\n]{1,500}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

function template(
  code: string,
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
): EventTemplateDefinition {
  return { code, channels: ['whatsapp', 'email'], secret: false, kind: 'short', variables, render };
}

export const ORGANIZATION_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'identity.organization_requested.team',
    { first_name: FIRST_NAME, legal_name: LEGAL_NAME, organization_id: UUID },
    (v) => ({
      subject: 'Nouvelle demande de compte entreprise',
      text: lines(
        greeting(v),
        `Une nouvelle demande de compte entreprise attend votre validation : ${v['legal_name']}.`,
        `Contrôlez l'IFU et la fiche dans le back-office KSP, rubrique « Comptes entreprise » ` +
          `(référence ${v['organization_id']}).`,
      ),
    }),
  ),
  template(
    'identity.organization_validated.customer',
    { first_name: FIRST_NAME, legal_name: LEGAL_NAME, link: LINK },
    (v) => ({
      subject: 'Votre compte entreprise est validé',
      text: lines(
        greeting(v),
        `Bonne nouvelle : le compte entreprise ${v['legal_name']} est validé par KSP.`,
        "Choisissez l'entreprise dans Mon espace KSP pour faire vos demandes et recevoir vos factures " +
          `à son nom : ${v['link']}`,
      ),
    }),
  ),
  template(
    'identity.organization_rejected.customer',
    { first_name: FIRST_NAME, legal_name: LEGAL_NAME, reason: REASON, link: LINK },
    (v) => ({
      subject: "Votre demande de compte entreprise n'a pas été validée",
      text: lines(
        greeting(v),
        `Nous n'avons pas pu valider le compte entreprise ${v['legal_name']}.`,
        `Motif : ${v['reason']}`,
        `Vous pouvez faire une nouvelle demande depuis Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'identity.organization_suspended.customer',
    { first_name: FIRST_NAME, legal_name: LEGAL_NAME, reason: REASON, link: LINK },
    (v) => ({
      subject: 'Votre compte entreprise est suspendu',
      text: lines(
        greeting(v),
        `KSP a suspendu le compte entreprise ${v['legal_name']}.`,
        `Motif : ${v['reason']}`,
        `Vous ne pouvez plus l'utiliser dans Mon espace KSP jusqu'à sa réactivation : ${v['link']}`,
      ),
    }),
  ),
  template(
    'identity.organization_reactivated.customer',
    { first_name: FIRST_NAME, legal_name: LEGAL_NAME, link: LINK },
    (v) => ({
      subject: 'Votre compte entreprise est réactivé',
      text: lines(
        greeting(v),
        `Le compte entreprise ${v['legal_name']} est de nouveau actif.`,
        `Choisissez l'entreprise dans Mon espace KSP pour l'utiliser : ${v['link']}`,
      ),
    }),
  ),
];
