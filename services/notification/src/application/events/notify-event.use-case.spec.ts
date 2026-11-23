import { type KspEventPayloads } from '@ksp/contracts';
import { MessageDispatcher } from '../send/message-dispatcher';
import {
  FakeDirectory,
  FakeOrganizations,
  FakeProvider,
  FakeStaff,
  FixedClock,
  InMemoryInbox,
  InMemoryNotifications,
  InMemoryPreferences,
  SequentialIds,
} from '../testing/fakes';
import { type OrganizationBillingContact, type RecipientContact } from './event-notification.ports';
import { EVENT_RULES } from './listened-events';
import { NotifyEventUseCase, type ReceivedEvent } from './notify-event.use-case';

const NOW = new Date('2026-10-23T10:00:00Z');
const EVENT_ID = '0192f1c4-aaaa-7000-8000-000000000001';
const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
const AGENT_1 = '0192f1c4-0000-7000-8000-00000000a001';
const AGENT_2 = '0192f1c4-0000-7000-8000-00000000a002';
const REQUEST = '0192f1c4-0000-7000-8000-00000000r001';
const MISSION = '0192f1c4-0000-7000-8000-00000000m001';
const NBSP = '\u00a0';

const contact = (userId: string, overrides: Partial<RecipientContact> = {}): RecipientContact => ({
  userId,
  firstName: 'Koffi',
  phoneE164: '+2290197000045',
  email: null,
  language: 'fr',
  ...overrides,
});

function setup(
  contacts: RecipientContact[] = [contact(CUSTOMER)],
  providers = [new FakeProvider('whatsapp'), new FakeProvider('email')],
  cleaningTeamUserIds: string[] = [],
  accountsTeamUserIds: string[] = [],
  billingContacts: OrganizationBillingContact[] = [],
  recoverySupervisorUserIds: string[] = [],
  recoveryLegalUserIds: string[] = [],
) {
  const notifications = new InMemoryNotifications();
  const directory = new FakeDirectory(contacts);
  const organizations = new FakeOrganizations(billingContacts);
  const inbox = new InMemoryInbox();
  const preferences = new InMemoryPreferences();
  const clock = new FixedClock(NOW);
  const useCase = new NotifyEventUseCase(
    EVENT_RULES,
    new MessageDispatcher(notifications, providers, clock),
    directory,
    organizations,
    new FakeStaff(),
    preferences,
    inbox,
    clock,
    new SequentialIds(),
    {
      portalBaseUrl: 'https://ksp.bj',
      timeZone: 'Africa/Porto-Novo',
      cleaningTeamUserIds,
      accountsTeamUserIds,
      recoverySupervisorUserIds,
      recoveryLegalUserIds,
    },
  );
  const [whatsapp, email] = providers as [FakeProvider, FakeProvider];
  return { notifications, directory, organizations, inbox, preferences, useCase, whatsapp, email };
}

const event = <T extends keyof KspEventPayloads>(type: T, payload: KspEventPayloads[T]): ReceivedEvent => ({
  eventId: EVENT_ID,
  type,
  payload,
});

const REQUEST_NUMBER = 'DN-000124';
const VISIT = '0192f1c4-0000-7000-8000-00000000v001';

/** Événements du Nettoyage v2 : demande, nom du lieu et des types, jamais d'adresse. */
const requestCancelled = event('cleaning.request.cancelled', {
  requestId: REQUEST,
  requestNumber: REQUEST_NUMBER,
  customerId: CUSTOMER,
  organizationId: null,
  cause: 'customer',
  visitFeeRefund: null,
  cancelledAt: '2026-10-23T09:00:00Z',
});

const quoteSent = event('cleaning.quote.sent', {
  quoteId: '0192f1c4-0000-7000-8000-00000000q001',
  requestId: REQUEST,
  requestNumber: REQUEST_NUMBER,
  customerId: CUSTOMER,
  organizationId: null,
  kind: 'initial',
  version: 1,
  sessionPrice: { amount: 150000, currency: 'XOF' },
  sessionsCount: 1,
  total: { amount: 150000, currency: 'XOF' },
  visitFeeDeduction: { amount: 0, currency: 'XOF' },
  validUntil: '2026-11-15T22:59:59Z',
  sentAt: '2026-10-23T09:00:00Z',
  placeTypeName: 'Maison',
  cleaningTypeNames: ['Sol'],
});

const visitScheduled = event('cleaning.visit.scheduled', {
  visitId: VISIT,
  requestId: REQUEST,
  requestNumber: REQUEST_NUMBER,
  customerId: CUSTOMER,
  organizationId: null,
  agentIds: [AGENT_1, AGENT_2],
  scheduledAt: '2026-10-29T08:30:00Z',
  durationMinutes: 60,
  previousScheduledAt: null,
  releasedAgentIds: [],
  placeTypeName: 'Maison',
  cleaningTypeNames: ['Sol'],
});

