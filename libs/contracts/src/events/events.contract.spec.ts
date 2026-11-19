import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { type BillingEventPayloads, type BillingEventType } from './billing.events';
import { type CleaningEventPayloads, type CleaningEventType } from './cleaning.events';
import { type DocumentEventPayloads, type DocumentEventType } from './document.events';
import { type IdentityEventPayloads, type IdentityEventType } from './identity.events';
import { type NotificationEventPayloads, type NotificationEventType } from './notification.events';
import { type PaymentEventPayloads, type PaymentEventType } from './payment.events';
import { type WalletEventPayloads, type WalletEventType } from './wallet.events';

const EVENTS_ROOT = resolve(__dirname, '..', '..', '..', '..', 'contracts', 'events');

function loadSchemas(service: string): Map<string, object> {
  const dir = join(EVENTS_ROOT, service);
  const schemas = new Map<string, object>();
  for (const file of readdirSync(dir)) {
    const schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    schemas.set(schema['x-event-type'], schema);
  }
  return schemas;
}

const uuid = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f';

/** Un exemple valide par événement : si un type TS diverge du schéma, ce test casse. */
const examples: { [K in IdentityEventType]: IdentityEventPayloads[K] } = {
  'identity.user.registered': { userId: uuid, method: 'phone' },
  'identity.otp.requested': {
    userId: null,
    purpose: 'login',
    channel: 'sms',
    targetMasked: '+229 01 ** ** ** 45',
  },
  'identity.user.verified': { userId: uuid, verifiedVia: 'email' },
  'identity.user.suspended': { userId: uuid, reason: 'Fraude signalée', suspendedBy: uuid },
  'identity.user.reactivated': { userId: uuid, reactivatedBy: uuid },
  'identity.user.deleted': { userId: uuid },
  'identity.user.deletion_requested': {
    userId: uuid,
    requestedAt: '2026-11-05T10:00:00.000Z',
    scheduledFor: '2026-12-05T10:00:00.000Z',
  },
  'identity.user.deletion_cancelled': { userId: uuid },
  'identity.user.mfa_reset': { userId: uuid, enrollBefore: '2026-11-07T11:00:00.000Z' },
  'identity.organization.created': { organizationId: uuid, createdBy: uuid, legalName: 'SARL Bénin Propre' },
  'identity.organization.validated': {
    organizationId: uuid,
    legalName: 'SARL Bénin Propre',
    createdBy: uuid,
    validatedBy: uuid,
  },
  'identity.organization.rejected': {
    organizationId: uuid,
    legalName: 'SARL Bénin Propre',
    createdBy: uuid,
    rejectedBy: uuid,
    reason: 'IFU introuvable au registre',
  },
  'identity.organization.suspended': {
    organizationId: uuid,
    legalName: 'SARL Bénin Propre',
    suspendedBy: uuid,
    createdBy: uuid,
    reason: 'Usurpation signalée',
  },
  'identity.organization.reactivated': {
    organizationId: uuid,
    legalName: 'SARL Bénin Propre',
    reactivatedBy: uuid,
    createdBy: uuid,
  },
  'identity.member.added': { organizationId: uuid, userId: uuid, orgRole: 'org_member' },
  'identity.member.removed': { organizationId: uuid, userId: uuid, removedBy: uuid },
  'identity.role.granted': {
    assignmentId: uuid,
    userId: uuid,
    roleCode: 'seller',
    scopeType: 'org',
    scopeId: uuid,
    grantedBy: 'system',
  },
  'identity.role.revoked': { assignmentId: uuid, userId: uuid, roleCode: 'seller', revokedBy: uuid },
};

describe('Contrats des événements identity', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('identity');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(examples).sort());
  });

  it.each(Object.entries(examples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it('identity.otp.requested refuse tout champ qui pourrait contenir le code', () => {
    const validate = ajv.compile(schemas.get('identity.otp.requested')!);
    expect(validate({ ...examples['identity.otp.requested'], code: '123456' })).toBe(false);
  });

  it('l’enveloppe exige un type au format <service>.<entité>.<action>', () => {
    const envelope = JSON.parse(readFileSync(join(EVENTS_ROOT, 'envelope.schema.json'), 'utf8'));
    const validate = ajv.compile(envelope);
    const base = {
      eventId: uuid,
      version: 1,
      occurredAt: '2026-10-10T10:00:00Z',
      producer: 'identity',
      correlationId: 'c-1',
      payload: {},
    };
    expect(validate({ ...base, type: 'identity.user.registered' })).toBe(true);
    expect(validate({ ...base, type: 'UserRegistered' })).toBe(false);
  });
});

const notificationExamples: { [K in NotificationEventType]: NotificationEventPayloads[K] } = {
  'notification.message.failed': {
    notificationId: uuid,
    templateCode: 'identity.otp',
    channelsTried: ['sms', 'whatsapp'],
    reason: 'provider_unavailable',
    recipientUserId: null,
    targetMasked: '+229 01 ** ** ** 45',
  },
};

