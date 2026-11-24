import { type TemplateDefinition } from '../template';

/**
 * Message du Nettoyage envoyé par appel direct (SendNotification), en français : l'invitation d'un
 * agent par l'admin (R-AG-02 du CDC Nettoyage v2). La personne invitée n'a pas encore de compte :
 * cleaning donne son numéro à l'appel, jamais dans un événement. Modèle secret : le lien porte
 * l'identifiant de l'invitation, ni le texte ni les variables ne sont conservés ni journalisés.
 */

/** Lien d'inscription de l'application agent, avec l'identifiant de l'invitation. */
const LINK = /^https?:\/\/\S{1,300}$/;
const DATE = /^[^\n]{1,40}$/;
const FIRST_NAME = /^[^\n]{1,100}$/;

export const CLEANING_DIRECT_TEMPLATES: readonly TemplateDefinition[] = [
  {
    // WhatsApp, puis SMS quand un prestataire SMS est configuré (ADR-021).
    code: 'cleaning.agent_invitation',
    channels: ['whatsapp', 'sms'],
    secret: true,
    variables: { link: LINK, expires_on: DATE },
    optionalVariables: { first_name: FIRST_NAME },
    render: (v) => ({
      subject: 'Invitation à devenir agent de nettoyage KSP',
      text: [
        `Bonjour ${v['first_name']?.trim() || 'Madame, Monsieur'},`,
        'Le Groupe KSP vous invite à vous inscrire comme agent de nettoyage.',
        `Ouvrez ce lien pour créer votre compte avec ce numéro de téléphone et déposer votre candidature : ${v['link'] ?? ''}`,
        `Cette invitation est valable jusqu'au ${v['expires_on'] ?? ''}.`,
        "Si vous n'êtes pas concerné, ignorez ce message.",
      ].join('\n'),
    }),
  },
];
