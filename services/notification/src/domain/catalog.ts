import { type ChannelName } from './channel';
import { isOptionalMessage } from './preferences';
import { allTemplates, isEventTemplate, type MessageKind, type TemplateDefinition } from './template';

/**
 * Aperçu d'un modèle de message pour le back-office, en lecture seule (ADR-038). Le texte est
 * rendu avec le nom de chaque variable entre accolades : aucune valeur réelle, aucun code.
 */
export interface TemplatePreview {
  code: string;
  /** `direct` : envoyé à la demande d'un service (codes) ; sinon nature du message d'un événement. */
  kind: 'direct' | MessageKind;
  channels: ChannelName[];
  secret: boolean;
  /** Soumis aux préférences du destinataire (ADR-038). */
  optional: boolean;
  variables: string[];
  optionalVariables: string[];
  /** null : texte rédigé chez le prestataire (modèle WhatsApp approuvé par Meta). */
  subject: string | null;
  text: string | null;
}

/** Variables remplacées par leur nom, par exemple « {first_name} ». */
function placeholders(template: TemplateDefinition): Record<string, string> {
  const names = [...Object.keys(template.variables), ...Object.keys(template.optionalVariables ?? {})];
  return Object.fromEntries(names.map((name) => [name, `{${name}}`]));
}

export function previewTemplate(template: TemplateDefinition): TemplatePreview {
  const rendered = template.render ? template.render(placeholders(template)) : null;
  return {
    code: template.code,
    kind: isEventTemplate(template) ? template.kind : 'direct',
    channels: [...template.channels],
    secret: template.secret,
    optional: isOptionalMessage(template),
    variables: Object.keys(template.variables),
    optionalVariables: Object.keys(template.optionalVariables ?? {}),
    subject: rendered?.subject ?? null,
    text: rendered?.text ?? null,
  };
}

/** Catalogue des modèles, par code croissant. */
export function templateCatalog(): TemplatePreview[] {
  return allTemplates().map(previewTemplate);
}
