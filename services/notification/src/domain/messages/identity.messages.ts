import { type TemplateDefinition } from '../template';

/**
 * Messages d'identity envoyés par appel direct (SendNotification), en français. Modèles secrets :
 * le code n'est conservé ni en base ni dans les journaux (ADR-014), seulement le destinataire masqué.
 */

const CODE = /^[0-9]{4,8}$/;
const MINUTES = /^[1-9][0-9]{0,3}$/;
const LEGAL_NAME = /^[^\n]{1,200}$/;

function minutes(value: string | undefined): string {
  return value === '1' ? '1 minute' : `${value ?? ''} minutes`;
}

export const IDENTITY_DIRECT_TEMPLATES: readonly TemplateDefinition[] = [
  {
    // Confirmation de l'e-mail du profil : seule une adresse confirmée reçoit les factures.
    code: 'identity.email_verification',
    channels: ['email'],
    secret: true,
    variables: { code: CODE, expires_in_minutes: MINUTES },
    render: (v) => ({
      // Le code n'est pas dans l'objet : l'objet s'affiche partout (aperçus, statistiques de Brevo).
      subject: 'Confirmez votre adresse e-mail KSP',
      text: [
        'Bonjour,',
        `Voici votre code pour confirmer cette adresse e-mail dans votre compte KSP : ${v['code'] ?? ''}`,
        `Il est valable ${minutes(v['expires_in_minutes'])}. Ne le communiquez à personne : ` +
          'KSP ne vous le demandera jamais par téléphone.',
        "Si vous n'avez pas demandé ce code, ignorez ce message : votre compte n'est pas modifié.",
      ].join('\n'),
    }),
  },
  {
    // Confirmation de l'e-mail de facturation d'une organisation (ADR-027) : seule une adresse
    // confirmée recevra les factures de l'entreprise.
    code: 'identity.organization_email_verification',
    channels: ['email'],
    secret: true,
    variables: { code: CODE, expires_in_minutes: MINUTES, organization_name: LEGAL_NAME },
    render: (v) => ({
      subject: "Confirmez l'adresse de facturation KSP",
      text: [
        'Bonjour,',
        `Cette adresse a été indiquée comme adresse de facturation de ${v['organization_name'] ?? ''} ` +
          `chez KSP. Voici le code pour la confirmer : ${v['code'] ?? ''}`,
        `Il est valable ${minutes(v['expires_in_minutes'])}. Ne le communiquez à personne : ` +
          'KSP ne vous le demandera jamais par téléphone.',
        "Si vous n'êtes pas concerné, ignorez ce message : aucune facture ne vous sera envoyée.",
      ].join('\n'),
    }),
  },
];
