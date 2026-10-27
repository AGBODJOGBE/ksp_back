import { type ChannelName } from './channel';
import { CLEANING_TEMPLATES } from './messages/cleaning.messages';

/**
 * Modèle de message. Lot 1 : `identity.otp` (envoi direct) ; lot 2 : les messages des événements du
 * Nettoyage. Le catalogue complet (fichiers versionnés ou édition au back-office) attend le cahier
 * des charges du service notification.
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

/** Texte d'un message, en français : objet (e-mail, titre dans l'espace) et corps en texte brut. */
export interface RenderedMessage {
  subject: string;
  text: string;
}

/**
 * Nature d'un message déclenché par un événement, qui fixe l'ordre des canaux (voir channel.ts) :
 * `short` (court, transactionnel), `document` (devis, compte rendu) ou `important` (avertissement
 * et suspension pour impayés : envoyé par WhatsApp et par e-mail).
 */
export type MessageKind = 'short' | 'document' | 'important';

/** Modèle d'un message déclenché par un événement métier : il porte son propre texte. */
export interface EventTemplateDefinition extends TemplateDefinition {
  kind: MessageKind;
  render(variables: Readonly<Record<string, string>>): RenderedMessage;
}

export function isEventTemplate(template: TemplateDefinition): template is EventTemplateDefinition {
  return 'render' in template && typeof (template as EventTemplateDefinition).render === 'function';
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
  ...Object.fromEntries(CLEANING_TEMPLATES.map((template) => [template.code, template])),
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