describe('NotifyEventUseCase — messages des événements du Nettoyage gardés par la refonte v2 (ADR-054)', () => {
  it('cleaning.request.cancelled par le client : confirmation au client, lien vers la demande', async () => {
    const { useCase, whatsapp, inbox } = setup();
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({
      status: 'processed',
      accepted: 1,
    });
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({
      templateCode: 'cleaning.request_cancelled.customer',
      phoneE164: '+2290197000045',
      locale: 'fr',
      variables: {
        first_name: 'Koffi',
        case: 'cancelled_by_customer',
        scope: 'request',
        link: `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`,
      },
    });
    expect(whatsapp.sent[0]!.content!.text).toContain('Bonjour Koffi,');
    expect(whatsapp.sent[0]!.content!.text).toContain(
      'Votre annulation est bien enregistrée : votre demande de nettoyage est annulée.',
    );
    expect(inbox.inApp).toEqual([
      expect.objectContaining({
        userId: CUSTOMER,
        templateCode: 'cleaning.request_cancelled.customer',
        title: 'Annulation enregistrée',
        link: `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`,
        sourceEventId: EVENT_ID,
      }),
    ]);
  });

  it('cleaning.request.cancelled faute de frais de visite payés : message d’une annulation par KSP', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('cleaning.request.cancelled', {
        ...(requestCancelled.payload as KspEventPayloads['cleaning.request.cancelled']),
        cause: 'visit_fee_unpaid',
      }),
    );
    expect(whatsapp.sent[0]!.variables['case']).toBe('cancelled_by_supervisor');
    expect(whatsapp.sent[0]!.content!.text).toContain('KSP a dû annuler votre demande de nettoyage.');
  });

  it('cleaning.visit.scheduled : le client et chaque agent de la visite, date à l’heure du Bénin', async () => {
    const { useCase, whatsapp, inbox } = setup([
      contact(CUSTOMER),
      contact(AGENT_1, { firstName: 'Awa' }),
      contact(AGENT_2),
    ]);
    await expect(
      useCase.execute(
        event('cleaning.visit.scheduled', {
          ...(visitScheduled.payload as KspEventPayloads['cleaning.visit.scheduled']),
          agentIds: [AGENT_1, AGENT_2, AGENT_1],
        }),
      ),
    ).resolves.toMatchObject({ accepted: 3, inApp: 3 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.visit_scheduled.customer',
      'cleaning.visit_scheduled.agent',
      'cleaning.visit_scheduled.agent',
    ]);
    expect(whatsapp.sent[0]!.variables['date']).toBe('jeudi 29 octobre 2026 à 09:30');
    expect(whatsapp.sent[1]!.content!.text).toContain('Bonjour Awa,');
    expect(inbox.inApp.map((notification) => notification.link)).toEqual([
      `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`,
      null,
      null,
    ]);
  });

  it.each([
    ['request_cancelled', 'cleaning.visit_cancelled.agent', 0],
    ['request_rejected', 'cleaning.visit_cancelled.agent', 0],
    ['slot_changed', 'cleaning.visit_released.agent', 1],
    ['ksp', 'cleaning.visit_released.agent', 1],
    ['agent_no_show', 'cleaning.visit_released.agent', 1],
  ] as const)(
    'cleaning.visit.cancelled (%s) : les agents libérés ; le client, sauf quand sa demande est close',
    async (cause, agentTemplate, customerMessages) => {
      const { useCase, whatsapp } = setup([contact(CUSTOMER), contact(AGENT_1), contact(AGENT_2)]);
      await useCase.execute(
        event('cleaning.visit.cancelled', {
          visitId: VISIT,
          requestId: REQUEST,
          requestNumber: REQUEST_NUMBER,
          customerId: CUSTOMER,
          organizationId: null,
          communeKey: 'cotonou',
          releasedAgentIds: [AGENT_1, AGENT_2, AGENT_2],
          scheduledAt: '2026-11-12T08:00:00Z',
          cause,
          visitFeeRefund: null,
          cancelledAt: '2026-11-10T08:00:00Z',
        }),
      );
      const toAgents = whatsapp.sent.filter((message) => message.templateCode.endsWith('.agent'));
      expect(toAgents.map((message) => message.templateCode)).toEqual([agentTemplate, agentTemplate]);
      for (const message of toAgents) {
        expect(message.content!.text).toContain('jeudi 12 novembre 2026 à 09:00');
        expect(message.content!.text).toContain(REQUEST_NUMBER);
      }
      expect(
        whatsapp.sent.filter((message) => message.templateCode === 'cleaning.visit_cancelled.customer'),
      ).toHaveLength(customerMessages);
    },
  );

  it('cleaning.quote.sent : document, par e-mail quand l’adresse existe', async () => {
    const { useCase, whatsapp, email } = setup([contact(CUSTOMER, { email: 'Koffi@Example.com' })]);
    await useCase.execute(quoteSent);
    expect(whatsapp.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ email: 'koffi@example.com', phoneE164: '+2290197000045' });
    expect(email.sent[0]!.content).toEqual({
      subject: 'Votre devis de nettoyage',
      text: expect.stringContaining(`150${NBSP}000${NBSP}FCFA, valable jusqu'au 15 novembre 2026`),
    });
  });

  it('cleaning.quote.sent sans adresse e-mail : par WhatsApp', async () => {
    const { useCase, whatsapp, email } = setup();
    await useCase.execute(quoteSent);
    expect(email.sent).toHaveLength(0);
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual(['cleaning.quote_sent.customer']);
  });

  it('cleaning.quote.expiry_reminded : le devis du dossier, son montant et sa validité', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('cleaning.quote.expiry_reminded', {
        quoteId: '0192f1c4-0000-7000-8000-00000000q001',
        requestId: REQUEST,
        requestNumber: REQUEST_NUMBER,
        customerId: CUSTOMER,
        organizationId: null,
        total: { amount: 25000, currency: 'XOF' },
        validUntil: '2026-11-12T08:00:00Z',
        reminderDays: 2,
        remindedAt: '2026-11-10T08:00:00Z',
      }),
    );
    expect(whatsapp.sent[0]).toMatchObject({
      templateCode: 'cleaning.quote_expiry_reminder.customer',
      variables: { link: `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}` },
    });
    expect(whatsapp.sent[0]!.content!.subject).toBe('Votre devis expire bientôt');
    expect(whatsapp.sent[0]!.content!.text).toContain(
      `Votre devis du dossier ${REQUEST_NUMBER} (25${NBSP}000${NBSP}FCFA) reste valable jusqu'au 12 novembre 2026.`,
    );
  });

  it('cleaning.quote.expired : le devis du dossier et son montant', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('cleaning.quote.expired', {
        quoteId: '0192f1c4-0000-7000-8000-00000000q001',
        requestId: REQUEST,
        customerId: CUSTOMER,
        organizationId: null,
        validUntil: '2026-11-12T08:00:00Z',
        expiredAt: '2026-11-12T08:05:00Z',
        requestNumber: REQUEST_NUMBER,
        communeKey: 'cotonou',
        total: { amount: 25000, currency: 'XOF' },
        placeTypeName: 'Maison',
        cleaningTypeNames: ['Sol'],
      }),
    );
    expect(whatsapp.sent[0]!.content!.subject).toBe('Votre devis a expiré');
    expect(whatsapp.sent[0]!.content!.text).toContain(
      `Votre devis du dossier ${REQUEST_NUMBER} (25${NBSP}000${NBSP}FCFA) a expiré sans réponse.`,
    );
  });

  it('événement inconnu : pas écouté', async () => {
    const { useCase, directory } = setup();
    await expect(
      useCase.execute({ eventId: EVENT_ID, type: 'cleaning.unknown.event', payload: {} }),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(directory.lookups).toHaveLength(0);
  });
});

