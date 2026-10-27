import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { type BillingEventPayloads, type BillingEventType } from './billing.events';
import { type CleaningEventPayloads, type CleaningEventType } from './cleaning.events';
import { type IdentityEventPayloads, type IdentityEventType } from './identity.events';
import { type NotificationEventPayloads, type NotificationEventType } from './notification.events';

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
    reason: 'Usurpation signalée',
  },
  'identity.organization.reactivated': {
    organizationId: uuid,
    legalName: 'SARL Bénin Propre',
    reactivatedBy: uuid,
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
  'cleaning.quote.requested': {
    requestId: uuid,
    customerId: uuid,
    organizationId: null,
    customerKind: 'individual',
    serviceCode: 'home_cleaning',
    visitRequired: false,
  },
  'cleaning.visit.scheduled': {
    requestId: uuid,
    visitId: uuid,
    customerId: uuid,
    agentId: uuid,
    scheduledAt: '2026-11-02T09:00:00Z',
  },
  'cleaning.quote.sent': {
    requestId: uuid,
    quoteId: uuid,
    customerId: uuid,
    total: xof(45000),
    validUntil: '2026-11-17T09:00:00Z',
  },
  'cleaning.booking.confirmed': {
    requestId: uuid,
    quoteId: uuid,
    missionId: uuid,
    customerId: uuid,
    organizationId: uuid,
    total: xof(480000),
    plannedInterventions: 12,
    recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
    paymentPlan: { option: 'deposit', timing: 'before', method: 'cash' },
    depositAmount: xof(144000),
    startsAt: '2026-11-05T08:00:00Z',
  },
  'cleaning.mission.scheduled': {
    missionId: uuid,
    interventionId: uuid,
    customerId: uuid,
    scheduledStart: '2026-11-05T08:00:00Z',
    durationMinutes: 180,
    agentIds: [uuid],
  },
  'cleaning.mission.completed': {
    missionId: uuid,
    customerId: uuid,
    completedInterventions: 1,
    completedAt: '2026-11-05T11:00:00Z',
  },
  'cleaning.request.cancelled': {
    requestId: uuid,
    missionId: null,
    customerId: uuid,
    cancelledBy: 'customer',
    outcome: 'cancelled',
  },
  'cleaning.contract.suspension_warning': {
    missionId: uuid,
    customerId: uuid,
    organizationId: uuid,
    unpaidCount: 1,
    suspensionThreshold: 2,
  },
  'cleaning.contract.suspended': {
    missionId: uuid,
    customerId: uuid,
    organizationId: uuid,
    cause: 'unpaid_invoices',
    unpaidCount: 2,
    threshold: 2,
    cancelledInterventionIds: [uuid],
    releasedAgentIds: [uuid],
    suspendedAt: '2026-12-15T06:00:00Z',
  },
  'cleaning.contract.resumed': {
    missionId: uuid,
    customerId: uuid,
    organizationId: null,
    cause: 'unpaid_interventions',
    unpaidCount: 0,
    resumedAt: '2026-12-20T06:00:00Z',
    rescheduledCount: 3,
    failedCount: 1,
  },
  'cleaning.rescheduling.failed': {
    missionId: uuid,
    customerId: uuid,
    organizationId: uuid,
    interventionIds: [uuid],
    failedCount: 1,
  },
};

describe('Contrats des événements cleaning', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-event-type').addKeyword('x-event-version');
  const schemas = loadSchemas('cleaning');

  it('chaque type TypeScript a un schéma, et inversement', () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(cleaningExamples).sort());
  });

  it.each(Object.entries(cleaningExamples))('%s : l’exemple respecte le schéma', (type, payload) => {
    const validate = ajv.compile(schemas.get(type)!);
    expect(validate(payload)).toBe(true);
  });

  it.each(['address', 'comment', 'reason'])(
    'aucun événement cleaning n’accepte le champ « %s » (données personnelles)',
    (field) => {
      for (const [type, payload] of Object.entries(cleaningExamples)) {
        const validate = ajv.compile(schemas.get(type)!);
        expect(validate({ ...payload, [field]: 'Rue 12, Cotonou' })).toBe(false);
      }
    },
  );

  it('les montants sont des entiers en XOF', () => {
    const validate = ajv.compile(schemas.get('cleaning.quote.sent')!);
    const base = cleaningExamples['cleaning.quote.sent'];
    expect(validate({ ...base, total: { amount: 450.5, currency: 'XOF' } })).toBe(false);
    expect(validate({ ...base, total: { amount: 450, currency: 'EUR' } })).toBe(false);
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