describe('Contrats des événements notification', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('notification');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(notificationExamples).sort());
  });

  it.each(Object.entries(notificationExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it.each(['variables', 'content', 'text'])(
    'notification.message.failed refuse le champ « %s », qui pourrait contenir un code',
    (field) => {
      const validate = ajv.compile(schemas.get('notification.message.failed')!);
      expect(validate({ ...notificationExamples['notification.message.failed'], [field]: '123456' })).toBe(
        false,
      );
    },
  );
});

const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

const cleaningExamples: { [K in CleaningEventType]: CleaningEventPayloads[K] } = {
  'cleaning.request.submitted': {
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    placeTypeId: uuid,
    cleaningTypeIds: [uuid],
    visitFee: xof(5000),
    visitFeeStatus: 'paid',
    submittedAt: '2026-12-01T08:00:00Z',
    communeKey: 'cotonou',
    placeTypeName: 'Villa',
    cleaningTypeNames: ['Sol', 'Vitres'],
  },
  'cleaning.request.cancelled': {
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    cause: 'customer',
    visitFeeRefund: xof(5000),
    cancelledAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.request.rejected': {
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    reasonCode: 'place_inaccessible',
    rejectedBy: uuid,
    visitFeeRefund: xof(5000),
    rejectedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.request.visit_fee_paid': {
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    visitFeeId: uuid,
    rank: 3,
    amount: xof(5000),
    invoiceId: uuid,
    paidAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.request.reactivation_requested': {
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    communeKey: 'cotonou',
    requestedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.visit.scheduled': {
    visitId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    agentIds: [uuid],
    scheduledAt: '2026-12-01T08:00:00Z',
    durationMinutes: 60,
    previousScheduledAt: null,
    releasedAgentIds: [uuid],
    placeTypeName: 'Villa',
    cleaningTypeNames: ['Sol', 'Vitres'],
  },
  'cleaning.visit.arrived': {
    visitId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    communeKey: 'cotonou',
    distanceMeters: 1,
    alert: false,
    arrivedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.visit.completed': {
    visitId: uuid,
    requestId: uuid,
    customerId: uuid,
    organizationId: null,
    agentIds: [uuid],
    completedAt: '2026-12-01T08:00:00Z',
    requestNumber: 'DN-000124',
    completedBy: 'agent',
  },
  'cleaning.visit.missed': {
    visitId: uuid,
    requestId: uuid,
    customerId: uuid,
    organizationId: null,
    missedAt: '2026-12-01T08:00:00Z',
    requestNumber: 'DN-000124',
    communeKey: 'cotonou',
    reportedBy: 'agent',
    newVisitFee: xof(5000),
    newVisitFeePayBefore: '2026-12-01T08:00:00Z',
  },
  'cleaning.visit.cancelled': {
    visitId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    communeKey: 'cotonou',
    releasedAgentIds: [uuid],
    scheduledAt: '2026-12-01T08:00:00Z',
    cause: 'request_cancelled',
    visitFeeRefund: xof(5000),
    cancelledAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.quote.sent': {
    quoteId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    kind: 'initial',
    version: 1,
    sessionPrice: xof(32040),
    sessionsCount: 15,
    total: xof(480600),
    visitFeeDeduction: xof(5000),
    validUntil: '2026-12-01T08:00:00Z',
    sentAt: '2026-12-01T08:00:00Z',
    placeTypeName: 'Villa',
    cleaningTypeNames: ['Sol', 'Vitres'],
  },
  'cleaning.quote.accepted': {
    quoteId: uuid,
    requestId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    acceptedBy: uuid,
    total: xof(480600),
    acceptedAt: '2026-12-01T08:00:00Z',
    requestNumber: 'DN-000124',
  },
  'cleaning.quote.declined': {
    quoteId: uuid,
    requestId: uuid,
    customerId: uuid,
    organizationId: null,
    declinedBy: uuid,
    reasonCode: null,
    declinedAt: '2026-12-01T08:00:00Z',
    requestNumber: 'DN-000124',
    communeKey: 'cotonou',
  },
  'cleaning.quote.expired': {
    quoteId: uuid,
    requestId: uuid,
    customerId: uuid,
    organizationId: null,
    validUntil: '2026-12-01T08:00:00Z',
    expiredAt: '2026-12-01T08:00:00Z',
    requestNumber: 'DN-000124',
    communeKey: 'cotonou',
    total: xof(480600),
    placeTypeName: 'Villa',
    cleaningTypeNames: ['Sol', 'Vitres'],
  },
  'cleaning.quote.withdrawn': {
    quoteId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    version: 1,
    withdrawnAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.quote.expiry_reminded': {
    quoteId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    total: xof(480600),
    validUntil: '2026-12-01T08:00:00Z',
    reminderDays: 2,
    remindedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.quote.forwarded': {
    quoteId: uuid,
    requestId: uuid,
    requestNumber: 'DN-000124',
    customerId: uuid,
    organizationId: null,
    forwardedBy: uuid,
    forwardedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.program.confirmed': {
    programId: uuid,
    programNumber: 'PN-000057',
    quoteId: uuid,
    requestId: uuid,
    customerId: uuid,
    organizationId: null,
    payerKind: 'individual',
    sessionsCount: 15,
    sessionPrice: xof(32040),
    total: xof(480600),
    visitFeeDeduction: xof(5000),
    firstSessionAt: '2026-12-01T08:00:00Z',
    lastSessionAt: '2026-12-01T08:00:00Z',
    confirmedAt: '2026-12-01T08:00:00Z',
    placeTypeName: 'Villa',
    cleaningTypeNames: ['Sol', 'Vitres'],
  },
  'cleaning.program.suspended': {
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    causes: ['overdue_sessions'],
    suspendedSessionIds: [uuid],
    releasedAgentIds: [uuid],
    suspendedAt: '2026-12-01T08:00:00Z',
    communeKey: 'cotonou',
    unpaidCount: 2,
    overdueCount: 1,
    threshold: 1,
  },
  'cleaning.program.suspension_updated': {
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    change: 'cause_added',
    cause: 'overdue_sessions',
    causes: ['overdue_sessions'],
    unpaidCount: 2,
    overdueCount: 1,
    updatedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.program.resumed': {
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    sessionsToAssign: 9,
    catchUpSessionIds: [uuid],
    resumedAt: '2026-12-01T08:00:00Z',
    communeKey: 'cotonou',
    liftedCause: 'overdue_sessions',
  },
  'cleaning.program.completed': {
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    sessionsCompleted: 14,
    sessionsMissed: 1,
    sessionsCancelled: 0,
    completedAt: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    planKind: 'one_off',
  },
  'cleaning.program.cancelled': {
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    cancelledBy: 'customer',
    cancelledByUserId: uuid,
    cancelledSessionIds: [uuid],
    cancelledAt: '2026-12-01T08:00:00Z',
    releasedAgentIds: [uuid],
  },
  'cleaning.session.assigned': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    rank: 3,
    scheduledStart: '2026-12-01T08:00:00Z',
    agentIds: [uuid],
    leadAgentId: uuid,
    source: 'manual',
    assignedAt: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    sessionsCount: 15,
    batchId: uuid,
    teamIncomplete: false,
  },
  'cleaning.session.unassigned': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    agentIds: [uuid],
    cause: 'manual',
    unassignedAt: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
    batchId: uuid,
  },
  'cleaning.sessions.batch_assigned': {
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    batchId: uuid,
    sessionIds: [uuid],
    count: 2,
    firstStart: '2026-12-01T08:00:00Z',
    lastStart: '2026-12-01T08:00:00Z',
    agentIds: [uuid],
    leadAgentId: uuid,
    source: 'manual',
    assignedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.staffing_alert': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    communeKey: 'cotonou',
    scheduledStart: '2026-12-01T08:00:00Z',
    level: 'unassigned_48h',
    missingAgents: 1,
    alertedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.rescheduled': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    rank: 3,
    previousStart: '2026-12-01T08:00:00Z',
    scheduledStart: '2026-12-01T08:00:00Z',
    scheduledEnd: '2026-12-01T08:00:00Z',
    rescheduledBy: 'customer',
    rescheduledAt: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    sessionsCount: 15,
    agentIds: [uuid],
    releasedAgentIds: [uuid],
    durationMinutes: 60,
  },
  'cleaning.session.cancelled': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
    cancelledBy: 'customer',
    cause: 'customer',
    releasedAgentIds: [uuid],
    cancelledAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.reminder': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
    agentIds: [uuid],
    amountDue: xof(32040),
    balanceSufficient: false,
    remindedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.balance_insufficient': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
    amountDue: xof(32040),
    missing: xof(7000),
    guaranteeRequired: false,
    trigger: 'assigned',
    detectedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.arrived': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    communeKey: 'cotonou',
    distanceMeters: 1,
    alert: false,
    arrivedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.started': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    leadAgentId: uuid,
    startedAt: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
  },
  'cleaning.session.interrupted': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    communeKey: 'cotonou',
    incidentId: uuid,
    category: 'equipment',
    interruptedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.completed': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    payerKind: 'individual',
    placeId: uuid,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
    price: xof(32040),
    visitFeeDeduction: xof(5000),
    amountDue: xof(27040),
    completedAt: '2026-12-01T08:00:00Z',
    completedBy: 'team',
  },
  'cleaning.session.missed': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: uuid,
    payerKind: 'organization',
    placeId: uuid,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
    price: xof(32040),
    visitFeeDeduction: xof(0),
    amountDue: xof(16020),
    cause: 'customer_absent',
    feeBps: 5000,
    missedAt: '2026-12-01T08:00:00Z',
    communeKey: 'cotonou',
    reportedBy: 'team',
  },
  'cleaning.session.payment_due': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    amountDue: xof(32040),
    dueBy: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
    scheduledStart: '2026-12-01T08:00:00Z',
  },
  'cleaning.session.paid': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    amountPaid: xof(27040),
    visitFeeDeduction: xof(5000),
    walletTransactionId: uuid,
    invoiceId: uuid,
    paidAt: '2026-12-01T08:00:00Z',
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
  },
  'cleaning.session.overdue': {
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    amountDue: xof(32040),
    overdueSince: '2026-12-01T08:00:00Z',
    overdueCount: 1,
    communeKey: 'cotonou',
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 15,
  },
  'cleaning.organization.unpaid_warning': {
    organizationId: uuid,
    unpaidCount: 2,
    warningThreshold: 1,
    suspensionThreshold: 2,
    overdueInvoiceIds: [uuid],
    warnedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.direct_payment.left_in_wallet': {
    directPaymentId: uuid,
    customerId: uuid,
    organizationId: null,
    objectType: 'visit_fee',
    objectId: uuid,
    amount: xof(5000),
    cause: 'request_closed',
    leftAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.agent.applied': {
    agentId: uuid,
    userId: uuid,
    source: 'self',
    appliedAt: '2026-12-01T08:00:00Z',
    zoneKeys: ['cotonou', 'abomey-calavi'],
  },
  'cleaning.agent.approved': {
    agentId: uuid,
    userId: uuid,
    approvedBy: uuid,
    skillCodes: ['vidange', 'jardinage'],
    employmentKind: 'employee',
    approvedAt: '2026-12-01T08:00:00Z',
  },
  'cleaning.claim.opened': {
    claimId: uuid,
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    category: 'incomplete_work',
    openedAt: '2026-12-01T08:00:00Z',
    communeKey: 'cotonou',
  },
  'cleaning.claim.resolved': {
    claimId: uuid,
    sessionId: uuid,
    programId: uuid,
    customerId: uuid,
    organizationId: null,
    outcome: 'wallet_credit',
    creditAmount: xof(10000),
    redoSessionId: null,
    resolvedAt: '2026-12-01T08:00:00Z',
  },
};

