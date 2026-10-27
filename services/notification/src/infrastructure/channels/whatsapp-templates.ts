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
  // Impayés, suspension et reprise (cahier des charges Nettoyage, partie 10).
  'cleaning.suspension_warning.customer': spec('ksp_cleaning_suspension_warning', [
    'unpaid_text',
    'threshold',
    'link',
  ]),
  'cleaning.contract_suspended.customer': spec('ksp_cleaning_contract_suspended', ['unpaid_text', 'link']),
  'cleaning.contract_suspended.agent': spec('ksp_cleaning_interventions_cancelled', []),
  'cleaning.contract_resumed.customer': spec('ksp_cleaning_contract_resumed', [
    'rescheduled_count',
    'failed_count',
    'link',
  ]),
  // Comptes entreprise (ADR-027).
  'identity.organization_requested.team': spec('ksp_identity_team_organization_requested', ['legal_name']),
  'identity.organization_validated.customer': spec('ksp_identity_organization_validated', [
    'legal_name',
    'link',
  ]),
  'identity.organization_rejected.customer': spec('ksp_identity_organization_rejected', [
    'legal_name',
    'reason',
    'link',
  ]),
  'identity.organization_suspended.customer': spec('ksp_identity_organization_suspended', [
    'legal_name',
    'reason',
    'link',
  ]),
  'identity.organization_reactivated.customer': spec('ksp_identity_organization_reactivated', [
    'legal_name',
    'link',
  ]),
  'cleaning.contract_resumed.team': spec('ksp_cleaning_team_contract_resumed', [
    'mission_id',
    'rescheduled_count',
    'failed_count',
  ]),
  'cleaning.rescheduling_failed.team': spec('ksp_cleaning_team_rescheduling_failed', [
    'mission_id',
    'failed_count',
  ]),
  // Facturation mensuelle des contrats d'entreprise (ADR-025).
  'billing.invoice_issued.customer': spec('ksp_billing_invoice_issued', [
    'invoice_number',
    'period',
    'total',
    'due_on',
    'link',
  ]),
  'billing.invoice_overdue.customer': spec('ksp_billing_invoice_overdue', [
    'invoice_number',
    'total',
    'due_on',
    'link',
  ]),
  // Deux modèles : sans ou avec des factures encore impayées sur le contrat.
  'billing.invoice_paid.customer': {
    name: (v) =>
      (v['unpaid_left'] ?? '0') === '0' ? 'ksp_billing_invoice_paid' : 'ksp_billing_invoice_paid_unpaid_left',
    parameters: (v) => [
      name(v),
      v['invoice_number'] ?? '',
      v['total'] ?? '',
      v['paid_on'] ?? '',
      ...((v['unpaid_left'] ?? '0') === '0' ? [] : [v['unpaid_left'] ?? '']),
      v['link'] ?? '',
    ],
  },
};
