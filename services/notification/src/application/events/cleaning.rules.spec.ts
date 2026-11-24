import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type CleaningEventPayloads, type CleaningEventType } from '@ksp/contracts';
import { EVENT_CONSUMERS } from '@ksp/platform';
import { findTemplate, invalidVariables } from '../../domain/template';
import { CLEANING_EVENTS, IDS } from '../testing/cleaning-events';
import { CLEANING_RULES } from './cleaning.rules';
import { type EventRule, type EventRules, type NotificationIntent, type RuleContext } from './event-rules';
import { EVENT_RULES, LISTENED_EVENTS } from './listened-events';

/**
 * Notifications du Nettoyage v2 (CDC Nettoyage v2, 16.2 ; lot G, D40) : chaque moment du tableau
 * 16.2 a sa règle, ses destinataires et ses modèles.
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

/** Destinataire écrit : `user:<id>`, `staff:<permission>@<zone ou *>`, `org:<id>` (copie de facturation) ou `org-admins:<id>`. */
function recipient(intent: NotificationIntent): string {
  if (intent.staff) return `staff:${intent.staff.permission}@${intent.staff.zoneKey ?? '*'}`;
  if (intent.organizationId) {
    return `${intent.billingEmailCopy === false ? 'org-admins' : 'org'}:${intent.organizationId}`;
  }
  return `user:${intent.userId}`;
}

function run<T extends CleaningEventType>(
  type: T,
  overrides: Partial<CleaningEventPayloads[T]> = {},
  context: RuleContext = CONTEXT,
): NotificationIntent[] {
  const rule = (CLEANING_RULES as EventRules)[type] as EventRule<T> | undefined;
  if (!rule) throw new Error(`pas de règle pour ${type}`);
  const payload = { ...CLEANING_EVENTS[type], ...overrides } as CleaningEventPayloads[T];
  return rule(payload as never, context);
}

const sent = (intents: NotificationIntent[]) =>
  intents.map((intent) => `${intent.templateCode} → ${recipient(intent)}`);

const CUSTOMER = `user:${IDS.customer}`;
const AGENT_1 = `user:${IDS.agent1}`;
const AGENT_2 = `user:${IDS.agent2}`;
const REQUEST_STAFF = 'staff:cleaning.request.process@cotonou';
const PROGRAM_STAFF = 'staff:cleaning.program.manage@cotonou';

/**
 * Tableau 16.2 traduit en messages, sur les exemples de `cleaning-events.ts` (particulier), complété
 * par les décisions du lot G (demande refusée, devis retiré, paiement laissé au portefeuille, client
 * absent à la visite) : les 45 événements ont leur message.
 */
