/**
 * Événements publiés par recovery (ADR-060). Source de vérité : contracts/events/recovery/*.schema.json.
 * Identifiants et montants seulement : ni nom, ni téléphone, ni adresse du débiteur ; les messages au
 * débiteur partent par appel direct à notification, jamais par un événement.
 */
export interface RecoveryMoney {
  amount: number;
  currency: 'XOF';
}

/** Créancier titulaire du dossier : un compte ou une organisation. */
export interface RecoveryCreditorRef {
  type: 'user' | 'organization';
  id: string;
}

export type RecoveryCaseKind = 'b2b' | 'b2c' | 'rent';

export type RecoveryStage =
  'notice' | 'payment_plan' | 'amicable' | 'formal_notice' | 'bailiff' | 'litigation';

interface RecoveryCaseRef {
  caseId: string;
  /** Numéro lisible, par exemple RC-000123. */
  caseNumber: string;
  creditor: RecoveryCreditorRef;
}

export interface RecoveryEventPayloads {
  /** Mandat signé et frais payés : en attente de l'examen de recevabilité. */
  'recovery.case.submitted': RecoveryCaseRef & {
    kind: RecoveryCaseKind;
    amountDue: RecoveryMoney;
    source: 'form' | 'import' | 'rental';
    submittedAt: string;
  };
  'recovery.case.accepted': RecoveryCaseRef & {
    kind: RecoveryCaseKind;
    /** null : chargé pas encore affecté. */
    assignedAgentId: string | null;
    score: number;
    acceptedAt: string;
  };
  'recovery.case.info_requested': RecoveryCaseRef & {
    completionDueAt: string;
    requestedAt: string;
  };
  /**
   * Irrecevable : frais remboursés au portefeuille, moins le forfait d'étude. `incomplete` : complément
   * non fourni dans le délai, dossier classé (partie 4.4).
   */
  'recovery.case.rejected': RecoveryCaseRef & {
    reason: 'prescribed' | 'illegal' | 'no_evidence' | 'debtor_unreachable' | 'other' | 'incomplete';
    refundedAmount: RecoveryMoney;
    rejectedAt: string;
  };
  'recovery.case.stage_changed': RecoveryCaseRef & {
    kind: RecoveryCaseKind;
    /** null : première étape. */
    fromStage: RecoveryStage | null;
    toStage: RecoveryStage;
    /** Saut d'étape tracé (R-PR-03), null sinon. */
    skipReason: 'prescription_near' | 'asset_flight_risk' | null;
    changedBy: 'system' | 'staff';
    changedAt: string;
  };
  /** Contestation du débiteur (R-PR-02). */
  'recovery.case.suspended': RecoveryCaseRef & {
    reason: 'dispute';
    disputeId: string;
    creditorAnswerDueAt: string;
    suspendedAt: string;
  };
  'recovery.case.resumed': RecoveryCaseRef & {
    disputeId: string;
    resolution: 'resume' | 'correct_amount';
    resumedAt: string;
  };
  'recovery.case.closed': RecoveryCaseRef & {
    kind: RecoveryCaseKind;
    reason:
      | 'paid'
      | 'settlement_executed'
      | 'dispute_upheld'
      | 'abandoned_by_creditor'
      | 'unrecoverable'
      | 'prescribed';
    totalCollected: RecoveryMoney;
    /** Attestation de solde (dossier payé), null sinon. */
    settlementCertificateDocumentId: string | null;
    closedAt: string;
  };
  'recovery.decision.requested': RecoveryCaseRef & {
    decisionId: string;
    kind:
      | 'plan_off_scale'
      | 'settlement_discount'
      | 'bailiff_escalation'
      | 'litigation_escalation'
      | 'dispute_response'
      | 'stage_skip';
    expiresAt: string;
    requestedAt: string;
  };
  /** Échéancier signé par le débiteur : reconnaissance de dette (R-EC-02). */
  'recovery.plan.signed': RecoveryCaseRef & {
    planId: string;
    total: RecoveryMoney;
    installmentsCount: number;
    /** Date AAAA-MM-JJ. */
    firstDueDate: string;
    renegotiation: boolean;
    documentId: string;
    signedAt: string;
  };
  'recovery.plan.installment_missed': RecoveryCaseRef & {
    planId: string;
    installmentRank: number;
    dueDate: string;
    amount: RecoveryMoney;
    missedCount: number;
    missedAt: string;
  };
  'recovery.plan.defaulted': RecoveryCaseRef & {
    planId: string;
    missedCount: number;
    defaultedAt: string;
  };
  'recovery.notice.issued': RecoveryCaseRef & {
    noticeId: string;
    documentId: string;
    deadlineDays: number;
    issuedAt: string;
  };
  /**
   * Encaissement imputé (frais, intérêts, principal) avec sa commission : retenue (`deducted`), ou à
   * facturer au créancier pour un paiement reçu directement par lui (`invoiced`).
   */
  'recovery.payment.collected': RecoveryCaseRef & {
    kind: RecoveryCaseKind;
    collectionId: string;
    source: 'payment_link' | 'offline_cash' | 'offline_transfer' | 'partner' | 'direct_to_creditor';
    gross: RecoveryMoney;
    allocatedCosts: RecoveryMoney;
    allocatedInterests: RecoveryMoney;
    allocatedPrincipal: RecoveryMoney;
    overpaid: RecoveryMoney;
    commission: RecoveryMoney;
    commissionSettlement: 'deducted' | 'invoiced';
    stage: RecoveryStage;
    amountDueAfter: RecoveryMoney;
    receivedAt: string;
  };
  /** Net crédité au portefeuille du créancier par wallet. */
  'recovery.remittance.paid': RecoveryCaseRef & {
    collectionId: string;
    gross: RecoveryMoney;
    commission: RecoveryMoney;
    net: RecoveryMoney;
    walletTransactionId: string;
    creditedAt: string;
  };
  'recovery.partner.assigned': RecoveryCaseRef & {
    assignmentId: string;
    partnerId: string;
    partnerKind: 'bailiff' | 'lawyer';
    /** Compte KSP du partenaire, null sans accès partenaire. */
    partnerUserId: string | null;
    assignedAt: string;
  };
  'recovery.partner.act_recorded': RecoveryCaseRef & {
    actId: string;
    assignmentId: string;
    partnerId: string;
    actType:
      | 'summons_to_pay'
      | 'service'
      | 'conservatory_measure'
      | 'seizure'
      | 'injunction_request'
      | 'injunction_order'
      | 'hearing'
      | 'judgment'
      | 'enforcement'
      | 'insolvency_report'
      | 'other';
    actDate: string;
    cost: RecoveryMoney;
    recordedAt: string;
  };
}

export type RecoveryEventType = keyof RecoveryEventPayloads;
