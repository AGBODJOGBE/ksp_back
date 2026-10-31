import { type KspEventPayloads } from '@ksp/contracts';
import { MessageDispatcher } from '../send/message-dispatcher';
import {
  FakeDirectory,
  FakeOrganizations,
  FakeProvider,
  FixedClock,
  InMemoryInbox,
  InMemoryNotifications,
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
) {
  const notifications = new InMemoryNotifications();
  const directory = new FakeDirectory(contacts);
  const organizations = new FakeOrganizations(billingContacts);
  const inbox = new InMemoryInbox();
  const clock = new FixedClock(NOW);
  const useCase = new NotifyEventUseCase(
    EVENT_RULES,
    new MessageDispatcher(notifications, providers, clock),
    directory,
    organizations,
    inbox,
    clock,
    new SequentialIds(),
    {
      portalBaseUrl: 'https://ksp.bj',
      timeZone: 'Africa/Porto-Novo',
      cleaningTeamUserIds,
      accountsTeamUserIds,
    },
  );
  const [whatsapp, email] = providers as [FakeProvider, FakeProvider];
  return { notifications, directory, organizations, inbox, useCase, whatsapp, email };
}

const event = <T extends keyof KspEventPayloads>(type: T, payload: KspEventPayloads[T]): ReceivedEvent => ({
  eventId: EVENT_ID,
  type,
  payload,
});

const quoteRequested = event('cleaning.quote.requested', {
  requestId: REQUEST,
  customerId: CUSTOMER,
  organizationId: null,
  customerKind: 'individual',
  serviceCode: 'home_standard',
  visitRequired: true,
});

const quoteSent = event('cleaning.quote.sent', {
  requestId: REQUEST,
  quoteId: '0192f1c4-0000-7000-8000-00000000q001',
  customerId: CUSTOMER,
  total: { amount: 150000, currency: 'XOF' },
  validUntil: '2026-11-15T22:59:59Z',
});

const missionScheduled = event('cleaning.mission.scheduled', {
  missionId: MISSION,
  interventionId: '0192f1c4-0000-7000-8000-00000000i001',
  customerId: CUSTOMER,
  scheduledStart: '2026-10-29T08:30:00Z',
  durationMinutes: 150,
  agentIds: [AGENT_1, AGENT_2],
});