describe('NotifyEventUseCase — fiabilité', () => {
  it('un événement déjà traité n’envoie rien et ne relit pas identity', async () => {
    const { useCase, whatsapp, directory } = setup();
    await useCase.execute(requestCancelled);
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({ status: 'duplicate' });
    expect(whatsapp.sent).toHaveLength(1);
    expect(directory.lookups).toHaveLength(1);
  });

  it('reprise après une interruption avant la fin : les messages déjà partis ne repartent pas', async () => {
    const { useCase, whatsapp, inbox, notifications } = setup();
    await useCase.execute(requestCancelled);
    // Simule une coupure entre l'envoi et le marquage de l'événement : il est livré à nouveau.
    inbox.processed.clear();
    inbox.inApp.length = 0;
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({
      status: 'processed',
      accepted: 0,
      replayed: 1,
      inApp: 1,
    });
    expect(whatsapp.sent).toHaveLength(1);
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0]!.idempotencyKey).toBe(
      `${EVENT_ID}:cleaning.request_cancelled.customer:${CUSTOMER}`,
    );
  });

  it('destinataire introuvable : les autres sont prévenus, l’événement est traité', async () => {
    const { useCase, whatsapp, inbox } = setup([contact(CUSTOMER), contact(AGENT_2)]);
    await expect(useCase.execute(visitScheduled)).resolves.toMatchObject({
      status: 'processed',
      accepted: 2,
      recipientsNotFound: 1,
    });
    expect(whatsapp.sent).toHaveLength(2);
    expect(inbox.processed.has(EVENT_ID)).toBe(true);
  });

  it('identity indisponible : erreur (reprise par la file), rien n’est envoyé ni marqué', async () => {
    const { useCase, whatsapp, directory, inbox } = setup();
    directory.unavailable = true;
    await expect(useCase.execute(requestCancelled)).rejects.toThrow('identity indisponible');
    expect(whatsapp.sent).toHaveLength(0);
    expect(inbox.processed.size).toBe(0);
  });

  it('WhatsApp en échec : bascule sur l’e-mail quand l’adresse existe', async () => {
    const providers = [
      new FakeProvider('whatsapp', [{ accepted: false, reason: 'recipient_invalid' }]),
      new FakeProvider('email'),
    ];
    const { useCase, email, notifications } = setup(
      [contact(CUSTOMER, { email: 'k@example.com' })],
      providers,
    );
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({ accepted: 1 });
    expect(email.sent).toHaveLength(1);
    expect(notifications.rows[0]).toMatchObject({
      status: 'accepted',
      channelUsed: 'email',
      channelsTried: ['whatsapp', 'email'],
      targetMasked: '+229********45 · k***@example.com',
    });
  });

  it('tous les canaux en échec : notification.message.failed, l’événement est tout de même traité', async () => {
    const providers = [
      new FakeProvider('whatsapp', [{ accepted: false, reason: 'provider_unavailable' }]),
      new FakeProvider('email'),
    ];
    const { useCase, notifications, inbox } = setup(undefined, providers);
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({ failed: 1, inApp: 1 });
    expect(notifications.events).toEqual([
      expect.objectContaining({
        templateCode: 'cleaning.request_cancelled.customer',
        channelsTried: ['whatsapp'],
        reason: 'provider_unavailable',
        recipientUserId: CUSTOMER,
      }),
    ]);
    expect(inbox.processed.has(EVENT_ID)).toBe(true);
  });

  it('destinataire sans téléphone ni e-mail : notification dans l’espace seulement', async () => {
    const { useCase, whatsapp, inbox } = setup([contact(CUSTOMER, { phoneE164: null, firstName: null })]);
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({ unreachable: 1, inApp: 1 });
    expect(whatsapp.sent).toHaveLength(0);
    expect(inbox.inApp[0]!.body.startsWith('Bonjour,\n')).toBe(true);
  });

  it('date illisible dans l’événement : erreur (file d’erreurs après les reprises)', async () => {
    const { useCase, inbox } = setup();
    await expect(
      useCase.execute({
        ...visitScheduled,
        payload: { ...(visitScheduled.payload as object), scheduledAt: 'demain' },
      }),
    ).rejects.toThrow('date illisible');
    expect(inbox.processed.size).toBe(0);
  });

  it('événement sans règle : ignoré', async () => {
    const { useCase, directory } = setup();
    await expect(
      useCase.execute({ eventId: EVENT_ID, type: 'identity.user.registered', payload: {} }),
    ).resolves.toMatchObject({ status: 'ignored' });
    expect(directory.lookups).toHaveLength(0);
  });
});