/** Les 45 événements publiés de la partie 15.5 du cahier des charges Nettoyage v2. */
const CLEANING_PUBLISHED_EVENTS = [
  'cleaning.request.submitted',
  'cleaning.request.cancelled',
  'cleaning.request.rejected',
  'cleaning.request.visit_fee_paid',
  'cleaning.request.reactivation_requested',
  'cleaning.visit.scheduled',
  'cleaning.visit.arrived',
  'cleaning.visit.completed',
  'cleaning.visit.missed',
  'cleaning.visit.cancelled',
  'cleaning.quote.sent',
  'cleaning.quote.accepted',
  'cleaning.quote.declined',
  'cleaning.quote.expired',
  'cleaning.quote.withdrawn',
  'cleaning.quote.expiry_reminded',
  'cleaning.quote.forwarded',
  'cleaning.program.confirmed',
  'cleaning.program.suspended',
  'cleaning.program.suspension_updated',
  'cleaning.program.resumed',
  'cleaning.program.completed',
  'cleaning.program.cancelled',
  'cleaning.session.assigned',
  'cleaning.session.unassigned',
  'cleaning.sessions.batch_assigned',
  'cleaning.session.staffing_alert',
  'cleaning.session.rescheduled',
  'cleaning.session.cancelled',
  'cleaning.session.reminder',
  'cleaning.session.balance_insufficient',
  'cleaning.session.arrived',
  'cleaning.session.started',
  'cleaning.session.interrupted',
  'cleaning.session.completed',
  'cleaning.session.missed',
  'cleaning.session.payment_due',
  'cleaning.session.paid',
  'cleaning.session.overdue',
  'cleaning.organization.unpaid_warning',
  'cleaning.direct_payment.left_in_wallet',
  'cleaning.agent.applied',
  'cleaning.agent.approved',
  'cleaning.claim.opened',
  'cleaning.claim.resolved',
];

