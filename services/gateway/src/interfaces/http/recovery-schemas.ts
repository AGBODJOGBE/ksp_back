import { z } from 'zod';

const money = z.strictObject({ amount: z.number().int(), currency: z.literal('XOF') });
const day = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });

// Objets des corps du recouvrement, repris des schémas du contrat OpenAPI (components/schemas).
const feeEstimateRequest = z.strictObject({
  kind: z.enum(['b2b', 'b2c', 'rent']),
  amountDue: money,
  communeKey: z.string().max(60).optional(),
});
const debtorInput = z.strictObject({
  kind: z.enum(['person', 'company']),
  role: z.enum(['main', 'co_debtor', 'guarantor']),
  firstNames: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  legalName: z.string().max(200).optional(),
  ifu: z.string().max(20).optional(),
  rccm: z.string().max(40).optional(),
  representativeName: z.string().max(200).optional(),
  phones: z.array(z.string().regex(/^\+[1-9][0-9]{7,14}$/)).max(5),
  emails: z.array(z.email()).max(5),
  address: z.string().max(300).optional(),
  communeKey: z.string().max(60).optional(),
});
const claimInput = z.strictObject({
  reference: z.string().min(1).max(60),
  amount: money,
  dueDate: day,
  description: z.string().max(300).optional(),
});
const priorEffort = z.strictObject({
  remindersCount: z.number().int().min(0).max(1000),
  lastReminderDate: day.nullable().optional(),
  channels: z.array(z.enum(['phone', 'sms', 'whatsapp', 'email', 'letter', 'visit'])),
  debtAcknowledged: z.boolean(),
  acknowledgmentFileId: z.guid().nullable().optional(),
  promisesReceived: z.string().max(1000).nullable().optional(),
  preserveRelationship: z.boolean(),
});
const planScale = z.strictObject({
  acceptsPaymentPlan: z.boolean(),
  maxDurationMonths: z.number().int().min(1).max(36),
  minFirstPaymentBps: z.number().int().min(0).max(10000),
  firstPaymentWithinDays: z.number().int().min(1).max(90),
  minInstallment: money,
  maxDiscountBps: z.number().int().min(0).max(10000),
});
const caseInput = z.strictObject({
  kind: z.enum(['b2b', 'b2c', 'rent']),
  nature: z.enum([
    'unpaid_invoice',
    'loan',
    'acknowledgment_of_debt',
    'bounced_cheque',
    'service',
    'sale',
    'rent',
    'other',
  ]),
  debtors: z.array(debtorInput).min(1).max(10),
  claims: z.array(claimInput).min(1).max(200),
  interests: money.optional(),
  alreadyPaid: money.optional(),
  priorEffort: priorEffort,
  planScale: planScale.optional(),
  evidenceFileIds: z.array(z.guid()).min(1).max(20),
});
const updateCaseRequest = z.strictObject({
  input: caseInput,
  completionNote: z.string().max(2000).optional(),
});
const addDocumentRequest = z.strictObject({ fileId: z.guid(), label: z.string().min(1).max(140).optional() });
const prepareMandateRequest = z.strictObject({ duplicatesAcknowledged: z.boolean().optional() });
const createImportRequest = z.strictObject({
  kind: z.enum(['b2b', 'b2c']),
  fileId: z.guid(),
  evidenceArchiveFileId: z.guid().optional(),
});
const importLineValues = z.strictObject({
  debtorKind: z.string().max(300).optional(),
  debtorName: z.string().max(300).optional(),
  debtorFirstNames: z.string().max(300).optional(),
  debtorIfu: z.string().max(300).optional(),
  debtorPhone: z.string().max(300).optional(),
  debtorEmail: z.string().max(300).optional(),
  debtorAddress: z.string().max(300).optional(),
  invoiceReference: z.string().max(300).optional(),
  amount: z.string().max(300).optional(),
  dueDate: z.string().max(300).optional(),
  description: z.string().max(300).optional(),
  nature: z.string().max(300).optional(),
});
const updateImportLineRequest = z.strictObject({
  values: importLineValues.optional(),
  ignore: z.boolean().optional(),
});
const answerDecisionRequest = z.strictObject({
  answer: z.enum(['approve', 'reject', 'answer']),
  comment: z.string().max(2000).optional(),
  fileIds: z.array(z.guid()).max(20).optional(),
});
const stopCaseRequest = z.strictObject({ reason: z.string().min(3).max(500) });
const directPaymentRequest = z.strictObject({
  amount: money,
  receivedOn: day,
  note: z.string().max(500).optional(),
  proofFileId: z.guid().optional(),
});
const creditorPreferences = z.strictObject({
  b2bScale: planScale,
  b2cScale: planScale,
  notifyUserIds: z.array(z.guid()).max(20),
});
const debtorCodeRequest = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
const debtorPaymentRequest = z.strictObject({ amount: money, settlementId: z.guid().optional() });
const planTerms = z.strictObject({
  firstAmount: money,
  firstDueDate: day,
  rhythm: z.enum(['weekly', 'biweekly', 'monthly']),
  installmentsCount: z.number().int().min(1).max(52),
});
const planSimulationRequest = z.strictObject({ terms: planTerms });
const debtorPlanRequest = z.strictObject({ terms: planTerms, message: z.string().max(1000).optional() });
const debtorDisputeRequest = z.strictObject({
  reason: z.enum(['already_paid', 'wrong_amount', 'service_not_rendered', 'wrong_person', 'other']),
  text: z.string().min(10).max(2000),
  fileIds: z.array(z.guid()).max(10).optional(),
});
const debtorUploadRequest = z.strictObject({
  fileName: z.string().min(1).max(200),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().min(1).max(10485760),
});
const debtorCallbackRequest = z.strictObject({
  preferredFrom: dateTime,
  preferredTo: dateTime,
  message: z.string().max(500).optional(),
});
const legalActRequest = z.strictObject({
  type: z.enum([
    'summons_to_pay',
    'service',
    'conservatory_measure',
    'seizure',
    'injunction_request',
    'injunction_order',
    'hearing',
    'judgment',
    'enforcement',
    'insolvency_report',
    'other',
  ]),
  actDate: day,
  cost: money,
  fileId: z.guid().optional(),
  note: z.string().max(1000).optional(),
  nextStepDate: day.optional(),
});
const partnerCollectionRequest = z.strictObject({
  amount: money,
  receivedOn: day,
  proofFileId: z.guid().optional(),
  note: z.string().max(500).optional(),
});
const assessCaseRequest = z.strictObject({
  decision: z.enum(['accept', 'request_info', 'reject']),
  note: z.string().max(2000).optional(),
  agentUserId: z.guid().optional(),
  rejectionReason: z.enum(['prescribed', 'illegal', 'no_evidence', 'debtor_unreachable', 'other']).optional(),
});
const assignCaseRequest = z.strictObject({ agentUserId: z.guid() });
const contactRequest = z.strictObject({
  debtorId: z.guid().optional(),
  channel: z.enum(['phone', 'sms', 'whatsapp', 'email', 'letter', 'visit']),
  direction: z.enum(['outbound', 'inbound']),
  outcome: z.enum([
    'reached',
    'no_answer',
    'wrong_number',
    'refused',
    'promise',
    'callback_requested',
    'delivered',
    'failed',
  ]),
  note: z.string().max(2000).optional(),
  occurredAt: dateTime,
  callbackAt: dateTime.optional(),
  fileId: z.guid().optional(),
});
const promiseRequest = z.strictObject({ amount: money, dueDate: day, note: z.string().max(500).optional() });
const debtorMessageRequest = z.strictObject({
  debtorId: z.guid(),
  template: z.enum(['reminder', 'payment_link', 'plan_reminder', 'callback_missed']),
  channel: z.enum(['whatsapp', 'sms', 'email']).optional(),
});
const noteRequest = z.strictObject({ text: z.string().min(1).max(4000) });
const planProposalRequest = z.strictObject({ terms: planTerms, note: z.string().max(1000).optional() });
const planApprovalRequest = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(1000).optional(),
});
const settlementRequest = z.strictObject({
  payNow: money,
  validUntil: dateTime,
  note: z.string().max(1000).optional(),
});
const stageChangeRequest = z.strictObject({
  toStage: z.enum(['notice', 'payment_plan', 'amicable', 'formal_notice', 'bailiff', 'litigation']),
  reason: z.string().min(3).max(1000),
  skipReason: z.enum(['prescription_near', 'asset_flight_risk']).optional(),
});
const formalNoticeRequest = z.strictObject({ deadlineDays: z.number().int().min(8).max(60).optional() });
const noticeDeliveryRequest = z.strictObject({
  deliveryMethod: z.enum(['hand_delivery', 'registered_mail', 'bailiff', 'email']),
  deliveredAt: dateTime,
  proofFileId: z.guid(),
});
const disputeResolutionRequest = z.strictObject({
  resolution: z.enum(['resume', 'correct_amount', 'close']),
  correctedDue: money.optional(),
  note: z.string().min(3).max(2000),
});
const feeQuoteLine = z.strictObject({ label: z.string().min(1).max(140), amount: money });
const escalationRequest = z.strictObject({
  stage: z.enum(['bailiff', 'litigation']),
  partnerId: z.guid(),
  lines: z.array(feeQuoteLine).min(1).max(30),
  validUntil: dateTime,
  note: z.string().max(1000).optional(),
});
const assignPartnerRequest = z.strictObject({ partnerId: z.guid(), note: z.string().max(1000).optional() });
const withdrawPartnerRequest = z.strictObject({ reason: z.string().min(3).max(1000) });
const offlinePaymentRequest = z.strictObject({
  source: z.enum(['cash', 'transfer']),
  amount: money,
  receivedOn: day,
  reference: z.string().max(100).optional(),
  proofFileId: z.guid().optional(),
});
const rejectRequest = z.strictObject({ reason: z.string().min(3).max(1000) });
const overpaymentRefundRequest = z.strictObject({
  amount: money,
  reference: z.string().min(1).max(100),
  note: z.string().max(500).optional(),
});
const closeCaseRequest = z.strictObject({
  reason: z.enum([
    'paid',
    'settlement_executed',
    'dispute_upheld',
    'abandoned_by_creditor',
    'unrecoverable',
    'prescribed',
  ]),
  note: z.string().max(2000).optional(),
  proofFileId: z.guid().optional(),
});
const partnerFee = z.strictObject({ actType: z.string().max(40), amount: money });
const partnerInput = z.strictObject({
  kind: z.enum(['bailiff', 'lawyer']),
  name: z.string().min(2).max(200),
  office: z.string().max(200).optional(),
  communeKeys: z.array(z.string().max(60)).min(1).max(100),
  phones: z.array(z.string().regex(/^\+[1-9][0-9]{7,14}$/)).max(5),
  email: z.email().optional(),
  userId: z.guid().optional(),
  fees: z.array(partnerFee).max(50).optional(),
  verificationFileId: z.guid().optional(),
});
const updatePartnerRequest = z.strictObject({
  input: partnerInput.optional(),
  status: z.enum(['active', 'suspended']).optional(),
  statusReason: z.string().max(500).optional(),
});
const pricingTier = z.strictObject({
  upTo: money.nullable(),
  rateBps: z.number().int().min(0).max(10000).optional(),
  fixedAmount: money.optional(),
});
const stageRate = z.strictObject({
  stageGroup: z.enum(['amicable', 'formal_notice', 'litigation']),
  rateBps: z.number().int().min(0).max(10000),
});
const pricingTarget = z.strictObject({
  offer: z.enum(['b2b', 'b2c', 'rent', 'any']),
  communeKey: z.string().nullable().optional(),
  creditor: z
    .strictObject({ type: z.enum(['user', 'organization']), id: z.guid() })
    .nullable()
    .optional(),
});
const pricingRuleInput = z.strictObject({
  object: z.enum(['case_fee', 'recovery_commission', 'study_fee']),
  mode: z.enum(['fixed', 'percentage', 'tiered', 'by_stage']),
  fixedAmount: money.optional(),
  rateBps: z.number().int().min(0).max(10000).optional(),
  tiers: z.array(pricingTier).max(20).optional(),
  stageRates: z.array(stageRate).max(3).optional(),
  minimum: money.optional(),
  maximum: money.optional(),
  target: pricingTarget,
  validFrom: dateTime,
  validUntil: dateTime.optional(),
  label: z.string().min(1).max(140),
  previousVersionId: z.guid().optional(),
});
const archiveRequest = z.strictObject({ reason: z.string().min(3).max(500) });
const pricingSimulationRequest = z.strictObject({
  ruleId: z.guid().optional(),
  object: z.enum(['case_fee', 'recovery_commission', 'study_fee']),
  target: pricingTarget,
  baseAmount: money,
  stage: z.enum(['notice', 'payment_plan', 'amicable', 'formal_notice', 'bailiff', 'litigation']).optional(),
});
const contactWindow = z.strictObject({
  start: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  end: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
});
const scoreWeights = z.strictObject({
  debtAge: z.number().int().min(0).max(100),
  writtenAcknowledgment: z.number().int().min(0).max(100),
  evidenceQuality: z.number().int().min(0).max(100),
  amount: z.number().int().min(0).max(100),
  validContacts: z.number().int().min(0).max(100),
  partialPayments: z.number().int().min(0).max(100),
});
const settings = z.strictObject({
  minimumCaseAmount: money,
  feePaymentDays: z.number().int().min(1).max(30),
  reviewBusinessDays: z.number().int().min(1).max(10),
  infoCompletionDays: z.number().int().min(3).max(60),
  noticeResponseDays: z.number().int().min(3).max(30),
  installmentGraceDays: z.number().int().min(0).max(15),
  missedInstallmentsBeforeAmicable: z.number().int().min(1).max(5),
  amicableDurationDays: z.number().int().min(7).max(90),
  formalNoticeDays: z.number().int().min(8).max(60),
  creditorApprovalDays: z.number().int().min(3).max(60),
  disputeAnswerDays: z.number().int().min(3).max(30),
  prescriptionAlertDays: z.number().int().min(30).max(365),
  contactWindow: contactWindow,
  debtorLinkDays: z.number().int().min(7).max(90),
  remittanceBusinessDays: z.number().int().min(1).max(30),
  closedCaseRetentionYears: z.number().int().min(1).max(10),
  defaultB2bScale: planScale,
  defaultB2cScale: planScale,
  defaultRentScale: planScale,
  scoreWeights: scoreWeights,
  planCreditorApprovalDays: z.number().int().min(1).max(15),
  partnerSilenceAlertDays: z.number().int().min(3).max(60),
  debtorSessionMinutes: z.number().int().min(5).max(120),
  unrecoverableAfterMonths: z.number().int().min(1).max(24),
});
const holiday = z.strictObject({ date: day, label: z.string().min(1).max(100) });
const holidays = z.strictObject({ holidays: z.array(holiday).max(40) });