describe('NotifyEventUseCase — messages importants', () => {
  const withEmail = contact(CUSTOMER, { email: 'koffi@example.com' });
  const mfaReset = event('identity.user.mfa_reset', {
    userId: CUSTOMER,
    enrollBefore: '2026-10-23T11:00:00.000Z',
  });

  it('par WhatsApp ET par e-mail, une clé par canal', async () => {
    const { useCase, whatsapp, email, notifications } = setup([withEmail]);
    await expect(useCase.execute(mfaReset)).resolves.toMatchObject({ accepted: 2, inApp: 1 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual(['identity.mfa_reset.staff']);
    expect(email.sent.map((message) => message.templateCode)).toEqual(['identity.mfa_reset.staff']);
    expect(notifications.rows.map((row) => [row.idempotencyKey, row.targetMasked])).toEqual([
      [`${EVENT_ID}:identity.mfa_reset.staff:${CUSTOMER}:whatsapp`, '+229********45'],
      [`${EVENT_ID}:identity.mfa_reset.staff:${CUSTOMER}:email`, 'k***@example.com'],
    ]);
  });

  it('sans adresse e-mail : WhatsApp seul', async () => {
    const { useCase, whatsapp, email } = setup();
    await expect(useCase.execute(mfaReset)).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
  });

  it('rejoué : aucun des deux canaux ne repart', async () => {
    const { useCase, whatsapp, email, inbox } = setup([withEmail]);
    await useCase.execute(mfaReset);
    inbox.processed.clear();
    await expect(useCase.execute(mfaReset)).resolves.toMatchObject({ accepted: 0, replayed: 2 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });
});

describe('NotifyEventUseCase — factures mensuelles (billing)', () => {
  const INVOICE = '0192f1c4-0000-7000-8000-0000000f1001';
  const ORG = '0192f1c4-0000-7000-8000-0000000b0001';
  const LINK = `https://ksp.bj/mon-espace/factures/${INVOICE}`;
  const withEmail = contact(CUSTOMER, { email: 'Koffi@Example.com' });
  const ref = {
    invoiceId: INVOICE,
    invoiceNumber: 'FAC-2026-000042',
    customerId: CUSTOMER,
    organizationId: null,
    source: 'cleaning' as const,
    contractId: MISSION,
    total: { amount: 150000, currency: 'XOF' as const },
  };

  // Novembre 2026 à l'heure du Bénin : fin exclue (1er décembre à minuit), facture émise ce jour-là.
  const issued = event('billing.invoice.issued', {
    ...ref,
    periodStart: '2026-10-31T23:00:00.000Z',
    periodEnd: '2026-11-30T23:00:00.000Z',
    issuedAt: '2026-11-30T23:00:00.000Z',
    dueAt: '2026-12-10T23:00:00.000Z',
  });

  const overdue = event('billing.invoice.overdue', {
    ...ref,
    dueAt: '2026-12-10T23:00:00.000Z',
    overdueCount: 1,
  });

  const paid = event('billing.invoice.paid', { ...ref, paidAt: '2026-12-16T10:00:00.000Z', overdueCount: 1 });

  it('facture émise : par e-mail à l’adresse vérifiée, dernier jour facturé, montant entier', async () => {
    const { useCase, whatsapp, email, inbox, notifications } = setup([withEmail]);
    await expect(useCase.execute(issued)).resolves.toMatchObject({ accepted: 1, inApp: 1 });
    expect(whatsapp.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      templateCode: 'billing.invoice_issued.customer',
      email: 'koffi@example.com',
      variables: {
        invoice_number: 'FAC-2026-000042',
        period: 'du 1 novembre 2026 au 30 novembre 2026',
        total: `150${NBSP}000${NBSP}FCFA`,
        due_on: '11 décembre 2026',
        link: LINK,
      },
    });
    expect(email.sent[0]!.content!.subject).toBe('Votre facture FAC-2026-000042');
    expect(inbox.inApp).toEqual([
      expect.objectContaining({
        userId: CUSTOMER,
        templateCode: 'billing.invoice_issued.customer',
        link: LINK,
      }),
    ]);
    expect(notifications.rows[0]!.idempotencyKey).toBe(
      `${EVENT_ID}:billing.invoice_issued.customer:${CUSTOMER}`,
    );
  });

  it('facture émise sans adresse vérifiée : WhatsApp, et la facture reste dans l’espace', async () => {
    // L'annuaire ne rend une adresse que si elle est vérifiée (ADR-026) : ici, aucune.
    const { useCase, whatsapp, email, inbox } = setup();
    await expect(useCase.execute(issued)).resolves.toMatchObject({ accepted: 1, inApp: 1 });
    expect(email.sent).toHaveLength(0);
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual(['billing.invoice_issued.customer']);
    expect(inbox.inApp).toHaveLength(1);
  });

  it('e-mail refusé par le prestataire : bascule sur WhatsApp', async () => {
    const providers = [
      new FakeProvider('whatsapp'),
      new FakeProvider('email', [{ accepted: false, reason: 'provider_unavailable' }]),
    ];
    const { useCase, whatsapp, notifications } = setup([withEmail], providers);
    await expect(useCase.execute(issued)).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(notifications.rows[0]).toMatchObject({
      channelUsed: 'whatsapp',
      channelsTried: ['email', 'whatsapp'],
    });
  });

  it('facture impayée : un seul message, la facture et son échéance', async () => {
    const { useCase, whatsapp, email } = setup([withEmail]);
    await expect(useCase.execute(overdue)).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent).toHaveLength(0);
    expect(email.sent[0]!.content!.subject).toBe('Facture FAC-2026-000042 impayée');
    expect(email.sent[0]!.content!.text).toContain('à régler avant le 11 décembre 2026');
    expect(email.sent[0]!.variables['link']).toBe(LINK);
  });

  it('facture réglée : remerciement, impayées restantes du contrat', async () => {
    const { useCase, email } = setup([withEmail]);
    await useCase.execute(paid);
    expect(email.sent[0]!.content!.subject).toBe('Facture FAC-2026-000042 réglée');
    expect(email.sent[0]!.content!.text).toContain(
      `votre facture FAC-2026-000042 de 150${NBSP}000${NBSP}FCFA est réglée en totalité depuis le 16 décembre 2026.`,
    );
    expect(email.sent[0]!.content!.text).toContain('Il reste 1 facture impayée sur ce contrat.');
  });

  it('événement rejoué : la facture ne part qu’une fois', async () => {
    const { useCase, email, inbox } = setup([withEmail]);
    await useCase.execute(issued);
    await expect(useCase.execute(issued)).resolves.toMatchObject({ status: 'duplicate' });
    inbox.processed.clear();
    await expect(useCase.execute(issued)).resolves.toMatchObject({ accepted: 0, replayed: 1 });
    expect(email.sent).toHaveLength(1);
  });

  describe('facture d’une organisation (ADR-027, ADR-050)', () => {
    const ADMIN = '0192f1c4-0000-7000-8000-0000000ad001';
    const ADMIN_2 = '0192f1c4-0000-7000-8000-0000000ad002';
    const ORG_LINK = `${LINK}?organisation=${ORG}`;
    const admin = contact(ADMIN, { firstName: 'Awa', phoneE164: '+2290197000046', email: 'awa@example.com' });
    const admin2 = contact(ADMIN_2, { firstName: 'Sena', phoneE164: '+2290197000047', email: null });
    const toOrg = (received: ReceivedEvent): ReceivedEvent => ({
      ...received,
      payload: { ...(received.payload as object), organizationId: ORG },
    });
    const billing = (billingEmail: string | null, adminUserIds = [ADMIN]) => [
      { organizationId: ORG, legalName: 'SARL Bénin Propre', billingEmail, adminUserIds },
    ];
    const setupOrg = (billingEmail: string | null, adminUserIds = [ADMIN]) =>
      setup([withEmail, admin, admin2], undefined, [], [], billing(billingEmail, adminUserIds));

    it('administrateurs actuels seulement : le compte client, ancien membre, ne reçoit rien', async () => {
      const { useCase, whatsapp, email, inbox, organizations } = setupOrg(null, [ADMIN, ADMIN_2]);
      await expect(useCase.execute(toOrg(issued))).resolves.toMatchObject({ accepted: 2, inApp: 2 });
      expect(organizations.lookups).toEqual([[ORG]]);
      expect(inbox.inApp.map((item) => [item.userId, item.link])).toEqual([
        [ADMIN, ORG_LINK],
        [ADMIN_2, ORG_LINK],
      ]);
      // Sans e-mail de facturation : chacun à son adresse vérifiée, sinon WhatsApp.
      expect(email.sent).toEqual([expect.objectContaining({ email: 'awa@example.com' })]);
      expect(whatsapp.sent).toEqual([expect.objectContaining({ phoneE164: '+2290197000047' })]);
      expect([...email.sent, ...whatsapp.sent].map((message) => message.variables['link'])).toEqual([
        ORG_LINK,
        ORG_LINK,
      ]);
      expect(email.sent[0]!.content!.subject).toBe('Votre facture FAC-2026-000042 — SARL Bénin Propre');
    });

    it('e-mail de facturation vérifié : une seule copie ; les administrateurs par WhatsApp et dans l’espace', async () => {
      const { useCase, whatsapp, email, inbox, notifications } = setupOrg('Compta@Benin-Propre.bj', [
        ADMIN,
        ADMIN_2,
      ]);
      await expect(useCase.execute(toOrg(issued))).resolves.toMatchObject({ accepted: 3, inApp: 2 });
      expect(email.sent).toEqual([
        expect.objectContaining({
          templateCode: 'billing.invoice_issued.customer',
          email: 'compta@benin-propre.bj',
        }),
      ]);
      expect(email.sent[0]!.content!.subject).toBe('Votre facture FAC-2026-000042 — SARL Bénin Propre');
      expect(whatsapp.sent.map((message) => message.phoneE164)).toEqual(['+2290197000046', '+2290197000047']);
      expect(inbox.inApp.map((item) => item.userId)).toEqual([ADMIN, ADMIN_2]);
      expect(notifications.rows.map((row) => row.idempotencyKey)).toContain(
        `${EVENT_ID}:billing.invoice_issued.customer:organization:${ORG}`,
      );
      // Rejouée, la facture ne part pas deux fois à l'adresse de facturation.
      await useCase.execute(toOrg(issued));
      expect(email.sent).toHaveLength(1);
    });

    it('organisation introuvable : personne n’est prévenu à sa place', async () => {
      const { useCase, whatsapp, email, inbox } = setup([withEmail]);
      await expect(useCase.execute(toOrg(paid))).resolves.toMatchObject({ accepted: 0, inApp: 0 });
      expect([...whatsapp.sent, ...email.sent]).toHaveLength(0);
      expect(inbox.inApp).toHaveLength(0);
    });

    it('sans administrateur actuel : seule l’adresse de facturation reçoit la facture', async () => {
      const { useCase, whatsapp, email, inbox } = setupOrg('compta@bp.bj', []);
      await expect(useCase.execute(toOrg(paid))).resolves.toMatchObject({ accepted: 1, inApp: 0 });
      expect(email.sent).toEqual([expect.objectContaining({ email: 'compta@bp.bj' })]);
      expect(whatsapp.sent).toHaveLength(0);
      expect(inbox.inApp).toHaveLength(0);
    });

    it('identity indisponible pour l’organisation : erreur (reprise par la file), rien n’est envoyé', async () => {
      const { useCase, whatsapp, email, inbox, organizations } = setupOrg('compta@bp.bj');
      organizations.unavailable = true;
      await expect(useCase.execute(toOrg(issued))).rejects.toThrow('identity indisponible');
      expect([...whatsapp.sent, ...email.sent]).toHaveLength(0);
      expect(inbox.processed.size).toBe(0);
    });

    it('facture d’un particulier : l’annuaire des organisations n’est pas lu', async () => {
      const { useCase, email, organizations } = setupOrg('compta@bp.bj');
      await useCase.execute(issued);
      expect(organizations.lookups).toEqual([]);
      expect(email.sent).toEqual([expect.objectContaining({ email: 'koffi@example.com' })]);
      expect(email.sent[0]!.content!.subject).toBe('Votre facture FAC-2026-000042');
    });
  });

  it('période illisible : erreur (file d’erreurs après les reprises)', async () => {
    const { useCase, inbox } = setup();
    await expect(
      useCase.execute({
        ...issued,
        payload: { ...(issued.payload as object), periodEnd: '2026-10-31T23:00:00.000Z' },
      }),
    ).rejects.toThrow('période illisible');
    expect(inbox.processed.size).toBe(0);
  });
});

describe('NotifyEventUseCase — comptes entreprise (ADR-027)', () => {
  const ORGANIZATION = '0192f1c4-0000-7000-8000-0000000000a1';
  const STAFF = '0192f1c4-0000-7000-8000-00000000ad01';
  const TEAM = '0192f1c4-0000-7000-8000-0000000e0101';

  it('nouvelle demande : chaque membre de l’équipe de validation configurée', async () => {
    const { useCase, whatsapp } = setup([contact(CUSTOMER), contact(TEAM)], undefined, [], [TEAM]);
    const created = event('identity.organization.created', {
      organizationId: ORGANIZATION,
      createdBy: CUSTOMER,
      legalName: 'SARL Bénin Propre',
    });
    await expect(useCase.execute(created)).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'identity.organization_requested.team',
    ]);
    expect(whatsapp.sent[0]!.content!.text).toContain(
      'Une nouvelle demande de compte entreprise attend votre validation : SARL Bénin Propre.',
    );
  });

  it('nouvelle demande sans équipe configurée : rien à envoyer, événement traité', async () => {
    const { useCase, whatsapp, inbox } = setup();
    const created = event('identity.organization.created', {
      organizationId: ORGANIZATION,
      createdBy: CUSTOMER,
      legalName: 'SARL Bénin Propre',
    });
    await useCase.execute(created);
    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed.size).toBe(1);
  });

  it('validation : le demandeur, avec le lien vers son espace entreprise', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('identity.organization.validated', {
        organizationId: ORGANIZATION,
        legalName: 'SARL Bénin Propre',
        createdBy: CUSTOMER,
        validatedBy: STAFF,
      }),
    );
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({ templateCode: 'identity.organization_validated.customer' });
    expect(whatsapp.sent[0]!.content!.text).toContain(
      'le compte entreprise SARL Bénin Propre est validé par KSP',
    );
    expect(whatsapp.sent[0]!.content!.text).toContain('https://ksp.bj/mon-espace/entreprise');
  });

  it('refus : le demandeur, avec le motif', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('identity.organization.rejected', {
        organizationId: ORGANIZATION,
        legalName: 'SARL Bénin Propre',
        createdBy: CUSTOMER,
        rejectedBy: STAFF,
        reason: 'IFU introuvable au registre de la DGI.',
      }),
    );
    expect(whatsapp.sent[0]).toMatchObject({ templateCode: 'identity.organization_rejected.customer' });
    expect(whatsapp.sent[0]!.content!.text).toContain('Motif : IFU introuvable au registre de la DGI.');
  });

  it('suspension : le demandeur, avec le motif et le lien vers son espace entreprise', async () => {
    const { useCase, whatsapp, inbox } = setup();
    await useCase.execute(
      event('identity.organization.suspended', {
        organizationId: ORGANIZATION,
        legalName: 'SARL Bénin Propre',
        suspendedBy: STAFF,
        createdBy: CUSTOMER,
        reason: 'Usurpation signalée.',
      }),
    );
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({
      templateCode: 'identity.organization_suspended.customer',
      variables: { legal_name: 'SARL Bénin Propre', reason: 'Usurpation signalée.' },
    });
    expect(whatsapp.sent[0]!.content!.text).toContain(
      'KSP a suspendu le compte entreprise SARL Bénin Propre.',
    );
    expect(whatsapp.sent[0]!.content!.text).toContain('Motif : Usurpation signalée.');
    expect(inbox.inApp).toEqual([
      expect.objectContaining({ userId: CUSTOMER, link: 'https://ksp.bj/mon-espace/entreprise' }),
    ]);
  });

  it('réactivation : le demandeur, avec le lien vers son espace entreprise', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('identity.organization.reactivated', {
        organizationId: ORGANIZATION,
        legalName: 'SARL Bénin Propre',
        reactivatedBy: STAFF,
        createdBy: CUSTOMER,
      }),
    );
    expect(whatsapp.sent[0]).toMatchObject({ templateCode: 'identity.organization_reactivated.customer' });
    expect(whatsapp.sent[0]!.content!.text).toContain(
      'Le compte entreprise SARL Bénin Propre est de nouveau actif.',
    );
  });

  it('suspension publiée avant l’ajout du demandeur : rien à envoyer, événement traité', async () => {
    const { useCase, whatsapp, inbox, directory } = setup();
    await useCase.execute(
      event('identity.organization.suspended', {
        organizationId: ORGANIZATION,
        legalName: 'SARL Bénin Propre',
        suspendedBy: STAFF,
        reason: 'Usurpation signalée.',
      }),
    );
    expect(whatsapp.sent).toEqual([]);
    expect(directory.lookups).toEqual([]);
    expect(inbox.processed.size).toBe(1);
  });
});