describe('Contrats des événements cleaning (v2)', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('cleaning');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(cleaningExamples).sort());
  });

  it('publie exactement les 45 événements de la partie 15.5', () => {
    expect(Object.keys(cleaningExamples).sort()).toEqual([...CLEANING_PUBLISHED_EVENTS].sort());
  });

  it('chaque type respecte le format de l’enveloppe commune', () => {
    const envelope = JSON.parse(readFileSync(join(EVENTS_ROOT, 'envelope.schema.json'), 'utf8'));
    const validate = ajv.compile(envelope);
    for (const type of CLEANING_PUBLISHED_EVENTS) {
      const event = {
        eventId: uuid,
        type,
        version: 1,
        occurredAt: '2026-12-01T08:00:00Z',
        producer: 'cleaning',
        correlationId: 'c-1',
        payload: cleaningExamples[type as CleaningEventType],
      };
      expect(validate(event)).toBe(true);
    }
  });

  it.each(Object.entries(cleaningExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload) ? [] : validate.errors).toEqual([]);
  });

  it.each([
    'address',
    'landmark',
    'location',
    'latitude',
    'longitude',
    'gps',
    'phone',
    'comment',
    'reason',
    'note',
    'text',
  ])('aucun événement cleaning n’accepte le champ « %s » (données personnelles, texte libre)', (field) => {
    for (const [type, payload] of Object.entries(cleaningExamples)) {
      const validate = ajv.compile(schemas.get(type)!);
      expect(validate({ ...payload, [field]: 'Rue 12, Cotonou' })).toBe(false);
    }
  });

  it('chaque schéma refuse les champs inconnus', () => {
    for (const schema of schemas.values()) {
      expect((schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it.each(['cleaning.session.completed', 'cleaning.session.missed'] as const)(
    '%s porte le montant dû (billing construit la facture sans rappeler cleaning)',
    (type) => {
      const validate = ajv.compile(schemas.get(type)!);
      const { amountDue: _amountDue, ...withoutAmount } = cleaningExamples[type];
      expect(validate(withoutAmount)).toBe(false);
      expect(validate({ ...cleaningExamples[type], amountDue: xof(0) })).toBe(true);
    },
  );

  it('séance manquée : part due en points de base, cause dans la liste', () => {
    const validate = ajv.compile(schemas.get('cleaning.session.missed')!);
    const base = cleaningExamples['cleaning.session.missed'];
    expect(validate({ ...base, feeBps: 10001 })).toBe(false);
    expect(validate({ ...base, cause: 'late_cancellation' })).toBe(true);
    expect(validate({ ...base, cause: 'weather' })).toBe(false);
  });

  it('les montants sont des entiers positifs ou nuls en XOF', () => {
    const validate = ajv.compile(schemas.get('cleaning.session.completed')!);
    const base = cleaningExamples['cleaning.session.completed'];
    expect(validate({ ...base, amountDue: { amount: 450.5, currency: 'XOF' } })).toBe(false);
    expect(validate({ ...base, amountDue: { amount: 450, currency: 'EUR' } })).toBe(false);
    expect(validate({ ...base, price: { amount: -1, currency: 'XOF' } })).toBe(false);
  });

  it('suspension : au moins une cause, sans doublon', () => {
    const validate = ajv.compile(schemas.get('cleaning.program.suspended')!);
    const base = cleaningExamples['cleaning.program.suspended'];
    expect(validate({ ...base, causes: ['overdue_sessions', 'ksp_decision'] })).toBe(true);
    expect(validate({ ...base, causes: [] })).toBe(false);
    expect(validate({ ...base, causes: ['ksp_decision', 'ksp_decision'] })).toBe(false);
  });

  it('les identifiants sont des UUID', () => {
    const validate = ajv.compile(schemas.get('cleaning.request.submitted')!);
    expect(validate({ ...cleaningExamples['cleaning.request.submitted'], requestId: 'DN-000124' })).toBe(
      false,
    );
  });

  it('demande envoyée : commune et libellés du catalogue en vigueur (RV-02)', () => {
    const validate = ajv.compile(schemas.get('cleaning.request.submitted')!);
    const { placeTypeName: _name, ...withoutName } = cleaningExamples['cleaning.request.submitted'];
    const { communeKey: _commune, ...withoutCommune } = cleaningExamples['cleaning.request.submitted'];
    expect(validate(withoutName)).toBe(false);
    expect(validate(withoutCommune)).toBe(false);
  });

  it('visite manquée : toujours le client absent, avec de nouveaux frais (R-VI-05)', () => {
    const validate = ajv.compile(schemas.get('cleaning.visit.missed')!);
    const base = cleaningExamples['cleaning.visit.missed'];
    const { newVisitFee: _fee, ...withoutFee } = base;
    expect(validate(withoutFee)).toBe(false);
    expect(validate({ ...base, cause: 'agent_no_show' })).toBe(false);
    expect(validate({ ...base, reportedBy: 'ksp' })).toBe(true);
  });

  it('visite annulée : cause dans la liste, absence de l’agent comprise (R-VI-06, R-FV-06)', () => {
    const validate = ajv.compile(schemas.get('cleaning.visit.cancelled')!);
    const base = cleaningExamples['cleaning.visit.cancelled'];
    expect(validate({ ...base, cause: 'agent_no_show', visitFeeRefund: xof(5000) })).toBe(true);
    expect(validate({ ...base, cause: 'weather' })).toBe(false);
  });

  it.each([
    ['cleaning.visit.completed', 'completedBy', ['agent', 'ksp']],
    ['cleaning.session.completed', 'completedBy', ['team', 'ksp']],
    ['cleaning.session.missed', 'reportedBy', ['team', 'ksp']],
  ] as const)(
    '%s : %s dit si le back-office a clôturé pour l’équipe (R-EX-08, R-VI-08)',
    (type, field, values) => {
      const validate = ajv.compile(schemas.get(type)!);
      for (const value of values) expect(validate({ ...cleaningExamples[type], [field]: value })).toBe(true);
      expect(validate({ ...cleaningExamples[type], [field]: 'support' })).toBe(false);
    },
  );

  it('séance désaffectée : la suspension n’est plus une cause (cleaning.program.suspended porte les agents libérés)', () => {
    const validate = ajv.compile(schemas.get('cleaning.session.unassigned')!);
    const base = cleaningExamples['cleaning.session.unassigned'];
    expect(validate({ ...base, cause: 'rescheduled' })).toBe(true);
    expect(validate({ ...base, cause: 'program_suspended' })).toBe(false);
  });

  it('récapitulatif d’affectation : au moins deux séances d’un programme (R-PL-11)', () => {
    const validate = ajv.compile(schemas.get('cleaning.sessions.batch_assigned')!);
    const base = cleaningExamples['cleaning.sessions.batch_assigned'];
    expect(validate({ ...base, count: 1 })).toBe(false);
    expect(validate({ ...base, count: 12 })).toBe(true);
  });

  it('alerte de couverture : niveau dans la liste (R-PL-10)', () => {
    const validate = ajv.compile(schemas.get('cleaning.session.staffing_alert')!);
    const base = cleaningExamples['cleaning.session.staffing_alert'];
    expect(validate({ ...base, level: 'agent_absent' })).toBe(true);
    expect(validate({ ...base, level: 'late' })).toBe(false);
  });

  it('séance annulée : cause « aucun agent » possible, jamais l’arrêt du programme', () => {
    const validate = ajv.compile(schemas.get('cleaning.session.cancelled')!);
    const base = cleaningExamples['cleaning.session.cancelled'];
    expect(validate({ ...base, cancelledBy: 'ksp', cause: 'no_agent' })).toBe(true);
    expect(validate({ ...base, cause: 'program_stopped' })).toBe(false);
  });

  it('rappel de la veille : solde non précisé pour une entreprise (R-PP-05)', () => {
    const validate = ajv.compile(schemas.get('cleaning.session.reminder')!);
    const base = cleaningExamples['cleaning.session.reminder'];
    expect(validate({ ...base, organizationId: uuid, amountDue: null, balanceSufficient: null })).toBe(true);
    expect(validate({ ...base, balanceSufficient: 'non' })).toBe(false);
  });

  it('cause de suspension mise à jour : au moins une cause encore active (R-SU-01)', () => {
    const validate = ajv.compile(schemas.get('cleaning.program.suspension_updated')!);
    const base = cleaningExamples['cleaning.program.suspension_updated'];
    expect(validate({ ...base, change: 'cause_lifted', causes: ['unpaid_invoices'] })).toBe(true);
    expect(validate({ ...base, causes: [] })).toBe(false);
  });

  it('reprise : la dernière cause levée est dite', () => {
    const validate = ajv.compile(schemas.get('cleaning.program.resumed')!);
    const { liftedCause: _cause, ...withoutCause } = cleaningExamples['cleaning.program.resumed'];
    expect(validate(withoutCause)).toBe(false);
  });

  it('paiement laissé au wallet : objet et motif dans la liste (R-PP-07)', () => {
    const validate = ajv.compile(schemas.get('cleaning.direct_payment.left_in_wallet')!);
    const base = cleaningExamples['cleaning.direct_payment.left_in_wallet'];
    expect(validate({ ...base, objectType: 'session', cause: 'already_paid' })).toBe(true);
    expect(validate({ ...base, cause: 'other' })).toBe(false);
  });

  it('avertissement d’impayés : par organisation, jamais anonyme (R-PE-06)', () => {
    const validate = ajv.compile(schemas.get('cleaning.organization.unpaid_warning')!);
    const base = cleaningExamples['cleaning.organization.unpaid_warning'];
    expect(validate({ ...base, organizationId: null })).toBe(false);
    expect(validate({ ...base, unpaidCount: 0 })).toBe(false);
  });
});

const invoice = {
  invoiceId: uuid,
  invoiceNumber: 'FAC-2026-000042',
  customerId: uuid,
  organizationId: uuid,
  source: 'cleaning' as const,
  contractId: uuid,
  total: xof(160000),
};

const billingExamples: { [K in BillingEventType]: BillingEventPayloads[K] } = {
  'billing.invoice.issued': {
    ...invoice,
    periodStart: '2026-11-05T08:00:00Z',
    periodEnd: '2026-12-05T08:00:00Z',
    issuedAt: '2026-12-05T08:00:00Z',
    dueAt: '2026-12-15T08:00:00Z',
  },
  'billing.invoice.overdue': { ...invoice, dueAt: '2026-12-15T08:00:00Z', overdueCount: 1 },
  'billing.invoice.paid': { ...invoice, paidAt: '2026-12-16T10:00:00Z', overdueCount: 0 },
};

describe('Contrats des événements billing', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('billing');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(billingExamples).sort());
  });

  it.each(Object.entries(billingExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it('aucun événement billing n’accepte d’adresse, et les montants sont des entiers en XOF', () => {
    for (const [type, payload] of Object.entries(billingExamples)) {
      const validate = ajv.compile(schemas.get(type)!);
      expect(validate({ ...payload, address: 'Rue 12, Cotonou' })).toBe(false);
      expect(validate({ ...payload, total: { amount: 10.5, currency: 'XOF' } })).toBe(false);
    }
  });
});

const missionPayment = {
  paymentId: uuid,
  subjectType: 'cleaning_mission' as const,
  subjectId: uuid,
  part: 'deposit' as const,
  subjectReference: null,
  customerId: uuid,
  organizationId: null,
  amount: { amount: 15000, currency: 'XOF' as const },
  provider: 'fedapay' as const,
};

const paymentExamples: { [K in PaymentEventType]: PaymentEventPayloads[K] } = {
  'payment.intent.succeeded': {
    ...missionPayment,
    method: 'mobile_money_online',
    providerReference: 'trx_Ab12Cd34',
    succeededAt: '2026-11-02T09:15:00Z',
  },
  'payment.intent.failed': { ...missionPayment, status: 'cancelled', failedAt: '2026-11-02T09:20:00Z' },
  'payment.link.paid': {
    paymentLinkId: uuid,
    paymentId: uuid,
    subjectType: 'recovery_installment',
    subjectId: uuid,
    reference: 'REC-2026-000123 E2',
    amount: { amount: 25000, currency: 'XOF' },
    method: 'mobile_money_online',
    provider: 'fedapay',
    providerReference: 'trx_Ab12Cd34',
    paidAt: '2026-11-07T10:00:00Z',
  },
  'payment.payout.completed': {
    payoutId: uuid,
    issuer: 'wallet',
    reference: uuid,
    amount: { amount: 22500, currency: 'XOF' },
    provider: 'manual',
    providerReference: 'MTN-TRF-0042',
    completedAt: '2026-11-07T12:00:00Z',
  },
  'payment.payout.failed': {
    payoutId: uuid,
    issuer: 'wallet',
    reference: uuid,
    amount: { amount: 22500, currency: 'XOF' },
    provider: 'fedapay',
    failureCode: 'provider_failed',
    failedAt: '2026-11-07T12:00:00Z',
  },
};

describe('Contrats des événements payment', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('payment');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(paymentExamples).sort());
  });

  it.each(Object.entries(paymentExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it('une facture porte son numéro, une mission sa part (acompte ou solde)', () => {
    const validate = ajv.compile(schemas.get('payment.intent.succeeded')!);
    const succeeded = paymentExamples['payment.intent.succeeded'];
    expect(
      validate({
        ...succeeded,
        subjectType: 'billing_invoice',
        part: null,
        subjectReference: 'FAC-2026-000042',
        organizationId: uuid,
      }),
    ).toBe(true);
    expect(validate({ ...succeeded, subjectReference: 'facture 42' })).toBe(false);
    expect(validate({ ...succeeded, part: 'all' })).toBe(false);
  });

  it('une recharge du portefeuille désigne son titulaire, sans part ni référence (ADR-046)', () => {
    const validate = ajv.compile(schemas.get('payment.intent.succeeded')!);
    const succeeded = paymentExamples['payment.intent.succeeded'];
    expect(validate({ ...succeeded, subjectType: 'wallet_top_up', part: null })).toBe(true);
    const failed = ajv.compile(schemas.get('payment.intent.failed')!);
    expect(failed({ ...paymentExamples['payment.intent.failed'], subjectType: 'wallet_top_up' })).toBe(true);
  });

  it('un lien ne porte jamais un type d’objet réservé au paiement par compte', () => {
    const validate = ajv.compile(schemas.get('payment.link.paid')!);
    const paid = paymentExamples['payment.link.paid'];
    expect(validate({ ...paid, subjectType: 'billing_invoice' })).toBe(false);
    expect(validate({ ...paid, subjectType: 'wallet_top_up' })).toBe(false);
    expect(validate({ ...paid, subjectType: 'Recovery Installment' })).toBe(false);
    expect(validate({ ...paid, customerId: uuid })).toBe(false);
  });

  it('un reversement ne transmet ni le numéro ni le nom du bénéficiaire', () => {
    for (const type of ['payment.payout.completed', 'payment.payout.failed'] as const) {
      const validate = ajv.compile(schemas.get(type)!);
      expect(validate({ ...paymentExamples[type], beneficiaryPhone: '+2290197000045' })).toBe(false);
      expect(validate({ ...paymentExamples[type], beneficiaryName: 'Koffi' })).toBe(false);
    }
    const failed = ajv.compile(schemas.get('payment.payout.failed')!);
    expect(failed({ ...paymentExamples['payment.payout.failed'], reason: 'numéro inconnu' })).toBe(false);
  });

  it('aucune donnée personnelle (téléphone, nom), montants entiers et positifs en XOF', () => {
    for (const [type, payload] of Object.entries(paymentExamples)) {
      const validate = ajv.compile(schemas.get(type)!);
      expect(validate({ ...payload, phone: '+2290197000045' })).toBe(false);
      expect(validate({ ...payload, customerName: 'Koffi' })).toBe(false);
      expect(validate({ ...payload, amount: { amount: 10.5, currency: 'XOF' } })).toBe(false);
      expect(validate({ ...payload, amount: { amount: 0, currency: 'XOF' } })).toBe(false);
      expect(validate({ ...payload, amount: { amount: 100, currency: 'EUR' } })).toBe(false);
    }
  });
});

