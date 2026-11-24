import { type CleaningEventType } from '@ksp/contracts';
import { CLEANING_RULES } from '../../application/events/cleaning.rules';
import {
  type EventRule,
  type EventRules,
  type NotificationIntent,
  type RuleContext,
} from '../../application/events/event-rules';
import { CLEANING_EVENTS, IDS } from '../../application/testing/cleaning-events';
import { isOptionalMessage } from '../../domain/preferences';
import { findTemplate, invalidVariables, isEventTemplate } from '../../domain/template';
import { WHATSAPP_EVENT_TEMPLATES } from './whatsapp-templates';

/**
 * Messages du Nettoyage v2 rendus de bout en bout : texte français, modèle WhatsApp, et aucune
 * donnée personnelle (CDC Nettoyage v2, 16.3 : ni adresse, ni position, ni texte libre).
 */

const CONTEXT: RuleContext = {
  portalBaseUrl: 'https://ksp.bj',
  timeZone: 'Africa/Porto-Novo',
  cleaningTeamUserIds: [],
  accountsTeamUserIds: [],
  recoverySupervisorUserIds: [],
  recoveryLegalUserIds: [],
  backOfficeBaseUrl: 'https://admin.ksp.bj',
};
const NBSP = '\u00a0';

/** Champs qu'un événement ne doit jamais porter, glissés dans chaque exemple : aucun ne doit ressortir. */
const POISON = {
  address: 'POISON adresse 12 rue des Cocotiers',
  addressLine: 'POISON ligne d’adresse',
  readableAddress: 'POISON adresse lisible',
  landmark: 'POISON repère : portail bleu',
  latitude: 6.3703123,
  longitude: 2.3912456,
  position: { latitude: 6.3703123, longitude: 2.3912456 },
  phone: '+2290197999999',
  comment: 'POISON commentaire',
  note: 'POISON remarque de l’agent',
  text: 'POISON texte libre',
  reason: 'POISON motif saisi',
  description: 'POISON description',
};
const LEAKS = [/POISON/, /6[.,]37031/, /2[.,]39124/, /97999999/];

function intentsOf(type: CleaningEventType, payload: object): NotificationIntent[] {
  const rule = (CLEANING_RULES as EventRules)[type] as EventRule<CleaningEventType> | undefined;
  return rule ? rule(payload as never, CONTEXT) : [];
}

/** Variables complètes, texte rendu et paramètres WhatsApp d'un message. */
function render(intent: NotificationIntent) {
  const template = findTemplate(intent.templateCode)!;
  const variables = { ...intent.variables, first_name: 'Koffi' };
  expect([intent.templateCode, invalidVariables(template, variables)]).toEqual([intent.templateCode, []]);
  const whatsapp = WHATSAPP_EVENT_TEMPLATES[intent.templateCode];
  expect([intent.templateCode, whatsapp !== undefined]).toEqual([intent.templateCode, true]);
  const parameters = whatsapp!.parameters(variables);
  expect([intent.templateCode, parameters.every((parameter) => parameter.trim().length > 0)]).toEqual([
    intent.templateCode,
    true,
  ]);
  return { ...template.render!(variables), variables, whatsapp: whatsapp!.name(variables), parameters };
}

const TYPES = Object.keys(CLEANING_EVENTS) as CleaningEventType[];

describe('Messages du Nettoyage v2 (16.2)', () => {
  it.each(TYPES)('%s : chaque message se rend, en français, avec son modèle WhatsApp', (type) => {
    for (const intent of intentsOf(type, CLEANING_EVENTS[type])) {
      const message = render(intent);
      expect(message.subject.length).toBeGreaterThan(0);
      expect(message.text).toMatch(/^Bonjour Koffi,\n/);
      expect(message.whatsapp).toMatch(/^ksp_cleaning_[a-z_]+$/);
      // Le lien du message figure dans son texte (e-mail, espace KSP).
      if (intent.link) expect(message.text).toContain(intent.link);
    }
  });

  it.each(TYPES)('%s : ni adresse, ni position, ni téléphone, ni texte libre', (type) => {
    for (const intent of intentsOf(type, { ...CLEANING_EVENTS[type], ...POISON })) {
      const message = render(intent);
      const outputs = [
        message.subject,
        message.text,
        message.whatsapp,
        ...message.parameters,
        ...Object.values(message.variables),
        intent.link ?? '',
      ];
      for (const output of outputs) {
        for (const leak of LEAKS)
          expect([intent.templateCode, leak.test(output)]).toEqual([intent.templateCode, false]);
      }
    }
  });

  it('les messages de paiement et de suspension partent toujours (16.2) ; les autres suivent les préférences', () => {
    const always = [
      'cleaning.visit_fee_paid.customer',
      'cleaning.session_payment_due.customer',
      'cleaning.session_paid.customer',
      'cleaning.session_overdue.customer',
      'cleaning.balance_insufficient.customer',
      'cleaning.program_suspended.customer',
      'cleaning.program_suspension_updated.customer',
      'cleaning.program_resumed.customer',
      'cleaning.unpaid_warning.customer',
      'cleaning.request_rejected.customer',
      'cleaning.quote_withdrawn.customer',
      'cleaning.payment_left_in_wallet.customer',
      'cleaning.visit_missed.customer',
    ];
    for (const code of always) expect([code, isOptionalMessage(findTemplate(code)!)]).toEqual([code, false]);
    expect(isOptionalMessage(findTemplate('cleaning.session_started.customer')!)).toBe(true);
    const important = ['cleaning.session_overdue.customer', 'cleaning.program_suspended.customer'];
    for (const code of important) {
      const template = findTemplate(code)!;
      expect([code, isEventTemplate(template) && template.kind]).toEqual([code, 'important']);
    }
  });
});