describe('NotifyEventUseCase — suppression du compte (ADR-036)', () => {
  it('demande : le titulaire, avec la date prévue et le moyen d’annuler', async () => {
    const { useCase, whatsapp } = setup();
    await expect(
      useCase.execute(
        event('identity.user.deletion_requested', {
          userId: CUSTOMER,
          requestedAt: '2026-11-05T10:00:00.000Z',
          scheduledFor: '2026-12-05T10:00:00.000Z',
        }),
      ),
    ).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({ templateCode: 'identity.account_deletion_requested.customer' });
    expect(whatsapp.sent[0]!.content!.text).toContain('votre compte KSP sera supprimé le 5 décembre 2026');
    expect(whatsapp.sent[0]!.content!.text).toContain('https://ksp.bj/mon-espace/compte');
  });

  it('annulation : le titulaire est prévenu', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(event('identity.user.deletion_cancelled', { userId: CUSTOMER }));
    expect(whatsapp.sent[0]).toMatchObject({ templateCode: 'identity.account_deletion_cancelled.customer' });
    expect(whatsapp.sent[0]!.content!.text).toContain('il est de nouveau actif');
  });

  it('double authentification réinitialisée : le titulaire est prévenu par WhatsApp et par e-mail (ADR-050)', async () => {
    const { useCase, whatsapp, email, inbox } = setup([contact(CUSTOMER, { email: 'koffi@example.com' })]);
    await expect(
      useCase.execute(
        event('identity.user.mfa_reset', { userId: CUSTOMER, enrollBefore: '2026-10-23T11:00:00.000Z' }),
      ),
    ).resolves.toMatchObject({ accepted: 2, inApp: 1 });
    expect(whatsapp.sent[0]).toMatchObject({
      templateCode: 'identity.mfa_reset.staff',
      variables: { enroll_before: expect.stringContaining('23 octobre 2026') },
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.content!.text).toContain("Si vous n'êtes pas à l'origine de cette demande");
    expect(inbox.inApp).toEqual([expect.objectContaining({ userId: CUSTOMER, link: null })]);
  });
});

