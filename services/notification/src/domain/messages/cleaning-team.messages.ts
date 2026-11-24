import { type EventTemplateDefinition } from '../template';
import {
  COUNT,
  details,
  greeting,
  INTEGER,
  LINK,
  lines,
  NUMBER,
  oneOf,
  plural,
  template,
  TEXT,
} from './cleaning.shared';

/**
 * Messages du Nettoyage v2 aux agents (`.agent`) et au personnel du back-office (`.staff` :
 * superviseur de la zone, admin) (CDC Nettoyage v2, 16.2). Ils partent toujours, sans tenir compte
 * des préférences. Aucun montant : un agent ne voit jamais les montants (R-EX-04), et le personnel
 * prévenu n'a pas forcément `cleaning.amounts.read` (16.3). L'agent retrouve l'adresse dans son
 * application ; le personnel a un lien vers le back-office quand son adresse est configurée.
 */

const SESSION = TEXT;

export const CLEANING_TEAM_TEMPLATES: readonly EventTemplateDefinition[] = [
  // Agents.
  template(
    'cleaning.visit_rescheduled.agent',
    'short',
    { request_number: NUMBER, date: TEXT, previous_date: TEXT },
    (v) => ({
      subject: 'Visite technique déplacée',
      text: lines(
        greeting(v),
        // Valable pour un agent gardé comme pour un agent ajouté par le déplacement.
        `La visite technique du dossier ${v['request_number']} vous est confiée le ${v['date']} ` +
          `(elle était prévue le ${v['previous_date']}). Retrouvez les détails dans votre application KSP.`,
      ),
    }),
  ),
  template('cleaning.visit_released.agent', 'short', { request_number: NUMBER, date: TEXT }, (v) => ({
    subject: 'Visite technique retirée',
    text: lines(
      greeting(v),
      `La visite technique du ${v['date']} (dossier ${v['request_number']}) ne vous est plus confiée. ` +
        "Vous n'avez pas à vous déplacer.",
    ),
  })),
  template('cleaning.session_assigned.agent', 'short', { session: SESSION, date: TEXT }, (v) => ({
    subject: 'Nouvelle séance de nettoyage',
    text: lines(
      greeting(v),
      `La ${v['session']}, le ${v['date']}, vous est confiée. Retrouvez les détails dans votre application KSP.`,
    ),
  })),
  template(
    'cleaning.sessions_assigned.agent',
    'short',
    { count: COUNT, first_date: TEXT, last_date: TEXT },
    (v) => ({
      subject: 'Nouvelles séances de nettoyage',
      text: lines(
        greeting(v),
        `${v['count']} séances d'un même programme vous sont confiées, du ${v['first_date']} au ${v['last_date']}. ` +
          'Retrouvez-les dans votre application KSP.',
      ),
    }),
  ),
  template(
    'cleaning.session_rescheduled.agent',
    'short',
    { session: SESSION, date: TEXT, previous_date: TEXT },
    (v) => ({
      subject: 'Séance de nettoyage reportée',
      text: lines(
        greeting(v),
        `La ${v['session']}, prévue le ${v['previous_date']}, est reportée au ${v['date']}. Elle vous reste confiée.`,
      ),
    }),
  ),
  template('cleaning.session_released.agent', 'short', { session: SESSION, date: TEXT }, (v) => ({
    subject: 'Séance de nettoyage retirée',
    text: lines(
      greeting(v),
      `La ${v['session']} du ${v['date']} ne vous est plus confiée. Vous n'avez pas à vous déplacer.`,
    ),
  })),
  template('cleaning.program_released.agent', 'short', {}, (v) => ({
    subject: 'Séances de nettoyage retirées',
    text: lines(
      greeting(v),
      'Un programme de nettoyage est arrêté : ses séances à venir ne vous sont plus confiées. ' +
        'Votre planning est à jour dans votre application KSP.',
    ),
  })),
  template('cleaning.session_reminder.agent', 'short', { session: SESSION, date: TEXT }, (v) => ({
    subject: 'Rappel : séance de nettoyage demain',
    text: lines(
      greeting(v),
      `Rappel : la ${v['session']} a lieu demain, le ${v['date']}. Retrouvez les détails dans votre application KSP.`,
    ),
  })),
  template(
    'cleaning.agent_applied.agent',
    'short',
    { case: oneOf('self', 'admin_created', 'invited') },
    (v) => ({
      subject: v['case'] === 'self' ? 'Candidature reçue' : 'Votre compte agent KSP',
      text: lines(
        greeting(v),
        v['case'] === 'self'
          ? "Nous avons bien reçu votre candidature d'agent de nettoyage KSP. Nous vous préviendrons de la décision."
          : 'Votre profil d’agent de nettoyage KSP est créé. Il sera actif après sa validation.',
      ),
    }),
  ),
  template('cleaning.agent_approved.agent', 'short', {}, (v) => ({
    subject: 'Bienvenue chez KSP Nettoyage',
    text: lines(
      greeting(v),
      'Votre profil d’agent de nettoyage KSP est validé. Vos visites et séances apparaîtront dans votre application KSP.',
    ),
  })),

  // Personnel du back-office.
  staff('cleaning.request_submitted.staff', { request_number: NUMBER, place: TEXT }, (v) => ({
    subject: `Nouvelle demande ${v['request_number']} à traiter`,
    text: `Nouvelle demande ${v['request_number']} (${v['place']}), frais de visite réglés : visite à planifier.`,
  })),
  staff('cleaning.visit_fee_paid.staff', { request_number: NUMBER, rank: COUNT }, (v) => ({
    subject: `Frais de visite réglés — ${v['request_number']}`,
    text:
      v['rank'] === '1'
        ? `Les frais de visite de la demande ${v['request_number']} sont réglés : visite à planifier.`
        : `Les nouveaux frais de visite de la demande ${v['request_number']} (n° ${v['rank']}) sont réglés : nouvelle visite à planifier.`,
  })),
  staff('cleaning.reactivation_requested.staff', { request_number: NUMBER }, (v) => ({
    subject: `Réactivation demandée — ${v['request_number']}`,
    text: `Le client demande la réactivation du devis expiré du dossier ${v['request_number']} : à accepter ou refuser.`,
  })),
  staff('cleaning.visit_missed.staff', { request_number: NUMBER, date: TEXT }, (v) => ({
    subject: `Client absent à la visite — ${v['request_number']}`,
    text: `Client absent à la visite du ${v['date']} (dossier ${v['request_number']}) : de nouveaux frais de visite lui sont demandés.`,
  })),
  staff('cleaning.quote_accepted.staff', { request_number: NUMBER }, (v) => ({
    subject: `Devis accepté — ${v['request_number']}`,
    text: `Le devis du dossier ${v['request_number']} est accepté : programme à planifier.`,
  })),
  staff('cleaning.quote_declined.staff', { request_number: NUMBER, reason: TEXT }, (v) => ({
    subject: `Devis refusé — ${v['request_number']}`,
    text: `Le client a refusé le devis du dossier ${v['request_number']} (motif : ${v['reason']}). Le dossier est clos.`,
  })),
  staff('cleaning.quote_expired.staff', { request_number: NUMBER }, (v) => ({
    subject: `Devis expiré — ${v['request_number']}`,
    text: `Le devis du dossier ${v['request_number']} a expiré sans réponse du client.`,
  })),
  staff('cleaning.program_suspended.staff', { causes: TEXT }, (v) => ({
    subject: 'Programme de nettoyage suspendu',
    text: `Un programme de nettoyage est suspendu (${v['causes']}) : ses séances à venir sont gelées et ses agents libérés.`,
  })),
  staff(
    'cleaning.program_suspension_updated.staff',
    { case: oneOf('cause_added', 'cause_lifted'), causes: TEXT },
    (v) => ({
      subject: 'Décision de KSP sur un programme suspendu',
      text:
        v['case'] === 'cause_added'
          ? `Une suspension décidée par KSP s'ajoute à un programme déjà suspendu. Causes en cours : ${v['causes']}.`
          : `La suspension décidée par KSP est levée, mais le programme reste suspendu. Causes en cours : ${v['causes']}.`,
    }),
  ),
  staff(
    'cleaning.program_resumed.staff',
    { cause: TEXT, sessions_to_assign: INTEGER, catch_up: INTEGER },
    (v) => ({
      subject: 'Programme de nettoyage repris',
      text:
        `Un programme de nettoyage reprend (cause levée : ${v['cause']}) : ` +
        `${plural(v['sessions_to_assign'], 'séance', 'séances')} à affecter, ` +
        `${plural(v['catch_up'], 'séance', 'séances')} à rattraper.`,
    }),
  ),
  staff('cleaning.unpaid_warning.staff', { unpaid_count: COUNT, suspension_threshold: COUNT }, (v) => ({
    subject: 'Organisation avertie pour impayés',
    text:
      `Une organisation cliente a ${plural(v['unpaid_count'], 'facture impayée', 'factures impayées')} ` +
      `et vient d'être avertie ; ses programmes seront suspendus à ${v['suspension_threshold']}.`,
  })),
  staff('cleaning.session_overdue.staff', { session: SESSION, overdue_count: COUNT }, (v) => ({
    subject: 'Séance en retard de paiement',
    text: `La ${v['session']} est en retard de paiement (${plural(v['overdue_count'], 'séance', 'séances')} en retard sur ce programme).`,
  })),
  staff('cleaning.session_interrupted.staff', { session: SESSION, category: TEXT }, (v) => ({
    subject: 'Incident sur une séance',
    text: `La ${v['session']} est interrompue par un incident (${v['category']}) : décision à prendre.`,
  })),
  staff('cleaning.session_missed.staff', { session: SESSION, cause: TEXT }, (v) => ({
    subject: 'Séance manquée',
    text: `La ${v['session']} est manquée (${v['cause']}).`,
  })),
  staff(
    'cleaning.staffing_alert.staff',
    {
      case: oneOf('unassigned_48h', 'unassigned_at_start', 'agent_absent'),
      program_number: NUMBER,
      session: SESSION,
      date: TEXT,
      missing: INTEGER,
    },
    (v) => ({
      subject: `${STAFFING_SUBJECTS[v['case']] ?? 'Séance à couvrir'} — ${v['program_number']}`,
      text: lines(
        `${STAFFING_TEXTS[v['case']] ?? 'Séance à couvrir'} : ${v['session']}, le ${v['date']}.`,
        v['missing'] === '0'
          ? ''
          : v['missing'] === '1'
            ? '1 agent manque.'
            : `${v['missing']} agents manquent.`,
      ),
    }),
  ),
  staff('cleaning.agent_applied.staff', {}, () => ({
    subject: "Nouvelle candidature d'agent",
    text: "Nouvelle candidature d'agent de nettoyage à examiner.",
  })),
  staff('cleaning.claim_opened.staff', { category: TEXT }, (v) => ({
    subject: 'Nouvelle réclamation',
    text: `Nouvelle réclamation sur une séance (${v['category']}) : première réponse attendue sous 24 h.`,
  })),
];

const STAFFING_SUBJECTS: Readonly<Record<string, string>> = {
  unassigned_48h: 'Séance sans équipe à 48 h',
  unassigned_at_start: 'Séance non couverte',
  agent_absent: 'Agent absent',
};

const STAFFING_TEXTS: Readonly<Record<string, string>> = {
  unassigned_48h: 'Séance toujours sans équipe complète à 48 h de son début',
  unassigned_at_start: "Séance encore à affecter à l'heure de son début",
  agent_absent: 'Séance non démarrée une heure après son début',
};

/** Message du personnel : salutation, texte, puis le lien du back-office s'il est connu. */
function staff(
  code: string,
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => { subject: string; text: string },
): EventTemplateDefinition {
  return template(
    code,
    'short',
    variables,
    (v) => {
      const message = render(v);
      return { subject: message.subject, text: lines(greeting(v), message.text, details(v)) };
    },
    { link: LINK },
  );
}