/**
 * Corps des routes du recouvrement (ADR-060 à 062), repris du contrat OpenAPI : tout champ inconnu
 * est refusé. recovery revérifie les règles métier (barème, montant dû, états, droits).
 */
export const recoveryBodies = {
  recoveryEstimateCaseFees: feeEstimateRequest,
  recoveryCreateCase: caseInput,
  recoveryUpdateCase: updateCaseRequest,
  recoveryAddCaseDocument: addDocumentRequest,
  recoveryPrepareMandate: prepareMandateRequest,
  recoveryCreateCaseImport: createImportRequest,
  recoveryUpdateCaseImportLine: updateImportLineRequest,
  recoveryAnswerDecision: answerDecisionRequest,
  recoveryStopCase: stopCaseRequest,
  recoveryDeclareDirectPayment: directPaymentRequest,
  recoveryUpdateMyPreferences: creditorPreferences,
  recoveryVerifyDebtorAccessCode: debtorCodeRequest,
  recoveryCreateDebtorPayment: debtorPaymentRequest,
  recoverySimulateDebtorPaymentPlan: planSimulationRequest,
  recoveryProposeDebtorPaymentPlan: debtorPlanRequest,
  recoveryDisputeDebtorCase: debtorDisputeRequest,
  recoveryCreateDebtorUpload: debtorUploadRequest,
  recoveryRequestDebtorCallback: debtorCallbackRequest,
  recoveryRecordLegalAct: legalActRequest,
  recoveryDeclarePartnerCollection: partnerCollectionRequest,
  recoveryAdminAssessCase: assessCaseRequest,
  recoveryAdminAssignCase: assignCaseRequest,
  recoveryAdminRecordContact: contactRequest,
  recoveryAdminRecordPromise: promiseRequest,
  recoveryAdminSendDebtorMessage: debtorMessageRequest,
  recoveryAdminAddNote: noteRequest,
  recoveryAdminProposePaymentPlan: planProposalRequest,
  recoveryAdminApprovePaymentPlan: planApprovalRequest,
  recoveryAdminProposeSettlement: settlementRequest,
  recoveryAdminChangeStage: stageChangeRequest,
  recoveryAdminIssueFormalNotice: formalNoticeRequest,
  recoveryAdminRecordNoticeDelivery: noticeDeliveryRequest,
  recoveryAdminResolveDispute: disputeResolutionRequest,
  recoveryAdminRequestEscalation: escalationRequest,
  recoveryAdminAssignPartner: assignPartnerRequest,
  recoveryAdminWithdrawPartner: withdrawPartnerRequest,
  recoveryAdminRecordOfflinePayment: offlinePaymentRequest,
  recoveryAdminRejectOfflinePayment: rejectRequest,
  recoveryAdminRecordOverpaymentRefund: overpaymentRefundRequest,
  recoveryAdminCloseCase: closeCaseRequest,
  recoveryAdminCreatePartner: partnerInput,
  recoveryAdminUpdatePartner: updatePartnerRequest,
  recoveryAdminCreatePricingRule: pricingRuleInput,
  recoveryAdminUpdatePricingRule: pricingRuleInput,
  recoveryAdminArchivePricingRule: archiveRequest,
  recoveryAdminSimulatePricing: pricingSimulationRequest,
  recoveryAdminUpdateSettings: settings,
  recoveryAdminSetHolidays: holidays,
};

