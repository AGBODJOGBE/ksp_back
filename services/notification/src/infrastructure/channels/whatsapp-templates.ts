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

/**
 * Nettoyage v2 (CDC Nettoyage v2, 16.2 ; lot G). Une variante par cas quand le texte change
 * (`case`) ; le remboursement d'une visite et le lien des messages du personnel restent dans
 * l'e-mail et l'espace KSP. Messages du personnel : `ksp_cleaning_staff_*` ; des agents :
 * `ksp_cleaning_agent_*`.
 */
const CLEANING_V2: Readonly<Record<string, WhatsAppTemplateSpec>> = {
  'cleaning.request_submitted.customer': spec(
    (v) =>
      v['case'] === 'paid' ? 'ksp_cleaning_request_submitted' : 'ksp_cleaning_request_submitted_unpaid',
    ['request_number', 'place', 'visit_fee', 'link'],
  ),
  'cleaning.visit_fee_paid.customer': spec('ksp_cleaning_visit_fee_paid', [
    'request_number',
    'amount',
    'link',
  ]),
  'cleaning.visit_rescheduled.customer': spec('ksp_cleaning_visit_rescheduled', [
    'request_number',
    'previous_date',
    'date',
    'link',
  ]),
  'cleaning.visit_cancelled.customer': spec(
    (v) =>
      v['case'] === 'slot_changed'
        ? 'ksp_cleaning_visit_cancelled_slot_changed'
        : 'ksp_cleaning_visit_cancelled_by_ksp',
    ['request_number', 'date', 'link'],
  ),
  'cleaning.visit_arrived.customer': spec('ksp_cleaning_visit_arrived', ['request_number', 'link']),
  'cleaning.visit_completed.customer': spec('ksp_cleaning_visit_completed', ['request_number', 'link']),
  'cleaning.renewal_proposed.customer': spec('ksp_cleaning_renewal_proposed', [
    'request_number',
    'total',
    'valid_until',
    'link',
  ]),
  'cleaning.quote_forwarded.customer': spec('ksp_cleaning_quote_forwarded', ['request_number', 'link']),
  'cleaning.program_confirmed.customer': spec('ksp_cleaning_program_confirmed', [
    'program_number',
    'place',
    'sessions_count',
    'first_date',
    'total',
    'link',
  ]),
  'cleaning.program_completed.customer': spec(
    (v) =>
      v['case'] === 'one_off' ? 'ksp_cleaning_program_completed_one_off' : 'ksp_cleaning_program_completed',
    ['program_number', 'end_date', 'sessions_completed', 'link'],
  ),
  'cleaning.program_cancelled.customer': spec(
    (v) => (v['case'] === 'ksp' ? 'ksp_cleaning_program_cancelled_by_ksp' : 'ksp_cleaning_program_cancelled'),
    ['link'],
  ),
  'cleaning.program_suspended.customer': spec('ksp_cleaning_program_suspended', ['causes', 'link']),
  'cleaning.program_suspension_updated.customer': spec(
    (v) =>
      v['case'] === 'cause_added'
        ? 'ksp_cleaning_program_suspension_cause_added'
        : 'ksp_cleaning_program_suspension_cause_lifted',
    ['cause', 'causes', 'link'],
  ),
  'cleaning.program_resumed.customer': spec('ksp_cleaning_program_resumed', ['link']),
  'cleaning.unpaid_warning.customer': spec('ksp_cleaning_unpaid_warning', [
    'unpaid_count',
    'suspension_threshold',
    'link',
  ]),
  'cleaning.session_assigned.customer': spec('ksp_cleaning_session_assigned', ['session', 'date', 'link']),
  'cleaning.sessions_assigned.customer': spec('ksp_cleaning_sessions_assigned', [
    'count',
    'first_date',
    'last_date',
    'link',
  ]),
  'cleaning.session_rescheduled.customer': spec('ksp_cleaning_session_rescheduled', [
    'session',
    'previous_date',
    'date',
    'link',
  ]),
  'cleaning.session_cancelled.customer': spec(
    (v) =>
      v['case'] === 'customer'
        ? 'ksp_cleaning_session_cancelled'
        : v['case'] === 'no_agent'
          ? 'ksp_cleaning_session_cancelled_no_agent'
          : 'ksp_cleaning_session_cancelled_by_ksp',
    ['session', 'date', 'link'],
  ),
  // Particulier : l'état du solde et le montant ; entreprise (facture mensuelle) : sans montant.
  'cleaning.session_reminder.customer': {
    name: (v) =>
      !v['amount'] || v['case'] === 'invoiced'
        ? 'ksp_cleaning_session_reminder'
        : v['case'] === 'sufficient'
          ? 'ksp_cleaning_session_reminder_balance_ok'
          : 'ksp_cleaning_session_reminder_balance_low',
    parameters: (v) => [
      name(v),
      v['session'] ?? '',
      v['date'] ?? '',
      ...(!v['amount'] || v['case'] === 'invoiced' ? [] : [v['amount']]),
      v['link'] ?? '',
    ],
  },
  'cleaning.balance_insufficient.customer': spec('ksp_cleaning_balance_insufficient', [
    'session',
    'date',
    'amount_due',
    'missing',
    'link',
  ]),
  'cleaning.session_arrived.customer': spec('ksp_cleaning_session_arrived', ['session', 'link']),
  'cleaning.session_started.customer': spec('ksp_cleaning_session_started', ['session', 'link']),
  'cleaning.session_completed.customer': spec('ksp_cleaning_session_completed', ['session', 'link']),
  'cleaning.session_payment_due.customer': spec('ksp_cleaning_session_payment_due', [
    'session',
    'amount',
    'due_by',
    'link',
  ]),
  'cleaning.session_paid.customer': spec('ksp_cleaning_session_paid', ['session', 'amount', 'link']),
  'cleaning.session_overdue.customer': spec('ksp_cleaning_session_overdue', ['session', 'amount', 'link']),
  // Demande refusée, devis retiré, paiement laissé au portefeuille, client absent à la visite.
  'cleaning.request_rejected.customer': spec('ksp_cleaning_request_rejected', [
    'request_number',
    'reason',
    'link',
  ]),
  'cleaning.quote_withdrawn.customer': spec('ksp_cleaning_quote_withdrawn', ['request_number', 'link']),
  'cleaning.payment_left_in_wallet.customer': spec('ksp_cleaning_payment_left_in_wallet', [
    'amount',
    'object',
    'reason',
    'link',
  ]),
  'cleaning.visit_missed.customer': spec('ksp_cleaning_visit_missed', [
    'request_number',
    'date',
    'visit_fee',
    'pay_before',
    'link',
  ]),
  'cleaning.claim_opened.customer': spec('ksp_cleaning_claim_opened', ['link']),
  'cleaning.claim_resolved.customer': {
    name: (v) =>
      v['case'] === 'free_redo'
        ? 'ksp_cleaning_claim_free_redo'
        : v['case'] === 'wallet_credit'
          ? v['amount']
            ? 'ksp_cleaning_claim_credit_amount'
            : 'ksp_cleaning_claim_credit'
          : 'ksp_cleaning_claim_rejected',
    parameters: (v) => [
      name(v),
      ...(v['case'] === 'wallet_credit' && v['amount'] ? [v['amount']] : []),
      v['link'] ?? '',
    ],
  },
  // Agents (application agent, sans lien ni montant).
  'cleaning.visit_rescheduled.agent': spec('ksp_cleaning_agent_visit_rescheduled', [
    'request_number',
    'date',
    'previous_date',
  ]),
  'cleaning.visit_released.agent': spec('ksp_cleaning_agent_visit_released', ['date', 'request_number']),
  'cleaning.session_assigned.agent': spec('ksp_cleaning_agent_session_assigned', ['session', 'date']),
  'cleaning.sessions_assigned.agent': spec('ksp_cleaning_agent_sessions_assigned', [
    'count',
    'first_date',
    'last_date',
  ]),
  'cleaning.session_rescheduled.agent': spec('ksp_cleaning_agent_session_rescheduled', [
    'session',
    'previous_date',
    'date',
  ]),
  'cleaning.session_released.agent': spec('ksp_cleaning_agent_session_released', ['session', 'date']),
  'cleaning.program_released.agent': spec('ksp_cleaning_agent_program_released', []),
  'cleaning.session_reminder.agent': spec('ksp_cleaning_agent_session_reminder', ['session', 'date']),
  'cleaning.agent_applied.agent': spec(
    (v) =>
      v['case'] === 'self' ? 'ksp_cleaning_agent_application_received' : 'ksp_cleaning_agent_profile_created',
    [],
  ),
  'cleaning.agent_approved.agent': spec('ksp_cleaning_agent_approved', []),
  // Personnel du back-office (le lien reste dans l'e-mail et l'espace KSP).
  'cleaning.request_submitted.staff': spec('ksp_cleaning_staff_request_submitted', [
    'request_number',
    'place',
  ]),
  'cleaning.visit_fee_paid.staff': {
    name: (v) =>
      v['rank'] === '1' ? 'ksp_cleaning_staff_visit_fee_paid' : 'ksp_cleaning_staff_new_visit_fee_paid',
    parameters: (v) => [name(v), v['request_number'] ?? '', ...(v['rank'] === '1' ? [] : [v['rank'] ?? ''])],
  },
  'cleaning.reactivation_requested.staff': spec('ksp_cleaning_staff_reactivation_requested', [
    'request_number',
  ]),
  'cleaning.visit_missed.staff': spec('ksp_cleaning_staff_visit_missed', ['date', 'request_number']),
  'cleaning.quote_accepted.staff': spec('ksp_cleaning_staff_quote_accepted', ['request_number']),
  'cleaning.quote_declined.staff': spec('ksp_cleaning_staff_quote_declined', ['request_number', 'reason']),
  'cleaning.quote_expired.staff': spec('ksp_cleaning_staff_quote_expired', ['request_number']),
  'cleaning.program_suspended.staff': spec('ksp_cleaning_staff_program_suspended', ['causes']),
  'cleaning.program_suspension_updated.staff': spec(
    (v) =>
      v['case'] === 'cause_added'
        ? 'ksp_cleaning_staff_ksp_suspension_added'
        : 'ksp_cleaning_staff_ksp_suspension_lifted',
    ['causes'],
  ),
  'cleaning.program_resumed.staff': spec('ksp_cleaning_staff_program_resumed', [
    'cause',
    'sessions_to_assign',
    'catch_up',
  ]),
  'cleaning.unpaid_warning.staff': spec('ksp_cleaning_staff_unpaid_warning', [
    'unpaid_count',
    'suspension_threshold',
  ]),
  'cleaning.session_overdue.staff': spec('ksp_cleaning_staff_session_overdue', ['session', 'overdue_count']),
  'cleaning.session_interrupted.staff': spec('ksp_cleaning_staff_session_interrupted', [
    'session',
    'category',
  ]),
  'cleaning.session_missed.staff': spec('ksp_cleaning_staff_session_missed', ['session', 'cause']),
  'cleaning.staffing_alert.staff': spec(
    (v) =>
      v['case'] === 'unassigned_48h'
        ? 'ksp_cleaning_staff_session_unstaffed'
        : v['case'] === 'unassigned_at_start'
          ? 'ksp_cleaning_staff_session_uncovered'
          : 'ksp_cleaning_staff_agent_absent',
    ['session', 'date', 'missing'],
  ),
  'cleaning.agent_applied.staff': spec('ksp_cleaning_staff_agent_applied', []),
  'cleaning.claim_opened.staff': spec('ksp_cleaning_staff_claim_opened', ['category']),
};

