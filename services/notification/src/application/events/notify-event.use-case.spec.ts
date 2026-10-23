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
    { portalBaseUrl: 'https://ksp.bj', timeZone: 'Africa/Porto-Novo' },
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

describe('NotifyEventUseCase — messages des 7 événements du Nettoyage', () => {
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
