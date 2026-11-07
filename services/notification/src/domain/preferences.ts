import { isEventTemplate, type TemplateDefinition } from './template';

/**
 * Canaux souhaités par un destinataire pour ses messages facultatifs (ADR-038). Sans choix
 * enregistré : WhatsApp et e-mail, comme avant l'ajout des préférences.
 */
export interface ChannelPreferences {
  whatsapp: boolean;
  email: boolean;
}

export const DEFAULT_CHANNEL_PREFERENCES: ChannelPreferences = Object.freeze({ whatsapp: true, email: true });

/**
 * Messages au client qui partent quelles que soient ses préférences : la suppression du compte
 * (« si vous n'êtes pas à l'origine de cette demande… ») est un message de sécurité.
 */
const ALWAYS_SENT: ReadonlySet<string> = new Set([
  'identity.account_deletion_requested.customer',
  'identity.account_deletion_cancelled.customer',
]);

/**
 * Message facultatif, soumis aux préférences : message d'un événement adressé au client
 * (`.customer`), ni important (impayés, suspension : WhatsApp et e-mail, toujours), ni de sécurité.
 * Les codes (envoi direct) et les messages des équipes KSP (`.agent`, `.team`) partent toujours.
 * La notification dans l'espace KSP est enregistrée dans tous les cas.
 */
export function isOptionalMessage(template: TemplateDefinition): boolean {
  return (
    isEventTemplate(template) &&
    template.kind !== 'important' &&
    template.code.endsWith('.customer') &&
    !ALWAYS_SENT.has(template.code)
  );
}

/**
 * Coordonnées retenues pour un message : celles du destinataire, moins les canaux qu'il a écartés
 * quand le message est facultatif.
 */
export function contactWithPreferences(
  contact: { hasPhone: boolean; hasEmail: boolean },
  preferences: ChannelPreferences,
  optional: boolean,
): { hasPhone: boolean; hasEmail: boolean } {
  if (!optional) return contact;
  return {
    hasPhone: contact.hasPhone && preferences.whatsapp,
    hasEmail: contact.hasEmail && preferences.email,
  };
}
