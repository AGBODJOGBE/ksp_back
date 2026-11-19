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

/**
 * Message d'une demande qui cite sa prestation (ADR-035 point 14) : avec le nom, le modèle
 * `<nom>_service` reçoit la prestation juste après le prénom ; sans lui (événement antérieur), le
 * modèle d'avant, inchangé.
 */
function withService(
  templateName: string | ((variables: Readonly<Record<string, string>>) => string),
  keys: readonly string[],
): WhatsAppTemplateSpec {
  const base = typeof templateName === 'string' ? () => templateName : templateName;
  const serviceOf = (variables: Readonly<Record<string, string>>) => variables['service_name']?.trim() ?? '';
  return {
    name: (variables) => (serviceOf(variables) ? `${base(variables)}_service` : base(variables)),
    parameters: (variables) => [
      name(variables),
      ...(serviceOf(variables) ? [serviceOf(variables)] : []),
      ...keys.map((key) => variables[key] ?? ''),
    ],
  };
}

export const WHATSAPP_EVENT_TEMPLATES: Readonly<Record<string, WhatsAppTemplateSpec>> = {
  'cleaning.visit_scheduled.customer': withService('ksp_cleaning_visit_scheduled', ['date', 'link']),
  'cleaning.visit_scheduled.agent': withService('ksp_cleaning_visit_assigned', ['date']),
  'cleaning.quote_sent.customer': withService('ksp_cleaning_quote_sent', ['total', 'valid_until', 'link']),
  // Un modèle par motif (annulation par le client ou par KSP, refus de KSP, devis refusé) ;
  // `scope` distingue « votre demande » de « votre prestation ». Avec le nom de la prestation :
  // modèle `<motif>_service`, la prestation après « votre demande » (ADR-035 point 14).
  'cleaning.request_cancelled.customer': {
    name: (v) =>
      `ksp_cleaning_${v['case'] ?? 'cancelled_by_customer'}${v['service_name']?.trim() ? '_service' : ''}`,
    parameters: (v) => [
      name(v),
      v['scope'] === 'mission' ? 'votre prestation' : 'votre demande',
      ...(v['service_name']?.trim() ? [v['service_name'].trim()] : []),
      v['link'] ?? '',
    ],
  },
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
  // Suppression du compte (ADR-036).
  'identity.account_deletion_requested.customer': spec('ksp_identity_account_deletion_requested', [
    'scheduled_for',
    'link',
  ]),
  'identity.account_deletion_cancelled.customer': spec('ksp_identity_account_deletion_cancelled', ['link']),
  'identity.mfa_reset.staff': spec('ksp_identity_mfa_reset', ['enroll_before']),
  // Compléments du Nettoyage (ADR-053).
  'cleaning.quote_expiry_reminder.customer': spec(
    (v) =>
      v['quote_count'] === '1' ? 'ksp_cleaning_quote_expiry_reminder' : 'ksp_cleaning_quotes_expiry_reminder',
    ['quotes', 'valid_until', 'link'],
  ),
  'cleaning.quote_expired.customer': spec(
    (v) => (v['quote_count'] === '1' ? 'ksp_cleaning_quote_expired' : 'ksp_cleaning_quotes_expired'),
    ['quotes', 'link'],
  ),
  'cleaning.visit_cancelled.agent': spec('ksp_cleaning_visit_cancelled', ['date', 'services']),
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
  // Invitation à signer un document (ADR-044) : le lien porte un jeton personnel (modèle secret).
  'document.signature_requested': spec('ksp_document_signature_requested', [
    'document_title',
    'expires_on',
    'link',
  ]),
  // Reçu d'un paiement en ligne (ADR-031).
  'payment.receipt.customer': spec('ksp_payment_receipt', [
    'amount',
    'object',
    'paid_on',
    'reference',
    'link',
  ]),
  // Portefeuille prépayé (ADR-046).
  'wallet.payment.customer': spec('ksp_wallet_payment', ['amount', 'object', 'balance', 'link']),
  'wallet.credit.customer': spec('ksp_wallet_credit', ['amount', 'object', 'balance', 'link']),
};