describe('NotifyEventUseCase — messages des 7 premiers événements du Nettoyage', () => {
  it('cleaning.quote.requested : accusé de réception au client, visite annoncée', async () => {
    const { useCase, whatsapp, inbox } = setup();
    await expect(useCase.execute(quoteRequested)).resolves.toMatchObject({
      status: 'processed',
      accepted: 1,
    });
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({
      templateCode: 'cleaning.quote_requested.customer',
      phoneE164: '+2290197000045',
      locale: 'fr',
      variables: {
        first_name: 'Koffi',
        visit_required: 'true',
        link: `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`,
      },
    });
    expect(whatsapp.sent[0]!.content!.text).toContain('Bonjour Koffi,');
    expect(whatsapp.sent[0]!.content!.text).toContain('visite des lieux');
    expect(inbox.inApp).toEqual([
      expect.objectContaining({
        userId: CUSTOMER,
        templateCode: 'cleaning.quote_requested.customer',
        title: 'Demande de devis reçue',
        link: `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`,
        sourceEventId: EVENT_ID,
      }),
    ]);
  });

  it('cleaning.visit.scheduled : le client et l’agent, date à l’heure du Bénin', async () => {
    const { useCase, whatsapp } = setup([contact(CUSTOMER), contact(AGENT_1, { firstName: 'Awa' })]);
    await useCase.execute(
      event('cleaning.visit.scheduled', {
        requestId: REQUEST,
        visitId: '0192f1c4-0000-7000-8000-00000000v001',
        customerId: CUSTOMER,
        agentId: AGENT_1,
        scheduledAt: '2026-10-29T08:30:00Z',
      }),
    );
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.visit_scheduled.customer',
      'cleaning.visit_scheduled.agent',
    ]);
    expect(whatsapp.sent[0]!.variables['date']).toBe('jeudi 29 octobre 2026 à 09:30');
    expect(whatsapp.sent[1]!.content!.text).toContain('Bonjour Awa,');
  });

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

  it('cleaning.booking.confirmed : montant, passages et paiement choisi', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('cleaning.booking.confirmed', {
        requestId: REQUEST,
        quoteId: '0192f1c4-0000-7000-8000-00000000q001',
        missionId: MISSION,
        customerId: CUSTOMER,
        organizationId: null,
        total: { amount: 150000, currency: 'XOF' },
        plannedInterventions: 4,
        recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 1 },
        paymentPlan: { option: 'deposit', timing: 'before', method: 'mobile_money_online' },
        depositAmount: { amount: 45000, currency: 'XOF' },
      }),
    );
    const text = whatsapp.sent[0]!.content!.text;
    expect(text).toContain(`4 passages pour 150${NBSP}000${NBSP}FCFA`);
    expect(text).toContain(
      `Paiement choisi : acompte de 45${NBSP}000${NBSP}FCFA, avant l'intervention, par Mobile Money en ligne.`,
    );
    expect(whatsapp.sent[0]!.variables['link']).toBe(
      `https://ksp.bj/mon-espace/nettoyage/missions/${MISSION}`,
    );
  });

  it('cleaning.mission.scheduled : le client et chaque agent affecté', async () => {
    const { useCase, whatsapp, inbox } = setup([contact(CUSTOMER), contact(AGENT_1), contact(AGENT_2)]);
    await expect(useCase.execute(missionScheduled)).resolves.toMatchObject({ accepted: 3, inApp: 3 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.mission_scheduled.customer',
      'cleaning.mission_scheduled.agent',
      'cleaning.mission_scheduled.agent',
    ]);
    expect(whatsapp.sent[0]!.content!.text).toContain(`(durée prévue : 2${NBSP}h${NBSP}30)`);
    expect(inbox.inApp.map((notification) => notification.link)).toEqual([
      `https://ksp.bj/mon-espace/nettoyage/missions/${MISSION}`,
      null,
      null,
    ]);
  });

  it('cleaning.mission.completed : compte rendu, document', async () => {
    const { useCase, email } = setup([contact(CUSTOMER, { email: 'koffi@example.com' })]);
    await useCase.execute(
      event('cleaning.mission.completed', {
        missionId: MISSION,
        customerId: CUSTOMER,
        completedInterventions: 1,
        completedAt: '2026-10-29T11:00:00Z',
      }),
    );
    expect(email.sent[0]!.content!.subject).toBe('Prestation de nettoyage terminée');
    expect(email.sent[0]!.content!.text).toContain('1 passage réalisé, le dernier le 29 octobre 2026');
    expect(email.sent[0]!.content!.text).toContain('compte rendu');
  });

  it.each([
    ['customer', 'cancelled', null, 'Votre annulation est bien enregistrée : votre demande'],
    ['supervisor', 'cancelled', MISSION, 'KSP a dû annuler votre prestation'],
    ['supervisor', 'rejected', null, 'pas en mesure de donner suite'],
    ['customer', 'declined', null, 'votre refus du devis'],
  ] as const)('cleaning.request.cancelled par %s (%s)', async (cancelledBy, outcome, missionId, expected) => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      event('cleaning.request.cancelled', {
        requestId: REQUEST,
        missionId,
        customerId: CUSTOMER,
        cancelledBy,
        outcome,
      }),
    );
    expect(whatsapp.sent[0]!.content!.text).toContain(expected);
  });
});