const EXPECTED: { readonly [T in CleaningEventType]: readonly string[] } = {
  // Demande envoyée, frais de visite payés : client, superviseur.
  'cleaning.request.submitted': [
    `cleaning.request_submitted.customer → ${CUSTOMER}`,
    `cleaning.request_submitted.staff → ${REQUEST_STAFF}`,
  ],
  'cleaning.request.visit_fee_paid': [
    `cleaning.visit_fee_paid.customer → ${CUSTOMER}`,
    // Sans clé de commune dans l'événement : attributions globales.
    'cleaning.visit_fee_paid.staff → staff:cleaning.request.process@*',
  ],
  'cleaning.request.cancelled': [`cleaning.request_cancelled.customer → ${CUSTOMER}`],
  // Demande refusée par KSP : le client, avec le remboursement des frais.
  'cleaning.request.rejected': [`cleaning.request_rejected.customer → ${CUSTOMER}`],
  // Réactivation d'un devis expiré (R-AC-04) : superviseur (moment « expiration »).
  'cleaning.request.reactivation_requested': [`cleaning.reactivation_requested.staff → ${REQUEST_STAFF}`],
  // Visite planifiée, déplacée : client, agents.
  'cleaning.visit.scheduled': [
    `cleaning.visit_scheduled.customer → ${CUSTOMER}`,
    `cleaning.visit_scheduled.agent → ${AGENT_1}`,
    `cleaning.visit_scheduled.agent → ${AGENT_2}`,
  ],
  // Visite annulée : client, agents libérés.
  'cleaning.visit.cancelled': [
    `cleaning.visit_cancelled.customer → ${CUSTOMER}`,
    `cleaning.visit_released.agent → ${AGENT_1}`,
  ],
  'cleaning.visit.arrived': [`cleaning.visit_arrived.customer → ${CUSTOMER}`],
  // Constat terminé.
  'cleaning.visit.completed': [`cleaning.visit_completed.customer → ${CUSTOMER}`],
  // Client absent : superviseur.
  // Client absent : le client (nouveaux frais à payer, R-VI-05) et le superviseur.
  'cleaning.visit.missed': [
    `cleaning.visit_missed.customer → ${CUSTOMER}`,
    `cleaning.visit_missed.staff → ${REQUEST_STAFF}`,
  ],
  // Devis envoyé, rappel, expiration (client) ; refus et expiration (back-office).
  'cleaning.quote.sent': [`cleaning.quote_sent.customer → ${CUSTOMER}`],
  'cleaning.quote.expiry_reminded': [`cleaning.quote_expiry_reminder.customer → ${CUSTOMER}`],
  'cleaning.quote.expired': [
    `cleaning.quote_expired.customer → ${CUSTOMER}`,
    `cleaning.quote_expired.staff → ${REQUEST_STAFF}`,
  ],
  'cleaning.quote.declined': [`cleaning.quote_declined.staff → ${REQUEST_STAFF}`],
  // Devis envoyé à une organisation : transmis pour accord à ses administrateurs (R-AC-02, RV-63).
  'cleaning.quote.forwarded': [`cleaning.quote_forwarded.customer → org-admins:${IDS.organization}`],
  // Devis retiré, nouvelle visite demandée par KSP (R-VI-07, RV-50) : le client.
  'cleaning.quote.withdrawn': [`cleaning.quote_withdrawn.customer → ${CUSTOMER}`],
  // Devis accepté (back-office), programme confirmé (client).
  'cleaning.quote.accepted': ['cleaning.quote_accepted.staff → staff:cleaning.program.manage@*'],
  'cleaning.program.confirmed': [`cleaning.program_confirmed.customer → ${CUSTOMER}`],
  // Suspension et reprise : client, back-office.
  'cleaning.program.suspended': [
    `cleaning.program_suspended.customer → ${CUSTOMER}`,
    `cleaning.program_suspended.staff → ${PROGRAM_STAFF}`,
  ],
  'cleaning.program.resumed': [
    `cleaning.program_resumed.customer → ${CUSTOMER}`,
    `cleaning.program_resumed.staff → ${PROGRAM_STAFF}`,
  ],
  // Cause ajoutée ou levée : client ; back-office pour une décision de KSP.
  'cleaning.program.suspension_updated': [
    `cleaning.program_suspension_updated.customer → ${CUSTOMER}`,
    'cleaning.program_suspension_updated.staff → staff:cleaning.program.manage@*',
  ],
  'cleaning.program.completed': [`cleaning.program_completed.customer → ${CUSTOMER}`],
  // Arrêt du programme : ses séances sont annulées (client, agents libérés ; RV-67).
  'cleaning.program.cancelled': [
    `cleaning.program_cancelled.customer → ${CUSTOMER}`,
    `cleaning.program_released.agent → ${AGENT_1}`,
  ],
  // Agents affectés, changement d'équipe : client, agents.
  'cleaning.session.assigned': [
    `cleaning.session_assigned.customer → ${CUSTOMER}`,
    `cleaning.session_assigned.agent → ${AGENT_1}`,
    `cleaning.session_assigned.agent → ${AGENT_2}`,
  ],
  'cleaning.sessions.batch_assigned': [
    `cleaning.sessions_assigned.customer → ${CUSTOMER}`,
    `cleaning.sessions_assigned.agent → ${AGENT_1}`,
    `cleaning.sessions_assigned.agent → ${AGENT_2}`,
  ],
  'cleaning.session.unassigned': [`cleaning.session_released.agent → ${AGENT_2}`],
  'cleaning.session.rescheduled': [
    `cleaning.session_rescheduled.customer → ${CUSTOMER}`,
    `cleaning.session_rescheduled.agent → ${AGENT_1}`,
    `cleaning.session_released.agent → ${AGENT_2}`,
  ],
  // Séance annulée : client, agents libérés.
  'cleaning.session.cancelled': [
    `cleaning.session_cancelled.customer → ${CUSTOMER}`,
    `cleaning.session_released.agent → ${AGENT_1}`,
  ],
  // Rappel la veille (client, agents), solde insuffisant (client).
  'cleaning.session.reminder': [
    `cleaning.session_reminder.customer → ${CUSTOMER}`,
    `cleaning.session_reminder.agent → ${AGENT_1}`,
    `cleaning.session_reminder.agent → ${AGENT_2}`,
  ],
  'cleaning.session.balance_insufficient': [`cleaning.balance_insufficient.customer → ${CUSTOMER}`],
  // Équipe arrivée, séance démarrée, réalisée : client.
  'cleaning.session.arrived': [`cleaning.session_arrived.customer → ${CUSTOMER}`],
  'cleaning.session.started': [`cleaning.session_started.customer → ${CUSTOMER}`],
  'cleaning.session.completed': [`cleaning.session_completed.customer → ${CUSTOMER}`],
  // Séance à payer, payée (client), en retard (client, back-office).
  'cleaning.session.payment_due': [`cleaning.session_payment_due.customer → ${CUSTOMER}`],
  'cleaning.session.paid': [`cleaning.session_paid.customer → ${CUSTOMER}`],
  'cleaning.session.overdue': [
    `cleaning.session_overdue.customer → ${CUSTOMER}`,
    `cleaning.session_overdue.staff → ${PROGRAM_STAFF}`,
  ],
  // Incident, client absent, séance sans agent : superviseur (l'admin, attribution globale, aussi).
  'cleaning.session.interrupted': [`cleaning.session_interrupted.staff → ${PROGRAM_STAFF}`],
  'cleaning.session.missed': [`cleaning.session_missed.staff → ${PROGRAM_STAFF}`],
  'cleaning.session.staffing_alert': [`cleaning.staffing_alert.staff → ${PROGRAM_STAFF}`],
  // Avertissement d'impayés : administrateurs de l'organisation, back-office.
  'cleaning.organization.unpaid_warning': [
    `cleaning.unpaid_warning.customer → org:${IDS.organization}`,
    'cleaning.unpaid_warning.staff → staff:cleaning.program.manage@*',
  ],
  // Paiement reçu pour un objet qui n'est plus payable (R-PP-07) : le client.
  'cleaning.direct_payment.left_in_wallet': [`cleaning.payment_left_in_wallet.customer → ${CUSTOMER}`],
  // Candidature d'agent (agent, admin), validation (agent).
  'cleaning.agent.applied': [
    `cleaning.agent_applied.agent → user:${IDS.agent3}`,
    'cleaning.agent_applied.staff → staff:cleaning.agent.manage@cotonou',
    'cleaning.agent_applied.staff → staff:cleaning.agent.manage@abomey-calavi',
  ],
  'cleaning.agent.approved': [`cleaning.agent_approved.agent → user:${IDS.agent3}`],
  // Réclamation ouverte (client, back-office), résolue (client).
  'cleaning.claim.opened': [
    `cleaning.claim_opened.customer → ${CUSTOMER}`,
    'cleaning.claim_opened.staff → staff:cleaning.claim.manage@cotonou',
  ],
  'cleaning.claim.resolved': [`cleaning.claim_resolved.customer → ${CUSTOMER}`],
};

