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
const REQUEST = '0192f1c4-0000-7000-8000-00000000r001';
const QUOTE = '0192f1c4-0000-7000-8000-00000000q001';
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

describe('messages des compléments du Nettoyage (ADR-053), sur les événements v2 (ADR-054)', () => {
  it('rappel avant l’expiration : le devis du dossier, lien vers la demande', () => {
    const event: CleaningEventPayloads['cleaning.quote.expiry_reminded'] = {
      quoteId: QUOTE,
      requestId: REQUEST,
      requestNumber: 'DN-000124',
      customerId: CUSTOMER,
      organizationId: null,
      total: xof(25000),
      validUntil: '2026-11-12T08:00:00Z',
      reminderDays: 2,
      remindedAt: '2026-11-10T08:00:00Z',
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
      `Votre devis du dossier DN-000124 (25${NBSP}000${NBSP}FCFA) reste valable jusqu'au 12 novembre 2026.`,
    );
    expect(message.whatsapp).toBe('ksp_cleaning_quote_expiry_reminder');
  });

  it('devis expiré : un message au client, lien vers la demande', () => {
    const event: CleaningEventPayloads['cleaning.quote.expired'] = {
      quoteId: QUOTE,
      requestId: REQUEST,
      customerId: CUSTOMER,
      organizationId: null,
      validUntil: '2026-11-12T08:00:00Z',
      expiredAt: '2026-11-12T08:05:00Z',
      requestNumber: 'DN-000124',
      communeKey: 'cotonou',
      total: xof(25000),
      placeTypeName: 'Maison',
      cleaningTypeNames: ['Sol', 'Vitres'],
    };
    // Le superviseur de la zone est prévenu à part (cleaning.rules.spec.ts).
    const intents = CLEANING_RULES['cleaning.quote.expired'](event, CONTEXT).filter(
      (intent) => !intent.staff,
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]!.link).toBe(`https://ksp.bj/mon-espace/nettoyage/demandes/${REQUEST}`);
    const message = render(intents[0]!);
    expect(message.subject).toBe('Votre devis a expiré');
    expect(message.text).toContain('du dossier DN-000124');
    expect(message.whatsapp).toBe('ksp_cleaning_quote_expired');
  });

  it('visite annulée avec sa demande : chaque agent libéré, dossier cité', () => {
    const event: CleaningEventPayloads['cleaning.visit.cancelled'] = {
      visitId: '0192f1c4-0000-7000-8000-00000000v001',
      requestId: REQUEST,
      requestNumber: 'DN-000124',
      customerId: CUSTOMER,
      organizationId: null,
      communeKey: 'cotonou',
      releasedAgentIds: [AGENT_1, AGENT_1],
      scheduledAt: '2026-11-12T08:00:00Z',
      cause: 'request_cancelled',
      visitFeeRefund: xof(5000),
      cancelledAt: '2026-11-10T08:00:00Z',
    };
    const intents = CLEANING_RULES['cleaning.visit.cancelled'](event, CONTEXT);
    expect(intents).toEqual([
      expect.objectContaining({ userId: AGENT_1, templateCode: 'cleaning.visit_cancelled.agent' }),
    ]);
    const message = render(intents[0]!);
    expect(message.text).toContain(
      'La visite technique prévue le jeudi 12 novembre 2026 à 09:00 (dossier DN-000124) est annulée',
    );
    expect(message.whatsapp).toBe('ksp_cleaning_visit_cancelled');
  });
});