describe('NotifyEventUseCase — paiement en ligne (ADR-031)', () => {
  const PAYMENT = '0192f1c4-0000-7000-8000-0000000p5001';
  const ref = {
    paymentId: PAYMENT,
    subjectType: 'cleaning_mission' as const,
    subjectId: MISSION,
    part: 'deposit' as const,
    subjectReference: null,
    customerId: CUSTOMER,
    organizationId: null,
    amount: { amount: 15000, currency: 'XOF' as const },
    provider: 'fedapay' as const,
    method: 'mobile_money_online' as const,
    providerReference: 'trx_Ab12',
    succeededAt: '2026-11-02T09:15:00.000Z',
  };

  it('acompte payé : reçu au payeur, lien vers la mission', async () => {
    const { useCase, whatsapp, inbox } = setup();
    await expect(useCase.execute(event('payment.intent.succeeded', ref))).resolves.toMatchObject({
      accepted: 1,
      inApp: 1,
    });
    expect(whatsapp.sent[0]).toMatchObject({
      templateCode: 'payment.receipt.customer',
      variables: {
        amount: `15${NBSP}000${NBSP}FCFA`,
        object: "l'acompte de votre prestation de nettoyage",
        paid_on: '2 novembre 2026',
        reference: 'trx_Ab12',
        link: `https://ksp.bj/mon-espace/nettoyage/missions/${MISSION}`,
      },
    });
    expect(inbox.inApp[0]).toMatchObject({ userId: CUSTOMER, templateCode: 'payment.receipt.customer' });
  });

  it('facture d’organisation : numéro de facture, e-mail de facturation de l’organisation', async () => {
    const ORG = '0192f1c4-0000-7000-8000-0000000b0001';
    const INVOICE = '0192f1c4-0000-7000-8000-0000000f1001';
    const { useCase, email, whatsapp } = setup(
      [contact(CUSTOMER)],
      undefined,
      [],
      [],
      [
        {
          organizationId: ORG,
          legalName: 'SARL Bénin Propre',
          billingEmail: 'compta@beninpropre.bj',
          adminUserIds: [],
        },
      ],
    );
    await useCase.execute(
      event('payment.intent.succeeded', {
        ...ref,
        subjectType: 'billing_invoice',
        subjectId: INVOICE,
        part: null,
        subjectReference: 'FAC-2026-000042',
        organizationId: ORG,
        amount: { amount: 150000, currency: 'XOF' },
      }),
    );
    expect(whatsapp.sent).toHaveLength(0);
    expect(email.sent[0]).toMatchObject({
      email: 'compta@beninpropre.bj',
      variables: {
        object: 'la facture FAC-2026-000042',
        link: `https://ksp.bj/mon-espace/factures/${INVOICE}`,
      },
    });
    expect(email.sent[0]!.content!.subject).toBe(
      `Reçu de paiement — 150${NBSP}000${NBSP}FCFA — SARL Bénin Propre`,
    );
  });
});

