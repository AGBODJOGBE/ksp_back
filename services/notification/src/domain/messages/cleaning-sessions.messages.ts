import { type EventTemplateDefinition } from '../template';
import { AMOUNT, COUNT, details, greeting, LINK, lines, oneOf, template, TEXT } from './cleaning.shared';

/**
 * Messages du Nettoyage v2 au client : séances, paiement des séances et réclamations (CDC
 * Nettoyage v2, 16.2). Une séance est désignée par son rang et le numéro de son programme
 * (variable `session` : « séance 3 sur 12 du programme PN-000057 »), jamais par son adresse.
 */

/** « séance 3 sur 12 du programme PN-000057 », écrite par la règle. */
const SESSION = TEXT;

export const CLEANING_SESSION_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'cleaning.session_assigned.customer',
    'short',
    { session: SESSION, date: TEXT, link: LINK },
    (v) => ({
      subject: 'Équipe de nettoyage désignée',
      text: lines(
        greeting(v),
        `L'équipe de votre ${v['session']}, le ${v['date']}, est désignée.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.sessions_assigned.customer',
    'short',
    { count: COUNT, first_date: TEXT, last_date: TEXT, link: LINK },
    (v) => ({
      subject: 'Équipes de nettoyage désignées',
      text: lines(
        greeting(v),
        `Les équipes de ${v['count']} séances de votre programme sont désignées, du ${v['first_date']} au ${v['last_date']}.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.session_rescheduled.customer',
    'short',
    { session: SESSION, date: TEXT, previous_date: TEXT, link: LINK },
    (v) => ({
      subject: 'Séance de nettoyage reportée',
      text: lines(
        greeting(v),
        `Votre ${v['session']}, prévue le ${v['previous_date']}, est reportée au ${v['date']}.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.session_cancelled.customer',
    'short',
    { case: oneOf('customer', 'ksp', 'no_agent'), session: SESSION, date: TEXT, link: LINK },
    (v) => ({
      subject: 'Séance de nettoyage annulée',
      text: lines(
        greeting(v),
        v['case'] === 'customer'
          ? `L'annulation de votre ${v['session']} du ${v['date']} est enregistrée.`
          : v['case'] === 'no_agent'
            ? `Votre ${v['session']} du ${v['date']} est annulée : aucun agent n'a pu l'assurer. ` +
              'Rien ne vous sera facturé. Choisissez une nouvelle date dans Mon espace KSP.'
            : `KSP a dû annuler votre ${v['session']} du ${v['date']}. Pour toute question, contactez le service client KSP.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.session_reminder.customer',
    'short',
    { session: SESSION, date: TEXT, case: oneOf('sufficient', 'insufficient', 'invoiced'), link: LINK },
    (v) => ({
      subject: 'Rappel : séance de nettoyage demain',
      text: lines(
        greeting(v),
        `Votre ${v['session']} a lieu demain, le ${v['date']}.`,
        v['case'] === 'sufficient'
          ? `Votre solde couvre la séance${v['amount'] ? ` (${v['amount']})` : ''}.`
          : v['case'] === 'insufficient'
            ? `Votre solde ne couvre pas la séance${v['amount'] ? ` (${v['amount']})` : ''} : rechargez votre portefeuille KSP.`
            : '',
        details(v),
      ),
    }),
    { amount: AMOUNT },
  ),
  template(
    'cleaning.balance_insufficient.customer',
    'short',
    { session: SESSION, date: TEXT, amount_due: AMOUNT, missing: AMOUNT, link: LINK },
    (v) => ({
      subject: 'Solde insuffisant pour votre prochaine séance',
      text: lines(
        greeting(v),
        `Votre solde ne couvre pas votre ${v['session']} du ${v['date']} (${v['amount_due']}) : il manque ${v['missing']}.`,
        `Rechargez votre portefeuille KSP : ${v['link']}`,
      ),
    }),
  ),
  template('cleaning.session_arrived.customer', 'short', { session: SESSION, link: LINK }, (v) => ({
    subject: "L'équipe KSP est arrivée",
    text: lines(greeting(v), `L'équipe KSP est arrivée pour votre ${v['session']}.`, details(v)),
  })),
  template('cleaning.session_started.customer', 'short', { session: SESSION, link: LINK }, (v) => ({
    subject: 'Séance de nettoyage commencée',
    text: lines(greeting(v), `Votre ${v['session']} a commencé.`, details(v)),
  })),
  template('cleaning.session_completed.customer', 'short', { session: SESSION, link: LINK }, (v) => ({
    subject: 'Séance de nettoyage terminée',
    text: lines(
      greeting(v),
      `Votre ${v['session']} est terminée. Un problème ? Signalez-le depuis Mon espace KSP dans le délai indiqué.`,
      details(v),
    ),
  })),
  template(
    'cleaning.session_payment_due.customer',
    'short',
    { session: SESSION, amount: AMOUNT, due_by: TEXT, link: LINK },
    (v) => ({
      subject: 'Séance de nettoyage à payer',
      text: lines(
        greeting(v),
        `Votre solde n'a pas permis de payer votre ${v['session']} : ${v['amount']} à régler avant le ${v['due_by']}.`,
        `Payez depuis Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.session_paid.customer',
    'short',
    { session: SESSION, amount: AMOUNT, link: LINK },
    (v) => ({
      subject: 'Séance de nettoyage payée',
      text: lines(greeting(v), `Votre ${v['session']} est payée : ${v['amount']}.`, details(v)),
    }),
  ),
  template(
    'cleaning.session_overdue.customer',
    'important',
    { session: SESSION, amount: AMOUNT, link: LINK },
    (v) => ({
      subject: 'Paiement de séance en retard',
      text: lines(
        greeting(v),
        `Le paiement de votre ${v['session']} (${v['amount']}) est en retard. ` +
          "La séance suivante ne pourra pas commencer tant qu'il n'est pas réglé.",
        `Payez depuis Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template('cleaning.claim_opened.customer', 'short', { link: LINK }, (v) => ({
    subject: 'Réclamation reçue',
    text: lines(
      greeting(v),
      'Nous avons bien reçu votre réclamation. Notre équipe vous répond dans Mon espace KSP.',
      details(v),
    ),
  })),
  template(
    'cleaning.claim_resolved.customer',
    'short',
    { case: oneOf('free_redo', 'wallet_credit', 'rejected'), link: LINK },
    (v) => ({
      subject: 'Réclamation traitée',
      text: lines(
        greeting(v),
        v['case'] === 'free_redo'
          ? 'Votre réclamation est acceptée : une nouvelle séance gratuite est ajoutée à votre programme.'
          : v['case'] === 'wallet_credit'
            ? `Votre réclamation est acceptée : ${v['amount'] ? `${v['amount']} sont crédités` : 'un crédit est accordé'} à votre compte.`
            : "Après examen, votre réclamation n'est pas retenue. Le détail de la décision est dans Mon espace KSP.",
        details(v),
      ),
    }),
    { amount: AMOUNT },
  ),
];