describe('NotifyEventUseCase — fiabilité', () => {
  it('un événement déjà traité n’envoie rien et ne relit pas identity', async () => {
    const { useCase, whatsapp, directory } = setup();
    await useCase.execute(quoteRequested);
    await expect(useCase.execute(quoteRequested)).resolves.toMatchObject({ status: 'duplicate' });
    expect(whatsapp.sent).toHaveLength(1);
    expect(directory.lookups).toHaveLength(1);
  });

  it('reprise après une interruption avant la fin : les messages déjà partis ne repartent pas', async () => {
    const { useCase, whatsapp, inbox, notifications } = setup();
    await useCase.execute(quoteRequested);
    // Simule une coupure entre l'envoi et le marquage de l'événement : il est livré à nouveau.
    inbox.processed.clear();
    inbox.inApp.length = 0;
    await expect(useCase.execute(quoteRequested)).resolves.toMatchObject({
      status: 'processed',
      accepted: 0,
      replayed: 1,
      inApp: 1,
    });
    expect(whatsapp.sent).toHaveLength(1);
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0]!.idempotencyKey).toBe(
      `${EVENT_ID}:cleaning.quote_requested.customer:${CUSTOMER}`,
    );
  });

  it('destinataire introuvable : les autres sont prévenus, l’événement est traité', async () => {
    const { useCase, whatsapp, inbox } = setup([contact(CUSTOMER), contact(AGENT_2)]);
    await expect(useCase.execute(missionScheduled)).resolves.toMatchObject({
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
    await expect(useCase.execute(quoteRequested)).rejects.toThrow('identity indisponible');
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
    await expect(useCase.execute(quoteRequested)).resolves.toMatchObject({ accepted: 1 });
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
    await expect(useCase.execute(quoteRequested)).resolves.toMatchObject({ failed: 1, inApp: 1 });
    expect(notifications.events).toEqual([
      expect.objectContaining({
        templateCode: 'cleaning.quote_requested.customer',
        channelsTried: ['whatsapp'],
        reason: 'provider_unavailable',
        recipientUserId: CUSTOMER,
      }),
    ]);
    expect(inbox.processed.has(EVENT_ID)).toBe(true);
  });

  it('destinataire sans téléphone ni e-mail : notification dans l’espace seulement', async () => {
    const { useCase, whatsapp, inbox } = setup([contact(CUSTOMER, { phoneE164: null, firstName: null })]);
    await expect(useCase.execute(quoteRequested)).resolves.toMatchObject({ unreachable: 1, inApp: 1 });
    expect(whatsapp.sent).toHaveLength(0);
    expect(inbox.inApp[0]!.body.startsWith('Bonjour,\n')).toBe(true);
  });

  it('date illisible dans l’événement : erreur (file d’erreurs après les reprises)', async () => {
    const { useCase, inbox } = setup();
    await expect(
      useCase.execute({
        ...missionScheduled,
        payload: { ...(missionScheduled.payload as object), scheduledStart: 'demain' },
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

describe('NotifyEventUseCase — impayés, suspension et reprise', () => {
  const MISSION_ID = '0192f1c4-0000-7000-8000-0000000d0001';
  const ORG = '0192f1c4-0000-7000-8000-0000000b0001';
  const TEAM_1 = '0192f1c4-0000-7000-8000-0000000e0001';
  const TEAM_2 = '0192f1c4-0000-7000-8000-0000000e0002';
  const withEmail = contact(CUSTOMER, { email: 'koffi@example.com' });

  const warning = event('cleaning.contract.suspension_warning', {
    missionId: MISSION_ID,
    customerId: CUSTOMER,
    organizationId: ORG,
    unpaidCount: 1,
    suspensionThreshold: 2,
  });

  const suspended = event('cleaning.contract.suspended', {
    missionId: MISSION_ID,
    customerId: CUSTOMER,
    organizationId: ORG,
    cause: 'unpaid_invoices',
    unpaidCount: 2,
    threshold: 2,
    cancelledInterventionIds: ['0192f1c4-0000-7000-8000-0000000f0001'],
    releasedAgentIds: [AGENT_1, AGENT_1, AGENT_2],
    suspendedAt: '2026-11-11T08:00:00Z',
  });

  const resumed = event('cleaning.contract.resumed', {
    missionId: MISSION_ID,
    customerId: CUSTOMER,
    organizationId: ORG,
    cause: 'unpaid_invoices',
    unpaidCount: 0,
    resumedAt: '2026-11-12T08:00:00Z',
    rescheduledCount: 3,
    failedCount: 1,
  });

  const reschedulingFailed = event('cleaning.rescheduling.failed', {
    missionId: MISSION_ID,
    customerId: CUSTOMER,
    organizationId: ORG,
    interventionIds: ['0192f1c4-0000-7000-8000-0000000f0002'],
    failedCount: 1,
  });

  it('avertissement : message important, par WhatsApp ET par e-mail, seuil annoncé', async () => {
    const { useCase, whatsapp, email, notifications } = setup([withEmail]);
    await expect(useCase.execute(warning)).resolves.toMatchObject({ accepted: 2, inApp: 1 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.suspension_warning.customer',
    ]);
    expect(email.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.suspension_warning.customer',
    ]);
    expect(email.sent[0]!.content!.text).toContain(
      'Votre contrat de nettoyage compte 1 facture impayée. Au seuil de 2 impayés, le service sera suspendu',
    );
    expect(email.sent[0]!.variables['link']).toBe('https://ksp.bj/mon-espace/factures');
    expect(notifications.rows.map((row) => [row.idempotencyKey, row.targetMasked])).toEqual([
      [`${EVENT_ID}:cleaning.suspension_warning.customer:${CUSTOMER}:whatsapp`, '+229********45'],
      [`${EVENT_ID}:cleaning.suspension_warning.customer:${CUSTOMER}:email`, 'k***@example.com'],
    ]);
  });

  it('avertissement sans adresse e-mail : WhatsApp seul', async () => {
    const { useCase, whatsapp, email } = setup();
    await expect(useCase.execute(warning)).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
  });

  it('message important rejoué : aucun des deux canaux ne repart', async () => {
    const { useCase, whatsapp, email, inbox } = setup([withEmail]);
    await useCase.execute(warning);
    inbox.processed.clear();
    await expect(useCase.execute(warning)).resolves.toMatchObject({ accepted: 0, replayed: 2 });
    expect(whatsapp.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
  });

  it('suspension : le client (WhatsApp et e-mail) et chaque agent libéré, une seule fois', async () => {
    const { useCase, whatsapp, email } = setup([withEmail, contact(AGENT_1), contact(AGENT_2)]);
    await expect(useCase.execute(suspended)).resolves.toMatchObject({ accepted: 4, inApp: 3 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.contract_suspended.customer',
      'cleaning.contract_suspended.agent',
      'cleaning.contract_suspended.agent',
    ]);
    expect(email.sent[0]!.content!.text).toContain(
      'Votre prestation de nettoyage est suspendue : 2 factures impayées, le seuil de suspension est atteint.',
    );
    expect(whatsapp.sent[1]!.content!.text).toContain('le contrat du client est suspendu');
  });

  it('suspension d’un particulier : passages impayés, lien vers la mission', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute({
      ...suspended,
      payload: {
        ...(suspended.payload as object),
        cause: 'unpaid_interventions',
        unpaidCount: 1,
        releasedAgentIds: [],
      },
    });
    expect(whatsapp.sent[0]!.content!.text).toContain('suspendue : 1 passage impayé');
    expect(whatsapp.sent[0]!.variables['link']).toBe(
      `https://ksp.bj/mon-espace/nettoyage/missions/${MISSION_ID}`,
    );
  });

  it('suspension de l’organisation par KSP : message sans impayés, lien vers la mission (ADR-030)', async () => {
    const { useCase, whatsapp, email } = setup([withEmail, contact(AGENT_1), contact(AGENT_2)]);
    await expect(
      useCase.execute({
        ...suspended,
        payload: { ...(suspended.payload as object), cause: 'organization_suspended', unpaidCount: 0 },
      }),
    ).resolves.toMatchObject({ accepted: 4, inApp: 3 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.contract_suspended_organization.customer',
      'cleaning.contract_suspended.agent',
      'cleaning.contract_suspended.agent',
    ]);
    const text = email.sent[0]!.content!.text;
    expect(text).toContain(
      'Votre prestation de nettoyage est suspendue : KSP a suspendu votre compte entreprise.',
    );
    expect(text).not.toContain('impayé');
    expect(whatsapp.sent[0]!.variables['link']).toBe(
      `https://ksp.bj/mon-espace/nettoyage/missions/${MISSION_ID}`,
    );
  });

  type SuspensionUpdate = KspEventPayloads['cleaning.contract.suspension_updated'];
  const suspensionUpdated = (
    payload: Pick<SuspensionUpdate, 'change' | 'cause' | 'causes'> & Partial<SuspensionUpdate>,
  ) =>
    event('cleaning.contract.suspension_updated', {
      missionId: MISSION_ID,
      customerId: CUSTOMER,
      organizationId: ORG,
      unpaidCount: 2,
      updatedAt: '2026-11-20T08:00:00Z',
      ...payload,
    });

  it('réactivation alors que des factures restent impayées : suspension maintenue, lien vers les factures (ADR-030)', async () => {
    const { useCase, whatsapp, email } = setup([withEmail]);
    await expect(
      useCase.execute(
        suspensionUpdated({
          change: 'cause_lifted',
          cause: 'organization_suspended',
          causes: ['unpaid_invoices'],
        }),
      ),
    ).resolves.toMatchObject({ accepted: 2, inApp: 1 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.suspension_updated.customer',
    ]);
    expect(email.sent[0]!.content!.text).toContain(
      'Votre compte entreprise est réactivé, mais la suspension de votre prestation de nettoyage est maintenue : 2 factures impayées.',
    );
    expect(whatsapp.sent[0]!.variables['link']).toBe('https://ksp.bj/mon-espace/factures');
  });

  it('règlement alors que l’organisation reste suspendue : pas de reprise annoncée (ADR-030)', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      suspensionUpdated({
        change: 'cause_lifted',
        cause: 'unpaid_invoices',
        causes: ['organization_suspended'],
        unpaidCount: 1,
      }),
    );
    const text = whatsapp.sent[0]!.content!.text;
    expect(text).toContain(
      'Merci pour votre règlement. Votre prestation de nettoyage reste toutefois suspendue',
    );
    expect(whatsapp.sent[0]!.variables['link']).toBe(
      `https://ksp.bj/mon-espace/nettoyage/missions/${MISSION_ID}`,
    );
  });

  it('cause ajoutée à une suspension en cours : le client sait ce qui la maintient (ADR-030)', async () => {
    const { useCase, whatsapp } = setup();
    await useCase.execute(
      suspensionUpdated({
        change: 'cause_added',
        cause: 'unpaid_invoices',
        causes: ['organization_suspended', 'unpaid_invoices'],
      }),
    );
    await useCase.execute({
      ...suspensionUpdated({
        change: 'cause_added',
        cause: 'organization_suspended',
        causes: ['unpaid_invoices', 'organization_suspended'],
      }),
      eventId: '0192f1c4-0000-7000-8000-0000000a0999',
    });
    expect(whatsapp.sent.map((message) => message.variables['case'])).toEqual([
      'unpaid_added',
      'organization_added',
    ]);
    expect(whatsapp.sent[0]!.content!.text).toContain(
      'compte 2 factures impayées, le seuil de suspension est atteint',
    );
    expect(whatsapp.sent[1]!.content!.text).toContain(
      'KSP a suspendu votre compte entreprise : même après le règlement de vos factures',
    );
  });

  it('reprise à la réactivation de l’organisation : ni remerciement ni règlement (ADR-030)', async () => {
    const { useCase, whatsapp } = setup([contact(CUSTOMER), contact(TEAM_1)], undefined, [TEAM_1]);
    await useCase.execute({
      ...resumed,
      payload: { ...(resumed.payload as object), cause: 'organization_suspended' },
    });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.contract_resumed_organization.customer',
      'cleaning.contract_resumed_organization.team',
    ]);
    const customerText = whatsapp.sent[0]!.content!.text;
    expect(customerText).toContain(
      'Votre compte entreprise est réactivé : votre prestation de nettoyage reprend.',
    );
    expect(customerText).toContain('3 passages reprogrammés.');
    expect(customerText).not.toContain('règlement');
    expect(whatsapp.sent[1]!.content!.text).toContain(
      `La mission ${MISSION_ID} a repris après la réactivation du compte entreprise par KSP : 3 passages reprogrammés, 1 passage à replanifier à la main au back-office.`,
    );
  });

  it('reprise : le client et chaque membre de l’équipe Nettoyage configurée', async () => {
    const { useCase, whatsapp } = setup(
      [contact(CUSTOMER), contact(TEAM_1, { firstName: 'Awa' }), contact(TEAM_2)],
      undefined,
      [TEAM_1, TEAM_2],
    );
    await expect(useCase.execute(resumed)).resolves.toMatchObject({ accepted: 3 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.contract_resumed.customer',
      'cleaning.contract_resumed.team',
      'cleaning.contract_resumed.team',
    ]);
    const customerText = whatsapp.sent[0]!.content!.text;
    expect(customerText).toContain('votre prestation de nettoyage reprend');
    expect(customerText).toContain('3 passages reprogrammés.');
    expect(customerText).toContain('replanifier le passage restant');
    expect(whatsapp.sent[1]!.content!.text).toContain(
      `La mission ${MISSION_ID} a repris après règlement des impayés : 3 passages reprogrammés, 1 passage à replanifier à la main au back-office.`,
    );
  });

  it('reprise sans équipe configurée : le client seul', async () => {
    const { useCase, whatsapp, directory } = setup();
    await useCase.execute(resumed);
    expect(whatsapp.sent).toHaveLength(1);
    expect(directory.lookups).toEqual([[CUSTOMER]]);
  });

  it('reprogrammation incomplète : l’équipe Nettoyage seulement', async () => {
    const { useCase, whatsapp } = setup([contact(CUSTOMER), contact(TEAM_1)], undefined, [TEAM_1]);
    await expect(useCase.execute(reschedulingFailed)).resolves.toMatchObject({ accepted: 1 });
    expect(whatsapp.sent.map((message) => message.templateCode)).toEqual([
      'cleaning.rescheduling_failed.team',
    ]);
    expect(whatsapp.sent[0]!.content!.text).toContain('1 passage à replanifier à la main au back-office');
  });

  it('reprogrammation incomplète sans équipe configurée : rien à envoyer, événement traité', async () => {
    const { useCase, whatsapp, inbox, directory } = setup();
    await expect(useCase.execute(reschedulingFailed)).resolves.toMatchObject({
      status: 'processed',
      inApp: 0,
    });
    expect(whatsapp.sent).toHaveLength(0);
    expect(directory.lookups).toHaveLength(0);
    expect(inbox.processed.has(EVENT_ID)).toBe(true);
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
    organizationId: ORG,
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

  describe('facture d’une organisation (ADR-027)', () => {
    const billing = (billingEmail: string | null) => [
      { organizationId: ORG, legalName: 'SARL Bénin Propre', billingEmail },
    ];
    const setupOrg = (contacts: RecipientContact[], billingEmail: string | null) =>
      setup(contacts, undefined, [], [], billing(billingEmail));

    it('e-mail à l’adresse de facturation vérifiée ; l’espace KSP reste celui du compte client', async () => {
      const { useCase, whatsapp, email, inbox, organizations } = setupOrg(
        [withEmail],
        'Compta@Benin-Propre.bj',
      );
      await expect(useCase.execute(issued)).resolves.toMatchObject({ accepted: 1, inApp: 1 });
      expect(organizations.lookups).toEqual([[ORG]]);
      expect(whatsapp.sent).toHaveLength(0);
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]).toMatchObject({
        templateCode: 'billing.invoice_issued.customer',
        email: 'compta@benin-propre.bj',
      });
      expect(email.sent[0]!.content!.subject).toBe('Votre facture FAC-2026-000042 — SARL Bénin Propre');
      expect(inbox.inApp).toEqual([expect.objectContaining({ userId: CUSTOMER, link: LINK })]);
    });

    it('e-mail de facturation refusé par le prestataire : bascule sur le WhatsApp du compte client', async () => {
      const providers = [
        new FakeProvider('whatsapp'),
        new FakeProvider('email', [{ accepted: false, reason: 'recipient_invalid' }]),
      ];
      const { useCase, whatsapp } = setup([contact(CUSTOMER)], providers, [], [], billing('compta@bp.bj'));
      await expect(useCase.execute(overdue)).resolves.toMatchObject({ accepted: 1 });
      expect(whatsapp.sent).toEqual([expect.objectContaining({ phoneE164: '+2290197000045' })]);
    });

    it('sans e-mail de facturation : repli sur l’adresse vérifiée du compte client, objet nommant l’entreprise', async () => {
      const { useCase, email } = setupOrg([withEmail], null);
      await useCase.execute(paid);
      expect(email.sent).toEqual([expect.objectContaining({ email: 'koffi@example.com' })]);
      expect(email.sent[0]!.content!.subject).toBe('Facture FAC-2026-000042 réglée — SARL Bénin Propre');
    });

    it('organisation introuvable : repli sur l’adresse vérifiée du compte client, objet inchangé', async () => {
      const { useCase, email } = setup([withEmail]);
      await useCase.execute(issued);
      expect(email.sent).toEqual([expect.objectContaining({ email: 'koffi@example.com' })]);
      expect(email.sent[0]!.content!.subject).toBe('Votre facture FAC-2026-000042');
    });

    it('ni e-mail de facturation ni adresse vérifiée : WhatsApp au compte client, aucun e-mail', async () => {
      const { useCase, whatsapp, email } = setupOrg([contact(CUSTOMER)], null);
      await useCase.execute(issued);
      expect(email.sent).toHaveLength(0);
      expect(whatsapp.sent).toHaveLength(1);
      // Le modèle WhatsApp ne change pas : la raison sociale n'est pas un de ses paramètres.
      expect(whatsapp.sent[0]!.variables['organization_name']).toBe('SARL Bénin Propre');
    });

    it('identity indisponible pour l’organisation : erreur (reprise par la file), rien n’est envoyé', async () => {
      const { useCase, whatsapp, email, inbox, organizations } = setupOrg([withEmail], 'compta@bp.bj');
      organizations.unavailable = true;
      await expect(useCase.execute(issued)).rejects.toThrow('identity indisponible');
      expect([...whatsapp.sent, ...email.sent]).toHaveLength(0);
      expect(inbox.processed.size).toBe(0);
    });

    it('facture d’un particulier : l’annuaire des organisations n’est pas lu', async () => {
      const { useCase, email, organizations } = setupOrg([withEmail], 'compta@bp.bj');
      await useCase.execute({ ...issued, payload: { ...(issued.payload as object), organizationId: null } });
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
      [{ organizationId: ORG, legalName: 'SARL Bénin Propre', billingEmail: 'compta@beninpropre.bj' }],
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
