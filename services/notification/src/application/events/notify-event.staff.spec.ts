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
import { type EventRules, type RuleContext } from './event-rules';
import { NotifyEventUseCase } from './notify-event.use-case';

/**
 * Destinataires résolus au moment de l'événement : personnel de la zone (ListStaffByPermission,
 * RV-62) et administrateurs d'une organisation sans copie à l'e-mail de facturation.
 */

const NOW = new Date('2026-11-20T10:00:00Z');
const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
const SUPERVISOR = '0192f1c4-0000-7000-8000-00000000s001';
const ADMIN = '0192f1c4-0000-7000-8000-00000000s002';
const FALLBACK = '0192f1c4-0000-7000-8000-00000000s003';
const TEAM = '0192f1c4-0000-7000-8000-00000000s004';
const ORG_ADMIN = '0192f1c4-0000-7000-8000-00000000c002';
const ORGANIZATION = '0192f1c4-0000-7000-8000-00000000o001';

const contact = (userId: string, email: string | null = null): RecipientContact => ({
  userId,
  firstName: 'Koffi',
  phoneE164: '+2290197000045',
  email,
  language: 'fr',
});

const AGENT_MESSAGE = { date: 'demain', services: 'dossier DN-000124' };

/** Règles d'essai : un message à la zone et un aux attributions globales, qui se recouvrent. */
const RULES: EventRules = {
  'cleaning.session.interrupted': (event) => [
    {
      userId: '',
      templateCode: 'cleaning.visit_cancelled.agent',
      variables: AGENT_MESSAGE,
      link: null,
      staff: { permission: 'cleaning.program.manage', zoneKey: event.communeKey },
    },
    {
      userId: '',
      templateCode: 'cleaning.visit_cancelled.agent',
      variables: AGENT_MESSAGE,
      link: null,
      staff: { permission: 'cleaning.program.manage', zoneKey: null },
    },
  ],
  'cleaning.quote.forwarded': (event) => [
    {
      userId: event.customerId,
      templateCode: 'cleaning.quote_sent.customer',
      variables: { total: '1\u00a0FCFA', valid_until: 'demain', link: 'https://ksp.bj/d' },
      link: 'https://ksp.bj/d',
      organizationId: event.organizationId!,
      billingEmailCopy: false,
    },
  ],
};

function setup(
  staff: Record<string, string[]>,
  context: Partial<RuleContext> = {},
  organizations: OrganizationBillingContact[] = [],
) {
  const notifications = new InMemoryNotifications();
  const whatsapp = new FakeProvider('whatsapp');
  const email = new FakeProvider('email');
  const clock = new FixedClock(NOW);
  const directory = new FakeStaff(staff);
  const inbox = new InMemoryInbox();
  const useCase = new NotifyEventUseCase(
    RULES,
    new MessageDispatcher(notifications, [whatsapp, email], clock),
    new FakeDirectory([
      contact(CUSTOMER),
      contact(SUPERVISOR),
      contact(ADMIN),
      contact(FALLBACK),
      contact(TEAM),
      contact(ORG_ADMIN, 'awa@benin-propre.bj'),
    ]),
    new FakeOrganizations(organizations),
    directory,
    new InMemoryPreferences(),
    inbox,
    clock,
    new SequentialIds(),
    {
      portalBaseUrl: 'https://ksp.bj',
      timeZone: 'Africa/Porto-Novo',
      cleaningTeamUserIds: [],
      accountsTeamUserIds: [],
      recoverySupervisorUserIds: [],
      recoveryLegalUserIds: [],
      ...context,
    },
  );
  return { useCase, directory, whatsapp, email, inbox };
}

const interrupted = {
  eventId: '0192f1c4-aaaa-7000-8000-000000000001',
  type: 'cleaning.session.interrupted',
  payload: {
    sessionId: '0192f1c4-0000-7000-8000-00000000e001',
    programId: '0192f1c4-0000-7000-8000-00000000p001',
    customerId: CUSTOMER,
    organizationId: null,
    programNumber: 'PN-000057',
    rank: 3,
    sessionsCount: 12,
    communeKey: 'cotonou',
    incidentId: '0192f1c4-0000-7000-8000-00000000i001',
    category: 'equipment',
    interruptedAt: '2026-11-20T09:00:00Z',
  } satisfies KspEventPayloads['cleaning.session.interrupted'],
};

describe('NotifyEventUseCase — personnel du Nettoyage (RV-62)', () => {
  it('joint le personnel de la zone et les attributions globales, une fois par compte', async () => {
    const { useCase, directory, whatsapp, inbox } = setup({
      'cleaning.program.manage@cotonou': [SUPERVISOR, ADMIN],
      'cleaning.program.manage@': [ADMIN],
    });
    await expect(useCase.execute(interrupted)).resolves.toMatchObject({ status: 'processed', accepted: 2 });
    expect(directory.lookups).toEqual([
      { permission: 'cleaning.program.manage', zoneKey: 'cotonou' },
      { permission: 'cleaning.program.manage', zoneKey: null },
    ]);
    expect(whatsapp.sent.map((message) => message.variables['first_name'])).toHaveLength(2);
    expect(inbox.inApp.map((notification) => notification.userId).sort()).toEqual([SUPERVISOR, ADMIN].sort());
  });

  it('personne dans identity : repli configuré pour la permission, jamais zéro destinataire', async () => {
    const { useCase, inbox } = setup(
      {},
      { cleaningStaffFallback: { 'cleaning.program.manage': [FALLBACK] }, cleaningTeamUserIds: [TEAM] },
    );
    await useCase.execute(interrupted);
    expect(inbox.inApp.map((notification) => notification.userId)).toEqual([FALLBACK]);
  });

  it('sans repli pour la permission : l’équipe Nettoyage configurée', async () => {
    const { useCase, inbox } = setup({}, { cleaningTeamUserIds: [TEAM] });
    await useCase.execute(interrupted);
    expect(inbox.inApp.map((notification) => notification.userId)).toEqual([TEAM]);
  });

  it('panne d’identity : erreur, l’événement sera repris', async () => {
    const { useCase, directory, inbox } = setup({});
    directory.unavailable = true;
    await expect(useCase.execute(interrupted)).rejects.toThrow('identity indisponible');
    expect(inbox.processed.size).toBe(0);
  });
});

describe('NotifyEventUseCase — administrateurs d’une organisation sans copie de facturation', () => {
  it('chaque administrateur à sa propre adresse ; rien à l’e-mail de facturation', async () => {
    const { useCase, email, whatsapp } = setup({}, {}, [
      {
        organizationId: ORGANIZATION,
        legalName: 'SARL Bénin Propre',
        billingEmail: 'compta@benin-propre.bj',
        adminUserIds: [ORG_ADMIN],
      },
    ]);
    const forwarded = {
      eventId: '0192f1c4-aaaa-7000-8000-000000000002',
      type: 'cleaning.quote.forwarded',
      payload: {
        quoteId: '0192f1c4-0000-7000-8000-00000000q001',
        requestId: '0192f1c4-0000-7000-8000-00000000r001',
        requestNumber: 'DN-000124',
        customerId: CUSTOMER,
        organizationId: ORGANIZATION,
        forwardedBy: CUSTOMER,
        forwardedAt: '2026-11-20T09:00:00Z',
      } satisfies KspEventPayloads['cleaning.quote.forwarded'],
    };
    await useCase.execute(forwarded);
    expect(email.sent).toEqual([expect.objectContaining({ email: 'awa@benin-propre.bj' })]);
    expect(whatsapp.sent).toHaveLength(0);
  });
});