/** Paramètres de requête des listes du recouvrement, repris du contrat ; les autres sont ignorés. */
export const recoveryQueries = {
  recoveryListMyCases: z.object({
    status: z
      .enum([
        'draft',
        'awaiting_fee',
        'under_review',
        'info_requested',
        'active',
        'suspended',
        'closed',
        'rejected',
      ])
      .optional(),
    stage: z
      .enum(['notice', 'payment_plan', 'amicable', 'formal_notice', 'bailiff', 'litigation'])
      .optional(),
    kind: z.enum(['b2b', 'b2c', 'rent']).optional(),
    search: z.string().min(3).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryListMyCaseJournal: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryListMyDecisions: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'answered', 'expired']).optional(),
    caseId: z.guid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryListMyRemittances: z.object({
    caseId: z.guid().optional(),
    from: day.optional(),
    to: day.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryListMyStatements: z.object({
    period: z
      .string()
      .regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    caseId: z.guid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryListMyAssignments: z.object({
    status: z.enum(['active', 'withdrawn', 'completed']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryAdminOverview: z.object({ communeKey: z.string().max(60).optional() }),
  recoveryAdminWorkQueue: z.object({ day: day.optional() }),
  recoveryAdminListCases: z.object({
    status: z
      .enum([
        'draft',
        'awaiting_fee',
        'under_review',
        'info_requested',
        'active',
        'suspended',
        'closed',
        'rejected',
      ])
      .optional(),
    stage: z
      .enum(['notice', 'payment_plan', 'amicable', 'formal_notice', 'bailiff', 'litigation'])
      .optional(),
    kind: z.enum(['b2b', 'b2c', 'rent']).optional(),
    agentId: z.guid().optional(),
    creditorId: z.guid().optional(),
    partnerId: z.guid().optional(),
    communeKey: z.string().max(60).optional(),
    search: z.string().min(3).max(100).optional(),
    idleDays: z.coerce.number().int().min(1).max(365).optional(),
    prescriptionNear: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryAdminListCaseJournal: z.object({
    includeInternal: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryAdminSuggestPartners: z.object({ kind: z.enum(['bailiff', 'lawyer']) }),
  recoveryAdminListOfflinePayments: z.object({
    status: z.enum(['pending_approval', 'approved', 'rejected']).optional(),
    caseId: z.guid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryAdminListPartners: z.object({
    kind: z.enum(['bailiff', 'lawyer']).optional(),
    status: z.enum(['pending_verification', 'active', 'suspended']).optional(),
    communeKey: z.string().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
  recoveryAdminListPricingRules: z.object({
    object: z.enum(['case_fee', 'recovery_commission', 'study_fee']).optional(),
    status: z.enum(['draft', 'pending_approval', 'published', 'archived']).optional(),
    offer: z.enum(['b2b', 'b2c', 'rent', 'any']).optional(),
    creditorId: z.guid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.guid().optional(),
  }),
};

/** Paramètres de chemin du recouvrement. */
export const recoveryParams = {
  id: z.guid(),
  row: z.coerce.number().int().min(1).max(10000),
  year: z.coerce.number().int().min(2020).max(2100),
  /** Jeton du lien du débiteur ou de sa session (ADR-061) : un jeton mal formé n'appelle pas recovery. */
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
};