export const WHATSAPP_EVENT_TEMPLATES: Readonly<Record<string, WhatsAppTemplateSpec>> = {
  ...CLEANING_V2,
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
  // Recouvrement (CDC partie 17.2, ADR-060) : créancier, chargé, partenaire, équipes.
  'recovery.case_submitted.customer': spec('ksp_recovery_case_submitted', [
    'case_number',
    'amount_due',
    'link',
  ]),
  'recovery.case_accepted.customer': spec('ksp_recovery_case_accepted', ['case_number', 'link']),
  'recovery.case_info_requested.customer': spec('ksp_recovery_case_info_requested', [
    'case_number',
    'due_on',
    'link',
  ]),
  // Deux modèles : sans ou avec un remboursement des frais de dossier.
  'recovery.case_rejected.customer': {
    name: (v) => (v['refunded'] ? 'ksp_recovery_case_rejected_refund' : 'ksp_recovery_case_rejected'),
    parameters: (v) => [
      name(v),
      v['case_number'] ?? '',
      v['reason'] ?? '',
      ...(v['refunded'] ? [v['refunded']] : []),
      v['link'] ?? '',
    ],
  },
  'recovery.decision_requested.customer': spec('ksp_recovery_decision_requested', [
    'case_number',
    'decision',
    'expires_on',
    'without_answer',
    'link',
  ]),
  'recovery.plan_signed.customer': spec('ksp_recovery_plan_signed', [
    'case_number',
    'total',
    'installments',
    'first_due_on',
    'link',
  ]),
  'recovery.installment_missed.customer': spec('ksp_recovery_installment_missed', [
    'rank',
    'amount',
    'due_on',
    'case_number',
    'link',
  ]),
  'recovery.plan_defaulted.customer': spec('ksp_recovery_plan_defaulted', ['case_number', 'missed', 'link']),
  'recovery.payment_collected.customer': spec('ksp_recovery_payment_collected', [
    'amount',
    'case_number',
    'amount_due_after',
    'link',
  ]),
  'recovery.direct_payment_recorded.customer': spec('ksp_recovery_direct_payment_recorded', [
    'amount',
    'case_number',
    'amount_due_after',
    'commission',
    'link',
  ]),
  'recovery.remittance_paid.customer': spec('ksp_recovery_remittance_paid', [
    'net',
    'case_number',
    'gross',
    'commission',
    'link',
  ]),
  'recovery.notice_issued.customer': spec('ksp_recovery_notice_issued', [
    'case_number',
    'deadline_days',
    'link',
  ]),
  'recovery.partner_assigned.customer': spec('ksp_recovery_partner_assigned', [
    'case_number',
    'partner',
    'link',
  ]),
  'recovery.act_recorded.customer': spec('ksp_recovery_act_recorded', [
    'case_number',
    'act',
    'act_on',
    'cost',
    'link',
  ]),
  'recovery.case_suspended.customer': spec('ksp_recovery_case_suspended', [
    'case_number',
    'answer_due_on',
    'link',
  ]),
  'recovery.case_resumed.customer': spec('ksp_recovery_case_resumed', ['case_number', 'resolution', 'link']),
  'recovery.case_closed.customer': spec('ksp_recovery_case_closed', [
    'case_number',
    'reason',
    'total_collected',
    'link',
  ]),
  'recovery.case_submitted.team': spec('ksp_recovery_team_case_submitted', [
    'case_number',
    'kind',
    'amount_due',
  ]),
  'recovery.case_assigned.agent': spec('ksp_recovery_case_assigned_agent', ['case_number']),
  'recovery.dispute_opened.team': spec('ksp_recovery_team_dispute_opened', ['case_number', 'answer_due_on']),
  'recovery.act_recorded.team': spec('ksp_recovery_team_act_recorded', ['case_number', 'act', 'act_on']),
  'recovery.case_assigned.partner': spec('ksp_recovery_case_assigned_partner', ['case_number', 'link']),
  // Messages directs au débiteur (ADR-061) : le lien porte un jeton personnel (modèles secrets). Le
  // code d'accès part par le modèle d'authentification (meta-whatsapp.provider.ts).
  'recovery.debtor_mandate_notice': spec('ksp_recovery_debtor_mandate_notice', [
    'creditor_name',
    'amount_due',
    'case_number',
    'link_expires_on',
    'link',
  ]),
  'recovery.debtor_reminder': spec('ksp_recovery_debtor_reminder', [
    'creditor_name',
    'amount_due',
    'case_number',
    'link',
  ]),
  'recovery.debtor_installment_reminder': spec('ksp_recovery_debtor_installment_reminder', [
    'amount',
    'case_number',
    'creditor_name',
    'due_on',
    'link',
  ]),
  'recovery.debtor_payment_link': spec('ksp_recovery_debtor_payment_link', [
    'amount',
    'case_number',
    'creditor_name',
    'expires_on',
    'link',
  ]),
  'recovery.debtor_plan_confirmed': spec('ksp_recovery_debtor_plan_confirmed', [
    'case_number',
    'creditor_name',
    'total',
    'installments',
    'first_due_on',
    'link',
  ]),
  'recovery.debtor_formal_notice': spec('ksp_recovery_debtor_formal_notice', [
    'creditor_name',
    'case_number',
    'amount_due',
    'deadline_days',
    'link',
  ]),
  'recovery.debtor_settlement_certificate': spec('ksp_recovery_debtor_settlement_certificate', [
    'case_number',
    'creditor_name',
    'link',
  ]),
  'recovery.debtor_dispute_received': spec('ksp_recovery_debtor_dispute_received', [
    'case_number',
    'creditor_name',
    'link',
  ]),
};
