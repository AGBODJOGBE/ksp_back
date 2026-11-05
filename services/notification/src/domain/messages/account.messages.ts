import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Messages de la suppression du compte (UC-ID-11, ADR-036), en français : demande enregistrée
 * (date prévue, comment annuler) et annulation. Aucun message « suppression effectuée » : à
 * l'échéance, le compte est anonymisé et n'a plus de coordonnées ; la date est annoncée dès la
 * demande. `first_name` est ajouté par le service à partir du compte du destinataire.
 *
 * Nature : `short` (message court transactionnel) → WhatsApp, e-mail en bascule si l'adresse est
 * vérifiée ; la notification reste aussi dans l'espace KSP.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const DATE = /^[^\n]{1,80}$/;
const LINK = /^https?:\/\/\S{1,300}$/;

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

export const ACCOUNT_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'identity.account_deletion_requested.customer',
    { first_name: FIRST_NAME, scheduled_for: DATE, link: LINK },
    (v) => ({
      subject: 'Suppression de votre compte KSP demandée',
      text: lines(
        greeting(v),
        `Nous avons bien reçu votre demande : votre compte KSP sera supprimé le ${v['scheduled_for']}.`,
        "D'ici là, il est gelé et vous avez été déconnecté de tous vos appareils.",
        `Vous avez changé d'avis ? Reconnectez-vous avec votre numéro, puis annulez la suppression : ${v['link']}`,
        "Si vous n'êtes pas à l'origine de cette demande, reconnectez-vous et annulez-la sans attendre.",
      ),
    }),
  ),
  template('identity.account_deletion_cancelled.customer', { first_name: FIRST_NAME, link: LINK }, (v) => ({
    subject: 'Suppression de votre compte KSP annulée',
    text: lines(
      greeting(v),
      'La suppression de votre compte KSP est annulée : il est de nouveau actif.',
      `Retrouvez votre espace : ${v['link']}`,
    ),
  })),
];
