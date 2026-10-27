import { type TemplateDefinition } from '../template';

/**
 * Messages d'identity envoyés par appel direct (SendNotification), en français. Modèles secrets :
 * le code n'est conservé ni en base ni dans les journaux (ADR-014), seulement le destinataire masqué.
 */

const CODE = /^[0-9]{4,8}$/;
const MINUTES = /^[1-9][0-9]{0,3}$/;

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
];