const TYPES = Object.keys(EXPECTED) as CleaningEventType[];
const NOTIFIED = TYPES;

describe('Couverture du tableau 16.2', () => {
  it('les 45 événements publiés par cleaning sont tous classés (schémas du contrat)', () => {
    const schemas = readdirSync(join(__dirname, '../../../../../contracts/events/cleaning'))
      .filter((file) => file.endsWith('.schema.json'))
      .map((file) => file.replace(/\.v\d+\.schema\.json$/, ''))
      .sort();
    expect(schemas).toHaveLength(45);
    expect([...TYPES].sort()).toEqual(schemas);
    expect(Object.keys(CLEANING_EVENTS).sort()).toEqual(schemas);
  });

  it('45 événements couverts sur 45 : chacun a sa règle, et il est écouté', () => {
    expect(NOTIFIED).toHaveLength(45);
    for (const type of NOTIFIED) {
      expect([type, typeof (CLEANING_RULES as EventRules)[type]]).toEqual([type, 'function']);
      expect(EVENT_RULES[type]).toBe((CLEANING_RULES as EventRules)[type]);
      expect(LISTENED_EVENTS).toContain(type);
    }
  });

  it('abonnements : listened-events et EVENT_CONSUMERS.notification exactement alignés', () => {
    // identity.user.deleted : effacement des notifications du compte (AccountErasureConsumer).
    expect([...EVENT_CONSUMERS.notification].sort()).toEqual(
      [...LISTENED_EVENTS, 'identity.user.deleted'].sort(),
    );
  });

  it.each(NOTIFIED)('%s : destinataires et modèles', (type) => {
    const intents = run(type);
    expect(sent(intents)).toEqual(EXPECTED[type]);
    for (const intent of intents) {
      const template = findTemplate(intent.templateCode);
      expect([intent.templateCode, template?.code]).toEqual([intent.templateCode, intent.templateCode]);
      expect([
        intent.templateCode,
        invalidVariables(template!, { ...intent.variables, first_name: 'Koffi' }),
      ]).toEqual([intent.templateCode, []]);
    }
  });
});

