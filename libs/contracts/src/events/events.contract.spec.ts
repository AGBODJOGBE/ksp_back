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
  'cleaning.quote_group.requested': {
    groupId: uuid,
    customerId: uuid,
    organizationId: null,
    customerKind: 'individual',
    visitRequired: true,
    requests: [{ requestId: uuid, serviceCode: 'house_cleaning', serviceName: 'Nettoyage de maison' }],
  },
  'cleaning.quote_group.sent': {
    groupId: uuid,
    customerId: uuid,
    total: xof(45000),
    validUntil: '2026-11-17T09:00:00Z',
    quotes: [
      {
        requestId: uuid,
        quoteId: uuid,
        serviceCode: 'house_cleaning',
        serviceName: 'Nettoyage de maison',
        total: xof(45000),
      },
    ],
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
    schedulePeriod: { firstDate: '2026-11-05', lastDate: '2027-01-28' },
  },
  'cleaning.mission.scheduled': {
    missionId: uuid,
    interventionId: uuid,
    customerId: uuid,
    scheduledStart: '2026-11-05T08:00:00Z',
    durationMinutes: 180,
    agentIds: [uuid],
  },
  'cleaning.interventions.batch_scheduled': {
    missionId: uuid,
    customerId: uuid,
    interventionIds: [uuid, uuid],
    count: 2,
    firstStart: '2026-11-11T07:00:00Z',
    lastStart: '2026-11-18T07:00:00Z',
    durationMinutes: 120,
    agentIds: [uuid],
    skippedDates: ['2026-11-14'],
    serviceCode: 'house_cleaning',
    serviceName: 'Nettoyage de maison',
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
    organizationId: null,
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
  'cleaning.contract.suspension_updated': {
    missionId: uuid,
    customerId: uuid,
    organizationId: uuid,
    change: 'cause_lifted',
    cause: 'organization_suspended',
    causes: ['unpaid_invoices'],
    unpaidCount: 2,
    updatedAt: '2026-12-18T06:00:00Z',
  },
  'cleaning.rescheduling.failed': {
    missionId: uuid,
    customerId: uuid,
    organizationId: uuid,
    interventionIds: [uuid],
    failedCount: 1,
  },
  'cleaning.mission.refunded': {
    missionId: uuid,
    customerId: uuid,
    refunds: [{ paymentRecordId: uuid, walletTransactionId: uuid, amount: xof(15000) }],
    reason: 'mission_cancelled',
    refundedAt: '2026-11-09T10:00:00Z',
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

  it('demande reçue : groupe facultatif (ADR-034), identifiant UUID, sans position ni repère', () => {
    const validate = ajv.compile(schemas.get('cleaning.quote.requested')!);
    const base = cleaningExamples['cleaning.quote.requested'];
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, groupId: uuid })).toBe(true);
    expect(validate({ ...base, groupId: 'groupe-1' })).toBe(false);
    expect(validate({ ...base, latitude: 6.45 })).toBe(false);
    expect(validate({ ...base, landmark: 'Portail bleu' })).toBe(false);
  });

  it.each([
    'cleaning.booking.confirmed',
    'cleaning.quote.sent',
    'cleaning.visit.scheduled',
    'cleaning.request.cancelled',
    'cleaning.mission.scheduled',
  ] as const)('%s : prestation, son nom et groupe facultatifs (ADR-034)', (type) => {
    const validate = ajv.compile(schemas.get(type)!);
    const base = cleaningExamples[type];
    const subject = { serviceCode: 'house_cleaning', serviceName: 'Nettoyage de maison', groupId: uuid };
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, ...subject })).toBe(true);
    expect(validate({ ...base, groupId: 'groupe-1' })).toBe(false);
    expect(validate({ ...base, serviceName: '' })).toBe(false);
    expect(validate({ ...base, landmark: 'Portail vert' })).toBe(false);
  });

  it('cleaning.visit.scheduled : visite commune d’un groupe, demandes listées (ADR-035)', () => {
    const validate = ajv.compile(schemas.get('cleaning.visit.scheduled')!);
    const base = cleaningExamples['cleaning.visit.scheduled'];
    const other = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0e';
    expect(validate({ ...base, groupId: uuid, groupVisitId: uuid, requestIds: [uuid, other] })).toBe(true);
    expect(validate({ ...base, requestIds: [] })).toBe(false);
    expect(validate({ ...base, requestIds: [uuid, uuid] })).toBe(false);
    expect(validate({ ...base, requestIds: ['demande-1'] })).toBe(false);
  });

  it('messages regroupés (ADR-035 point 14) : champs facultatifs, les événements antérieurs restent valides', () => {
    const requested = ajv.compile(schemas.get('cleaning.quote.requested')!);
    const sent = ajv.compile(schemas.get('cleaning.quote.sent')!);
    const visit = ajv.compile(schemas.get('cleaning.visit.scheduled')!);
    const grouped = { groupId: uuid, summarizedByGroup: true };
    expect(
      requested({ ...cleaningExamples['cleaning.quote.requested'], ...grouped, serviceName: 'Vitres' }),
    ).toBe(true);
    expect(requested({ ...cleaningExamples['cleaning.quote.requested'], serviceName: '' })).toBe(false);
    expect(sent({ ...cleaningExamples['cleaning.quote.sent'], ...grouped })).toBe(true);
    expect(sent({ ...cleaningExamples['cleaning.quote.sent'], summarizedByGroup: 'oui' })).toBe(false);
    const requests = [{ requestId: uuid, serviceCode: 'windows', serviceName: 'Vitres' }];
    const base = cleaningExamples['cleaning.visit.scheduled'];
    expect(visit({ ...base, groupVisitId: uuid, requestIds: [uuid], requests })).toBe(true);
    expect(visit({ ...base, requests: [] })).toBe(false);
    expect(visit({ ...base, requests: [{ requestId: uuid }] })).toBe(false);
  });

  it('événements de groupe : 1 à 10 demandes, montants entiers en XOF, sans adresse', () => {
    const requested = ajv.compile(schemas.get('cleaning.quote_group.requested')!);
    const sent = ajv.compile(schemas.get('cleaning.quote_group.sent')!);
    const group = cleaningExamples['cleaning.quote_group.requested'];
    const quotes = cleaningExamples['cleaning.quote_group.sent'];
    const { serviceName: _serviceName, ...withoutName } = group.requests[0]!;
    expect(requested({ ...group, requests: [withoutName] })).toBe(true);
    expect(requested({ ...group, requests: [] })).toBe(false);
    expect(requested({ ...group, requests: Array.from({ length: 11 }, () => withoutName) })).toBe(false);
    expect(requested({ ...group, requests: [{ ...withoutName, landmark: 'Portail' }] })).toBe(false);
    expect(sent({ ...quotes, total: xof(450.5) })).toBe(false);
    expect(sent({ ...quotes, quotes: [{ ...quotes.quotes[0]!, total: xof(-1) }] })).toBe(false);
    expect(sent({ ...quotes, quotes: [] })).toBe(false);
  });

  it('annulation : organisation ajoutée (ADR-032), les événements antérieurs sans elle restent valides', () => {
    const validate = ajv.compile(schemas.get('cleaning.request.cancelled')!);
    const { organizationId: _organizationId, ...before } = cleaningExamples['cleaning.request.cancelled'];
    expect(validate(before)).toBe(true);
    expect(
      validate({ ...cleaningExamples['cleaning.request.cancelled'], missionId: uuid, organizationId: uuid }),
    ).toBe(true);
    expect(validate({ ...cleaningExamples['cleaning.request.cancelled'], organizationId: 'acme' })).toBe(
      false,
    );
  });

  it('suspension et reprise portent aussi la cause « organisation suspendue » (ADR-030)', () => {
    const suspended = ajv.compile(schemas.get('cleaning.contract.suspended')!);
    const resumed = ajv.compile(schemas.get('cleaning.contract.resumed')!);
    const cause = 'organization_suspended';
    expect(suspended({ ...cleaningExamples['cleaning.contract.suspended'], cause, unpaidCount: 0 })).toBe(
      true,
    );
    expect(resumed({ ...cleaningExamples['cleaning.contract.resumed'], cause })).toBe(true);
    expect(suspended({ ...cleaningExamples['cleaning.contract.suspended'], cause: 'fraud' })).toBe(false);
  });

  it('changement de cause : la mission reste suspendue, au moins une cause active (ADR-030)', () => {
    const validate = ajv.compile(schemas.get('cleaning.contract.suspension_updated')!);
    const base = cleaningExamples['cleaning.contract.suspension_updated'];
    expect(
      validate({
        ...base,
        change: 'cause_added',
        cause: 'unpaid_invoices',
        causes: ['organization_suspended', 'unpaid_invoices'],
      }),
    ).toBe(true);
    expect(validate({ ...base, causes: [] })).toBe(false);
    expect(validate({ ...base, change: 'resumed' })).toBe(false);
    expect(validate({ ...base, causes: ['unpaid_invoices', 'unpaid_invoices'] })).toBe(false);
  });

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
