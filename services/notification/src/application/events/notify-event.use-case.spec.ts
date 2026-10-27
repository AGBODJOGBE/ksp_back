import { type KspEventPayloads } from '@ksp/contracts';
import { MessageDispatcher } from '../send/message-dispatcher';
import {
  FakeDirectory,
  FakeProvider,
  FixedClock,
  InMemoryInbox,
  InMemoryNotifications,
  SequentialIds,
} from '../testing/fakes';
import { type RecipientContact } from './event-notification.ports';
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
) {
  const notifications = new InMemoryNotifications();
  const directory = new FakeDirectory(contacts);
  const inbox = new InMemoryInbox();
  const clock = new FixedClock(NOW);
  const useCase = new NotifyEventUseCase(
    EVENT_RULES,
    new MessageDispatcher(notifications, providers, clock),
    directory,
    inbox,
    clock,
    new SequentialIds(),
    { portalBaseUrl: 'https://ksp.bj', timeZone: 'Africa/Porto-Novo', cleaningTeamUserIds },
  );
  const [whatsapp, email] = providers as [FakeProvider, FakeProvider];
  return { notifications, directory, inbox, useCase, whatsapp, email };
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