const sha = 'a'.repeat(64);

const documentExamples: { [K in DocumentEventType]: DocumentEventPayloads[K] } = {
  'document.signature.completed': {
    documentId: uuid,
    signatureRequestId: uuid,
    template: 'recovery_settlement_agreement',
    templateVersion: 1,
    producerService: 'recovery',
    subjectType: 'recovery_case',
    subjectId: uuid,
    ownerId: uuid,
    signerUserId: null,
    method: 'one_time_code',
    channel: 'whatsapp',
    documentSha256: sha,
    signedFileId: uuid,
    signedDocumentSha256: 'b'.repeat(64),
    signedAt: '2026-11-09T10:00:00.000Z',
  },
};

describe('Contrats des événements document', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('document');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(documentExamples).sort());
  });

  it.each(Object.entries(documentExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it('signature : aucune donnée personnelle du signataire, empreintes SHA-256 hexadécimales', () => {
    const validate = ajv.compile(schemas.get('document.signature.completed')!);
    const payload = documentExamples['document.signature.completed'];
    expect(validate({ ...payload, signerUserId: uuid })).toBe(true);
    expect(validate({ ...payload, phone: '+2290197000045' })).toBe(false);
    expect(validate({ ...payload, signerName: 'Koffi' })).toBe(false);
    expect(validate({ ...payload, ip: '197.234.1.2' })).toBe(false);
    expect(validate({ ...payload, code: '123456' })).toBe(false);
    expect(validate({ ...payload, documentSha256: 'ABC' })).toBe(false);
    expect(validate({ ...payload, method: 'handwritten' })).toBe(false);
  });
});