describe('NotifyEventUseCase — préférences de canaux (ADR-039)', () => {
  const withEmail = contact(CUSTOMER, { email: 'koffi@example.com' });
  const at = new Date('2026-10-20T10:00:00Z');

  it('WhatsApp écarté : le message court part par e-mail, l’espace garde la notification', async () => {
    const { useCase, whatsapp, email, inbox, preferences } = setup([withEmail]);
    await preferences.save(CUSTOMER, { whatsapp: false, email: true }, at);
    await expect(useCase.execute(requestCancelled)).resolves.toMatchObject({ accepted: 1, inApp: 1 });
    expect(whatsapp.sent).toHaveLength(0);
    expect(email.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.request_cancelled.customer',
    ]);
    expect(inbox.inApp).toHaveLength(1);
  });

  it('tous les canaux écartés : aucun envoi externe, compté à part des destinataires injoignables', async () => {
    const { useCase, whatsapp, email, inbox, preferences } = setup([withEmail]);
    await preferences.save(CUSTOMER, { whatsapp: false, email: false }, at);
    await expect(useCase.execute(quoteSent)).resolves.toMatchObject({
      accepted: 0,
      optedOut: 1,
      unreachable: 0,
      inApp: 1,
    });
    expect([...whatsapp.sent, ...email.sent]).toHaveLength(0);
    expect(inbox.inApp[0]!.templateCode).toBe('cleaning.quote_sent.customer');
  });

  it('message important (sécurité) : WhatsApp et e-mail malgré les préférences', async () => {
    const { useCase, whatsapp, email, preferences } = setup([withEmail]);
    await preferences.save(CUSTOMER, { whatsapp: false, email: false }, at);
    await expect(
      useCase.execute(
        event('identity.user.mfa_reset', { userId: CUSTOMER, enrollBefore: '2026-10-23T11:00:00.000Z' }),
      ),
    ).resolves.toMatchObject({ accepted: 2, optedOut: 0 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('messages des agents : envoyés quelles que soient leurs préférences', async () => {
    const { useCase, whatsapp, preferences } = setup([
      contact(CUSTOMER),
      contact(AGENT_1, { firstName: 'Awa' }),
      contact(AGENT_2, { phoneE164: '+2290197000046' }),
    ]);
    await preferences.save(CUSTOMER, { whatsapp: false, email: false }, at);
    await preferences.save(AGENT_1, { whatsapp: false, email: false }, at);
    await expect(useCase.execute(visitScheduled)).resolves.toMatchObject({ accepted: 2, optedOut: 1 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.visit_scheduled.agent',
      'cleaning.visit_scheduled.agent',
    ]);
  });
});

describe('NotifyEventUseCase — recouvrement (ADR-060, partie 17.2)', () => {
  const ORG = '0192f1c4-0000-7000-8000-0000000b0001';
  const ADMIN = '0192f1c4-0000-7000-8000-0000000ad001';
  const SUPERVISOR = '0192f1c4-0000-7000-8000-0000000005a1';
  const CASE = '0192f1c4-0000-7000-8000-00000000d001';
  const DECISION = '0192f1c4-0000-7000-8000-00000000d0d1';
  const CASE_LINK = `https://ksp.bj/mon-espace/recouvrement/dossiers/${CASE}`;
  const withEmail = contact(CUSTOMER, { email: 'koffi@example.com' });
  const ref = (creditor: { type: 'user' | 'organization'; id: string }) => ({
    caseId: CASE,
    caseNumber: 'RC-000123',
    creditor,
  });
  const submitted = (
    creditor: { type: 'user' | 'organization'; id: string } = { type: 'user', id: CUSTOMER },
  ) =>
    event('recovery.case.submitted', {
      ...ref(creditor),
      kind: 'b2c',
      amountDue: { amount: 150000, currency: 'XOF' },
      source: 'form',
      submittedAt: '2026-10-23T09:00:00Z',
    });

  it('dossier reçu : le créancier par WhatsApp et dans son espace, les superviseurs configurés', async () => {
    const { useCase, whatsapp, inbox } = setup(
      [contact(CUSTOMER), contact(SUPERVISOR, { phoneE164: '+2290197000049' })],
      undefined,
      [],
      [],
      [],
      [SUPERVISOR],
    );
    await expect(useCase.execute(submitted())).resolves.toMatchObject({ accepted: 2, inApp: 2 });
    expect(whatsapp.sent.map((message) => [message.templateCode, message.phoneE164])).toEqual([
      ['recovery.case_submitted.customer', '+2290197000045'],
      ['recovery.case_submitted.team', '+2290197000049'],
    ]);
    expect(inbox.inApp.map((item) => [item.userId, item.link])).toEqual([
      [CUSTOMER, CASE_LINK],
      [SUPERVISOR, null],
    ]);
    expect(whatsapp.sent[0]!.variables).toMatchObject({
      first_name: 'Koffi',
      case_number: 'RC-000123',
      amount_due: `150${NBSP}000${NBSP}FCFA`,
    });
  });

  it('créancier organisation : ses administrateurs, l’e-mail de facturation une fois, lien dans son contexte', async () => {
    const admin = contact(ADMIN, { firstName: 'Awa', phoneE164: '+2290197000046', email: 'awa@example.com' });
    const { useCase, whatsapp, email, inbox } = setup(
      [admin],
      undefined,
      [],
      [],
      [
        {
          organizationId: ORG,
          legalName: 'SARL Bénin Propre',
          billingEmail: 'compta@bp.bj',
          adminUserIds: [ADMIN],
        },
      ],
    );
    await useCase.execute(submitted({ type: 'organization', id: ORG }));
    expect(inbox.inApp.map((item) => [item.userId, item.link])).toEqual([
      [ADMIN, `${CASE_LINK}?organisation=${ORG}`],
    ]);
    expect(email.sent).toEqual([expect.objectContaining({ email: 'compta@bp.bj' })]);
    expect(email.sent[0]!.content!.subject).toBe('Dossier RC-000123 reçu — SARL Bénin Propre');
    expect(whatsapp.sent.map((message) => message.phoneE164)).toEqual(['+2290197000046']);
  });

  it('événement livré deux fois : un seul envoi', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(submitted());
    await expect(useCase.execute(submitted())).resolves.toMatchObject({ status: 'duplicate' });
    expect(whatsapp.sent).toHaveLength(1);
  });

  it('décision à prendre : message important, par WhatsApp et par e-mail, malgré les préférences', async () => {
    const { useCase, whatsapp, email, preferences } = setup([withEmail]);
    await preferences.save(CUSTOMER, { whatsapp: false, email: false }, NOW);
    await expect(
      useCase.execute(
        event('recovery.decision.requested', {
          ...ref({ type: 'user', id: CUSTOMER }),
          decisionId: DECISION,
          kind: 'dispute_response',
          expiresAt: '2026-11-02T10:00:00Z',
          requestedAt: '2026-10-23T10:00:00Z',
        }),
      ),
    ).resolves.toMatchObject({ accepted: 2, optedOut: 0 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent[0]!.content!.text).toContain('répondre à la contestation du débiteur');
    expect(email.sent[0]!.variables['link']).toBe(
      `https://ksp.bj/mon-espace/recouvrement/decisions/${DECISION}`,
    );
  });
});
