import { type TemplateDefinition } from '../template';

/**
 * Messages du service document envoyés par appel direct (SendNotification, ADR-044), en français.
 * Modèles secrets : le code de signature et le lien (qui porte un jeton personnel) ne sont
 * conservés ni en base ni dans les journaux, seulement le destinataire masqué.
 */

const CODE = /^[0-9]{6}$/;
const MINUTES = /^[1-9][0-9]{0,3}$/;
const TITLE = /^[^\n]{1,150}$/;
const FIRST_NAME = /^[^\n]{1,100}$/;
const LINK = /^https?:\/\/[^\s]{1,500}$/;
const DATE = /^[^\n]{1,40}$/;

function minutes(value: string | undefined): string {
  return value === '1' ? '1 minute' : `${value ?? ''} minutes`;
}

export const DOCUMENT_DIRECT_TEMPLATES: readonly TemplateDefinition[] = [
  {
    // Code de signature : WhatsApp (modèle d'authentification « Copier le code », comme
    // identity.otp), e-mail en repli. Le titre du document n'apparaît que dans l'e-mail.
    code: 'document.signature_code',
    channels: ['whatsapp', 'email'],
    secret: true,
    variables: { code: CODE, expires_in_minutes: MINUTES, document_title: TITLE },
    render: (v) => ({
      // Le code n'est pas dans l'objet : l'objet s'affiche partout (aperçus, statistiques).
      subject: 'Votre code de signature KSP',
      text: [
        'Bonjour,',
        `Voici votre code pour signer le document « ${v['document_title'] ?? ''} » : ${v['code'] ?? ''}`,
        `Il est valable ${minutes(v['expires_in_minutes'])}. En le saisissant, vous signez ce document ` +
          'électroniquement. Ne le communiquez à personne : KSP ne vous le demandera jamais par téléphone.',
        "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : rien ne sera signé.",
      ].join('\n'),
    }),
  },
  {
    // Invitation à signer : lien personnel (signataire sans compte) ou page de l'espace KSP.
    code: 'document.signature_requested',
    channels: ['whatsapp', 'email'],
    secret: true,
    variables: { document_title: TITLE, link: LINK, expires_on: DATE },
    optionalVariables: { first_name: FIRST_NAME },
    render: (v) => ({
      subject: `Document à signer : ${v['document_title'] ?? ''}`,
      text: [
        `Bonjour ${v['first_name']?.trim() || 'Madame, Monsieur'},`,
        `Le Groupe KSP vous invite à lire et signer le document « ${v['document_title'] ?? ''} ».`,
        `Ouvrez ce lien personnel : ${v['link'] ?? ''}`,
        'Vous pourrez lire le document, puis le signer avec un code reçu sur votre téléphone. ' +
          `Ce lien est valable jusqu'au ${v['expires_on'] ?? ''}. Ne le transmettez à personne.`,
      ].join('\n'),
    }),
  },
];
