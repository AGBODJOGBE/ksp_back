import { type ChannelName } from './channel';

/**
 * Modèle de message. Au lot 1, seul `identity.otp` existe ; le catalogue complet (fichiers versionnés
 * ou édition au back-office) attend le cahier des charges du service notification.
 */
export interface TemplateDefinition {
  code: string;
  /** Canaux par lesquels ce modèle peut partir. */
  channels: readonly ChannelName[];
  /**
   * Modèle secret : ni le texte ni les variables ne sont conservés ni journalisés (ADR-014),
   * seulement le destinataire masqué.
   */
  secret: boolean;
  /** Variables obligatoires et leur format. */
  variables: Readonly<Record<string, RegExp>>;
}

const TEMPLATES: Readonly<Record<string, TemplateDefinition>> = {
  'identity.otp': {
    code: 'identity.otp',
    channels: ['whatsapp', 'sms'],
    secret: true,
    variables: {
      // 15 caractères au plus : limite du bouton « Copier le code » de WhatsApp (ADR-021).
      code: /^[0-9A-Za-z]{1,15}$/,
      expires_in_minutes: /^[1-9][0-9]{0,3}$/,
    },
  },
};

export function findTemplate(code: string): TemplateDefinition | null {
  return Object.hasOwn(TEMPLATES, code) ? TEMPLATES[code] : null;
}

/** Noms des variables manquantes ou mal formées (jamais leurs valeurs). */
export function invalidVariables(
  template: TemplateDefinition,
  variables: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(template.variables)
    .filter(([name, format]) => {
      const value = variables[name];
      return value === undefined || !format.test(value);
    })
    .map(([name]) => name);
}