describe('Textes du Nettoyage v2', () => {
  const first = (type: CleaningEventType, overrides: object = {}, index = 0) =>
    render(intentsOf(type, { ...CLEANING_EVENTS[type], ...overrides })[index]!);

  it('demande envoyée : dossier, lieu et types du catalogue, frais de visite', () => {
    const message = first('cleaning.request.submitted');
    expect(message.subject).toBe('Demande de nettoyage DN-000124 reçue');
    expect(message.text).toContain('Maison (Nettoyage des sols, Vitres)');
    expect(message.text).toContain(`frais de visite (5${NBSP}000${NBSP}FCFA) sont réglés`);
    const unpaid = first('cleaning.request.submitted', { visitFeeStatus: 'awaiting_payment' });
    expect(unpaid.text).toContain(`Réglez les frais de visite (5${NBSP}000${NBSP}FCFA)`);
    expect(unpaid.whatsapp).toBe('ksp_cleaning_request_submitted_unpaid');
  });

  it('superviseur : demande à traiter, avec le lien du back-office', () => {
    const message = first('cleaning.request.submitted', {}, 1);
    expect(message.subject).toBe('Nouvelle demande DN-000124 à traiter');
    expect(message.text).toContain(`https://admin.ksp.bj/nettoyage/demandes/${IDS.request}`);
  });

  it('demande refusée : motif de la liste et remboursement des frais', () => {
    const message = first('cleaning.request.rejected');
    expect(message.subject).toBe('Demande de nettoyage DN-000124 non retenue');
    expect(message.text).toContain('lieu inaccessible');
    expect(message.text).toContain(`Les frais de visite (5${NBSP}000${NBSP}FCFA) sont remboursés`);
    const unpaid = first('cleaning.request.rejected', { visitFeeRefund: null });
    expect(unpaid.text).not.toContain('remboursés');
  });

  it('devis retiré : une nouvelle visite, puis un nouveau devis (R-VI-07)', () => {
    const message = first('cleaning.quote.withdrawn');
    expect(message.text).toContain('Le devis du dossier DN-000124 est retiré');
    expect(message.text).toContain('nouvelle visite des lieux');
    expect(message.text).toContain('nouveau devis');
  });

  it('paiement laissé au portefeuille : montant disponible (R-PP-07)', () => {
    const message = first('cleaning.direct_payment.left_in_wallet');
    expect(message.subject).toBe('Paiement reçu');
    expect(message.text).toContain(`25${NBSP}000${NBSP}FCFA`);
    expect(message.text).toContain('disponible dans votre portefeuille KSP');
    expect(message.text).toContain('https://ksp.bj/mon-espace/portefeuille');
  });

  it('client absent à la visite : nouveaux frais et date limite (R-VI-05)', () => {
    const message = first('cleaning.visit.missed');
    expect(message.text).toContain('absence');
    expect(message.text).toContain(`nouveaux frais de visite (5${NBSP}000${NBSP}FCFA)`);
    expect(message.text).toContain('avant le samedi 28 novembre 2026 à 10:05');
  });

  it('séance désignée par son rang et le numéro du programme', () => {
    const message = first('cleaning.session.reminder');
    expect(message.subject).toBe('Rappel : séance de nettoyage demain');
    expect(message.text).toContain('séance 3 sur 12 du programme PN-000057');
    expect(message.text).toContain('mardi 15 décembre 2026 à 08:00');
    expect(message.text).toContain('Votre solde couvre la séance');
  });

  it('solde insuffisant : montant manquant et lien de recharge', () => {
    const message = first('cleaning.session.balance_insufficient');
    expect(message.text).toContain(`il manque 7${NBSP}500${NBSP}FCFA`);
    expect(message.text).toContain('https://ksp.bj/mon-espace/portefeuille');
  });

  it('séance annulée faute d’agent : rien à payer, choisir une nouvelle date (R-PL-10)', () => {
    const message = first('cleaning.session.cancelled');
    expect(message.text).toContain('aucun agent');
    expect(message.text).toContain('Rien ne vous sera facturé');
  });

  it('suspension : causes en clair, sans promettre de reprise certaine (ADR-030)', () => {
    const message = first('cleaning.program.suspended');
    expect(message.text).toContain('séances en retard de paiement');
    expect(message.text).not.toMatch(/reprendra (automatiquement|dès)/);
  });

  it('alerte de couverture : niveau, séance et agents manquants', () => {
    const message = first('cleaning.session.staffing_alert');
    expect(message.subject).toBe('Séance sans équipe à 48 h — PN-000057');
    expect(message.text).toContain('2 agents manquent');
  });
});