describe('Cas particuliers des règles du Nettoyage', () => {
  const PORTAL = 'https://ksp.bj/mon-espace/nettoyage';
  const linkOf = (intents: NotificationIntent[], templateCode: string) =>
    intents.find((intent) => intent.templateCode === templateCode)?.link;

  it('demande en attente des frais de visite : le client seulement, invité à payer', () => {
    const intents = run('cleaning.request.submitted', { visitFeeStatus: 'awaiting_payment' });
    expect(sent(intents)).toEqual([`cleaning.request_submitted.customer → ${CUSTOMER}`]);
    expect(intents[0]!.variables).toMatchObject({ case: 'awaiting_payment', request_number: 'DN-000124' });
  });

  it('visite déplacée : nouvelle date au client et aux agents gardés, ancienne aux agents retirés', () => {
    const intents = run('cleaning.visit.scheduled', {
      previousScheduledAt: '2026-11-24T08:30:00Z',
      agentIds: [IDS.agent1],
      releasedAgentIds: [IDS.agent2],
    });
    expect(sent(intents)).toEqual([
      `cleaning.visit_rescheduled.customer → ${CUSTOMER}`,
      `cleaning.visit_rescheduled.agent → ${AGENT_1}`,
      `cleaning.visit_released.agent → ${AGENT_2}`,
    ]);
    expect(intents[2]!.variables['date']).toBe('mardi 24 novembre 2026 à 09:30');
  });

  it('visite annulée avec sa demande : agents seulement, le client est prévenu de la clôture', () => {
    expect(sent(run('cleaning.visit.cancelled', { cause: 'request_cancelled' }))).toEqual([
      `cleaning.visit_cancelled.agent → ${AGENT_1}`,
    ]);
    expect(sent(run('cleaning.visit.cancelled', { cause: 'request_rejected' }))).toEqual([
      `cleaning.visit_cancelled.agent → ${AGENT_1}`,
    ]);
  });

  it('renouvellement proposé (16.2) : son propre message', () => {
    expect(sent(run('cleaning.quote.sent', { kind: 'renewal' }))).toEqual([
      `cleaning.renewal_proposed.customer → ${CUSTOMER}`,
    ]);
  });

  it('séance d’un lot : rien à l’unité, le récapitulatif du lot en tient lieu (RV-71)', () => {
    expect(run('cleaning.session.assigned', { batchId: IDS.batch })).toEqual([]);
    expect(run('cleaning.session.unassigned', { batchId: IDS.batch })).toEqual([]);
  });

  it('agents retirés par un report ou par leur propre refus : pas de message de retrait', () => {
    // Report : cleaning.session.rescheduled prévient les agents retirés.
    expect(run('cleaning.session.unassigned', { cause: 'rescheduled' })).toEqual([]);
    expect(run('cleaning.session.unassigned', { cause: 'agent_declined' })).toEqual([]);
  });

  it('annulation tardive : pas d’alerte (ni incident ni client absent)', () => {
    expect(run('cleaning.session.missed', { cause: 'late_cancellation' })).toEqual([]);
    expect(sent(run('cleaning.session.missed', { cause: 'access_impossible' }))).toEqual([
      `cleaning.session_missed.staff → ${PROGRAM_STAFF}`,
    ]);
  });

  it('cause ajoutée par le système : le client seulement', () => {
    expect(
      sent(
        run('cleaning.program.suspension_updated', {
          cause: 'overdue_sessions',
          causes: ['overdue_sessions'],
        }),
      ),
    ).toEqual([`cleaning.program_suspension_updated.customer → ${CUSTOMER}`]);
  });

  it('candidature créée par l’admin : l’admin n’est pas prévenu de sa propre saisie', () => {
    expect(sent(run('cleaning.agent.applied', { source: 'admin_created', zoneKeys: [] }))).toEqual([
      `cleaning.agent_applied.agent → user:${IDS.agent3}`,
    ]);
  });

  it('organisation : suspension aux administrateurs (copie de facturation), dossier dans son contexte', () => {
    const intents = run('cleaning.program.suspended', {
      organizationId: IDS.organization,
      causes: ['unpaid_invoices'],
      unpaidCount: 2,
      overdueCount: null,
      threshold: 2,
    });
    expect(sent(intents)).toEqual([
      `cleaning.program_suspended.customer → org:${IDS.organization}`,
      `cleaning.program_suspended.staff → ${PROGRAM_STAFF}`,
    ]);
    // Factures impayées parmi les causes : lien vers les factures (RV-84).
    expect(intents[0]!.link).toBe(`https://ksp.bj/mon-espace/factures?organisation=${IDS.organization}`);
    expect(
      linkOf(
        run('cleaning.session.started', { organizationId: IDS.organization }),
        'cleaning.session_started.customer',
      ),
    ).toBe(`${PORTAL}/programmes/${IDS.program}/seances/${IDS.session}?organisation=${IDS.organization}`);
  });

  it('liens du portail (chemins v2) et du back-office', () => {
    expect(linkOf(run('cleaning.request.submitted'), 'cleaning.request_submitted.customer')).toBe(
      `${PORTAL}/demandes/${IDS.request}`,
    );
    expect(linkOf(run('cleaning.request.submitted'), 'cleaning.request_submitted.staff')).toBe(
      `https://admin.ksp.bj/nettoyage/demandes/${IDS.request}`,
    );
    expect(linkOf(run('cleaning.program.confirmed'), 'cleaning.program_confirmed.customer')).toBe(
      `${PORTAL}/programmes/${IDS.program}`,
    );
    expect(linkOf(run('cleaning.session.payment_due'), 'cleaning.session_payment_due.customer')).toBe(
      `${PORTAL}/programmes/${IDS.program}/seances/${IDS.session}`,
    );
    expect(
      linkOf(run('cleaning.session.balance_insufficient'), 'cleaning.balance_insufficient.customer'),
    ).toBe('https://ksp.bj/mon-espace/portefeuille');
    expect(linkOf(run('cleaning.session.paid'), 'cleaning.session_paid.customer')).toBe(
      `https://ksp.bj/mon-espace/factures/${IDS.invoice}`,
    );
    expect(linkOf(run('cleaning.claim.resolved'), 'cleaning.claim_resolved.customer')).toBe(
      `${PORTAL}/reclamations/${IDS.claim}`,
    );
    expect(
      linkOf(
        run('cleaning.program.completed', { planKind: 'one_off' }),
        'cleaning.program_completed.customer',
      ),
    ).toBe(`${PORTAL}/programmes/${IDS.program}/commander-a-nouveau`);
    expect(linkOf(run('cleaning.session.staffing_alert'), 'cleaning.staffing_alert.staff')).toBe(
      `https://admin.ksp.bj/nettoyage/programmes/${IDS.program}/seances/${IDS.session}`,
    );
    expect(linkOf(run('cleaning.agent.applied'), 'cleaning.agent_applied.staff')).toBe(
      `https://admin.ksp.bj/nettoyage/agents/${IDS.agentProfile}`,
    );
    // Agents : application agent, sans lien.
    expect(linkOf(run('cleaning.session.reminder'), 'cleaning.session_reminder.agent')).toBeNull();
  });

  it('sans adresse du back-office : messages du personnel sans lien', () => {
    const intents = run('cleaning.request.submitted', {}, { ...CONTEXT, backOfficeBaseUrl: null });
    const staff = intents.find((intent) => intent.staff)!;
    expect(staff.link).toBeNull();
    expect(staff.variables).not.toHaveProperty('link');
  });
});
