import { type CleaningEventPayloads } from '@ksp/contracts';
import { findTemplate, invalidVariables } from '../../domain/template';
import { WHATSAPP_EVENT_TEMPLATES } from './whatsapp-templates';
import { CLEANING_RULES } from '../../application/events/cleaning.rules';
import { type NotificationIntent, type RuleContext } from '../../application/events/event-rules';

const CONTEXT: RuleContext = {
  portalBaseUrl: 'https://ksp.bj',
  timeZone: 'Africa/Porto-Novo',
  cleaningTeamUserIds: [],
  accountsTeamUserIds: [],
};
const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
const AGENT_1 = '0192f1c4-0000-7000-8000-00000000a001';
const AGENT_2 = '0192f1c4-0000-7000-8000-00000000a002';
const MISSION = '0192f1c4-0000-7000-8000-00000000m001';
const REQUEST = '0192f1c4-0000-7000-8000-00000000r001';
const GROUP = '0192f1c4-0000-7000-8000-00000000g001';
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });
const NBSP = ' ';

/** Modèle rendu avec un prénom, après contrôle des variables. */
function render(intent: NotificationIntent) {
  const template = findTemplate(intent.templateCode)!;
  const variables = { ...intent.variables, first_name: 'Koffi' };
  expect(invalidVariables(template, variables)).toEqual([]);
  const whatsapp = WHATSAPP_EVENT_TEMPLATES[intent.templateCode]!;
  expect(whatsapp.parameters(variables).every((parameter) => parameter.length > 0)).toBe(true);
  return { ...template.render!(variables), whatsapp: whatsapp.name(variables) };
}

const quote = (serviceName: string | undefined, amount: number) => ({
  requestId: REQUEST,
  quoteId: '0192f1c4-0000-7000-8000-00000000q001',
  serviceCode: 'home_cleaning',
  ...(serviceName ? { serviceName } : {}),
  total: xof(amount),
  validUntil: '2026-11-12T08:00:00Z',
});

describe('messages des compléments du Nettoyage (ADR-053)', () => {
  it('rappel avant l’expiration : un devis, lien vers la demande', () => {
    const event: CleaningEventPayloads['cleaning.quote.expiry_reminded'] = {
      customerId: CUSTOMER,
      organizationId: null,
      quotes: [quote('Vitres', 25000)],
      validUntil: '2026-11-12T08:00:00Z',
      reminderDays: 2,
    };
    const [intent] = CLEANING_RULES['cleaning.quote.expiry_reminded'](event, CONTEXT);
    expect(intent).toMatchObject({
      userId: CUSTOMER,
      templateCode: 'cleaning.quote_expiry_reminder.customer',
      link: `https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`,
    });
    const message = render(intent!);
    expect(message.subject).toBe('Votre devis expire bientôt');
    expect(message.text).toContain(
      `Votre devis « Vitres » (25${NBSP}000${NBSP}FCFA) reste valable jusqu'au 12 novembre 2026.`,
    );
    expect(message.whatsapp).toBe('ksp_cleaning_quote_expiry_reminder');
  });

  it('devis expirés d’un groupe : un message, lien vers le groupe', () => {
    const event: CleaningEventPayloads['cleaning.quote.expired'] = {
      customerId: CUSTOMER,
      organizationId: null,
      groupId: GROUP,
      quotes: [quote('Vitres', 25000), quote(undefined, 10000)],
      expiredAt: '2026-11-12T08:05:00Z',
    };
    const intents = CLEANING_RULES['cleaning.quote.expired'](event, CONTEXT);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.link).toBe(`https://ksp.bj/mon-espace/nettoyage/demandes/groupes/${GROUP}`);
    const message = render(intents[0]!);
    expect(message.subject).toBe('Vos devis ont expiré');
    expect(message.text).toContain('« Vitres »');
    expect(message.text).toContain('une prestation de nettoyage');
    expect(message.whatsapp).toBe('ksp_cleaning_quotes_expired');
  });

  it('passage reporté : le client, l’agent gardé, l’agent libéré', () => {
    const event: CleaningEventPayloads['cleaning.intervention.rescheduled'] = {
      missionId: MISSION,
      interventionId: '0192f1c4-0000-7000-8000-00000000i001',
      customerId: CUSTOMER,
      previousStart: '2026-11-12T08:00:00Z',
      scheduledStart: '2026-11-14T09:30:00Z',
      durationMinutes: 150,
      agentIds: [AGENT_1],
      releasedAgentIds: [AGENT_2],
      serviceCode: 'home_cleaning',
      serviceName: 'Ménage',
    };
    const intents = CLEANING_RULES['cleaning.intervention.rescheduled'](event, CONTEXT);
    expect(intents.map((intent) => [intent.userId, intent.templateCode])).toEqual([
      [CUSTOMER, 'cleaning.intervention_rescheduled.customer'],
      [AGENT_1, 'cleaning.intervention_rescheduled.agent'],
      [AGENT_2, 'cleaning.intervention_released.agent'],
    ]);
    const customer = render(intents[0]!);
    expect(customer.text).toContain(
      `Votre intervention pour « Ménage » prévue le jeudi 12 novembre 2026 à 09:00 est reportée au samedi 14 novembre 2026 à 10:30 (durée prévue : 2${NBSP}h${NBSP}30).`,
    );
    expect(customer.whatsapp).toBe('ksp_cleaning_intervention_rescheduled_service');
    expect(render(intents[1]!).text).toContain('elle vous est confiée');
    expect(render(intents[2]!).text).toContain('ne vous est plus confiée');
  });

  it('passage annulé pour être replanifié : le client et les agents libérés', () => {
    const event: CleaningEventPayloads['cleaning.intervention.unscheduled'] = {
      missionId: MISSION,
      interventionId: '0192f1c4-0000-7000-8000-00000000i001',
      customerId: CUSTOMER,
      previousStart: '2026-11-12T08:00:00Z',
      releasedAgentIds: [AGENT_1, AGENT_1],
    };
    const intents = CLEANING_RULES['cleaning.intervention.unscheduled'](event, CONTEXT);
    expect(intents.map((intent) => intent.templateCode)).toEqual([
      'cleaning.intervention_unscheduled.customer',
      'cleaning.intervention_released.agent',
    ]);
    const message = render(intents[0]!);
    expect(message.text).toContain('sera replanifiée');
    expect(message.text).toContain('Votre prestation et son prix ne changent pas.');
    expect(message.whatsapp).toBe('ksp_cleaning_intervention_unscheduled');
  });

  it('visite annulée : l’agent seul, prestations citées', () => {
    const event: CleaningEventPayloads['cleaning.visit.cancelled'] = {
      visitId: '0192f1c4-0000-7000-8000-00000000v001',
      requestIds: [REQUEST],
      customerId: CUSTOMER,
      agentId: AGENT_1,
      scheduledAt: '2026-11-12T08:00:00Z',
      outcome: 'cancelled',
      cancelledAt: '2026-11-10T08:00:00Z',
      requests: [{ requestId: REQUEST, serviceCode: 'home_cleaning', serviceName: 'Ménage' }],
    };
    const intents = CLEANING_RULES['cleaning.visit.cancelled'](event, CONTEXT);
    expect(intents).toEqual([
      expect.objectContaining({ userId: AGENT_1, templateCode: 'cleaning.visit_cancelled.agent' }),
    ]);
    expect(render(intents[0]!).text).toContain(
      'La visite technique prévue le jeudi 12 novembre 2026 à 09:00 (« Ménage ») est annulée',
    );
  });
});