const walletHolder = { type: 'user' as const, id: uuid };

const walletExamples: { [K in WalletEventType]: WalletEventPayloads[K] } = {
  'wallet.prepaid.debited': {
    transactionId: uuid,
    holder: walletHolder,
    userId: uuid,
    amount: xof(15000),
    balanceAfter: xof(0),
    service: 'cleaning',
    objectType: 'cleaning_mission',
    objectId: uuid,
    part: 'deposit',
    description: 'Nettoyage de maison — acompte',
    debitedAt: '2026-11-09T10:00:00Z',
  },
  'wallet.prepaid.credited': {
    transactionId: uuid,
    kind: 'refund',
    origin: 'service',
    holder: walletHolder,
    userId: uuid,
    amount: xof(15000),
    balanceAfter: xof(15000),
    description: 'Remboursement : mission annulée',
    paymentId: null,
    refundedTransactionId: uuid,
    creditedAt: '2026-11-09T11:00:00Z',
  },
};

describe('Contrats des événements wallet', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('wallet');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(walletExamples).sort());
  });

  it.each(Object.entries(walletExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it('montants entiers en XOF, solde jamais négatif, aucune donnée personnelle', () => {
    for (const [type, payload] of Object.entries(walletExamples)) {
      const validate = ajv.compile(schemas.get(type)!);
      expect(validate({ ...payload, amount: xof(0) })).toBe(false);
      expect(validate({ ...payload, amount: { amount: 10.5, currency: 'XOF' } })).toBe(false);
      expect(validate({ ...payload, balanceAfter: { amount: -1, currency: 'XOF' } })).toBe(false);
      expect(validate({ ...payload, phone: '+2290197000045' })).toBe(false);
    }
  });
});
