/**
 * Modèles WhatsApp des messages déclenchés par les événements. Un message envoyé à l'initiative de
 * KSP doit utiliser un modèle approuvé par Meta (catégorie « utility ») : chaque modèle KSP est
 * relié ici au nom du modèle Meta et à ses paramètres {{1}}, {{2}}…, dans l'ordre du texte approuvé.
 *
 * Ces modèles sont à créer et à faire approuver dans le gestionnaire WhatsApp de Meta avant la
 * production, avec le texte des messages de `domain/messages` (liste dans le README).
 */
export interface WhatsAppTemplateSpec {
  /** Nom du modèle approuvé chez Meta (peut dépendre d'une variable, par exemple le motif). */
  name(variables: Readonly<Record<string, string>>): string;
  /** Paramètres du corps, dans l'ordre ; jamais vides (Meta refuse un paramètre vide). */
  parameters(variables: Readonly<Record<string, string>>): string[];
}

/** Meta refuse un paramètre vide : sans prénom, on écrit « Madame, Monsieur ». */
function name(variables: Readonly<Record<string, string>>): string {
  return variables['first_name']?.trim() || 'Madame, Monsieur';
}

function spec(
  templateName: string | ((variables: Readonly<Record<string, string>>) => string),
  keys: readonly string[],
): WhatsAppTemplateSpec {
  return {
    name: typeof templateName === 'string' ? () => templateName : templateName,
    parameters: (variables) => [name(variables), ...keys.map((key) => variables[key] ?? '')],
  };
}

export const WHATSAPP_EVENT_TEMPLATES: Readonly<Record<string, WhatsAppTemplateSpec>> = {
  'cleaning.quote_requested.customer': spec(
    (v) =>
      v['visit_required'] === 'true' ? 'ksp_cleaning_quote_requested_visit' : 'ksp_cleaning_quote_requested',
    ['link'],
  ),
  'cleaning.visit_scheduled.customer': spec('ksp_cleaning_visit_scheduled', ['date', 'link']),
  'cleaning.visit_scheduled.agent': spec('ksp_cleaning_visit_assigned', ['date']),
  'cleaning.quote_sent.customer': spec('ksp_cleaning_quote_sent', ['total', 'valid_until', 'link']),
  'cleaning.booking_confirmed.customer': spec('ksp_cleaning_booking_confirmed', [
    'planned_interventions',
    'total',
    'payment_note',
    'link',
  ]),
  'cleaning.mission_scheduled.customer': spec('ksp_cleaning_mission_scheduled', ['date', 'duration', 'link']),
  'cleaning.mission_scheduled.agent': spec('ksp_cleaning_mission_assigned', ['date', 'duration']),
  'cleaning.mission_completed.customer': spec('ksp_cleaning_mission_completed', [
    'completed_interventions',
    'completed_on',
    'link',
  ]),
  // Un modèle par motif (annulation par le client ou par KSP, refus de KSP, devis refusé) ;
  // `scope` distingue « votre demande » de « votre prestation ».
  'cleaning.request_cancelled.customer': {
    name: (v) => `ksp_cleaning_${v['case'] ?? 'cancelled_by_customer'}`,
    parameters: (v) => [
      name(v),
      v['scope'] === 'mission' ? 'votre prestation' : 'votre demande',
      v['link'] ?? '',
    ],
  },
};
