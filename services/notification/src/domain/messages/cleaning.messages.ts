import { type EventTemplateDefinition, type RenderedMessage } from '../template';
import { formatXof } from './format';

/**
 * Messages du Nettoyage (cahier des charges Nettoyage, partie 6), en français. Les variables
 * arrivent déjà mises en forme (dates, montants) ; `first_name` est ajouté par le service à partir
 * du compte du destinataire (vide s'il n'a pas renseigné son nom).
 *
 * Nature du message (règle de choix du canal, voir channel.ts) :
 * - short : message court transactionnel → WhatsApp, e-mail en bascule ;
 * - document : devis, compte rendu → e-mail si l'adresse existe, WhatsApp sinon ou en bascule.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const TEXT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const COUNT = /^[1-9][0-9]{0,4}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

function passages(count: string): string {
  return count === '1' ? '1 passage' : `${count} passages`;
}

const CANCELLATION_SUBJECTS: Readonly<Record<string, string>> = {
  cancelled_by_customer: 'Annulation enregistrée',
  cancelled_by_supervisor: 'Prestation de nettoyage annulée',
  rejected: 'Demande de nettoyage non retenue',
  declined: 'Refus du devis enregistré',
};

function cancellationText(variables: Readonly<Record<string, string>>): string {
  const what = variables['scope'] === 'mission' ? 'votre prestation' : 'votre demande';
  switch (variables['case']) {
    case 'cancelled_by_customer':
      return `Votre annulation est bien enregistrée : ${what} de nettoyage est annulée.`;
    case 'cancelled_by_supervisor':
      return `KSP a dû annuler ${what} de nettoyage. Pour toute question, contactez le service client KSP.`;
    case 'rejected':
      return 'Nous ne sommes malheureusement pas en mesure de donner suite à votre demande de nettoyage.';
    default:
      return 'Nous avons bien noté votre refus du devis. Vous pouvez faire une nouvelle demande à tout moment.';
  }
}

function template(
  code: string,
  kind: EventTemplateDefinition['kind'],
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
): EventTemplateDefinition {
  return { code, channels: ['whatsapp', 'email'], secret: false, kind, variables, render };
}

export const CLEANING_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'cleaning.quote_requested.customer',
    'short',
    { first_name: FIRST_NAME, visit_required: /^(true|false)$/, link: LINK },
    (v) => ({
      subject: 'Demande de devis reçue',
      text: lines(
        greeting(v),
        'Nous avons bien reçu votre demande de devis de nettoyage. ' +
          (v['visit_required'] === 'true'
            ? "Un superviseur vous contactera pour convenir d'une visite des lieux avant d'établir le devis."
            : "Un superviseur l'étudie et vous enverra votre devis."),
        `Suivez-la dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.visit_scheduled.customer',
    'short',
    { first_name: FIRST_NAME, date: TEXT, link: LINK },
    (v) => ({
      subject: 'Visite des lieux planifiée',
      text: lines(
        greeting(v),
        `La visite des lieux pour votre demande de nettoyage est prévue le ${v['date']}. ` +
          "Un agent KSP se présentera à l'adresse indiquée dans votre demande.",
        `Détails : ${v['link']}`,
      ),
    }),
  ),
  template('cleaning.visit_scheduled.agent', 'short', { first_name: FIRST_NAME, date: TEXT }, (v) => ({
    subject: 'Nouvelle visite technique',
    text: lines(
      greeting(v),
      `Une visite technique vous est confiée le ${v['date']}. ` +
        "Retrouvez l'adresse et les détails dans votre espace KSP.",
    ),
  })),
  template(
    'cleaning.quote_sent.customer',
    'document',
    { first_name: FIRST_NAME, total: AMOUNT, valid_until: TEXT, link: LINK },
    (v) => ({
      subject: 'Votre devis de nettoyage',
      text: lines(
        greeting(v),
        `Votre devis de nettoyage est prêt : ${v['total']}, valable jusqu'au ${v['valid_until']}.`,
        `Consultez-le, puis acceptez-le ou refusez-le dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.booking_confirmed.customer',
    'short',
    {
      first_name: FIRST_NAME,
      total: AMOUNT,
      planned_interventions: COUNT,
      payment_note: TEXT,
      link: LINK,
    },
    (v) => ({
      subject: 'Réservation de nettoyage confirmée',
      text: lines(
        greeting(v),
        `Merci, votre réservation est confirmée : ${passages(v['planned_interventions'])} pour ${v['total']}.`,
        v['payment_note'],
        `Nous vous préviendrons dès que la date d'intervention sera fixée. Suivi : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.mission_scheduled.customer',
    'short',
    { first_name: FIRST_NAME, date: TEXT, duration: TEXT, link: LINK },
    (v) => ({
      subject: 'Intervention de nettoyage planifiée',
      text: lines(
        greeting(v),
        `Votre intervention de nettoyage est planifiée le ${v['date']} (durée prévue : ${v['duration']}). ` +
          "Notre équipe se présentera à l'adresse convenue.",
        `Suivi : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.mission_scheduled.agent',
    'short',
    { first_name: FIRST_NAME, date: TEXT, duration: TEXT },
    (v) => ({
      subject: 'Nouvelle intervention de nettoyage',
      text: lines(
        greeting(v),
        `Une intervention de nettoyage vous est confiée le ${v['date']} (durée prévue : ${v['duration']}). ` +
          'Retrouvez les détails dans votre espace KSP.',
      ),
    }),
  ),
  template(
    'cleaning.mission_completed.customer',
    'document',
    { first_name: FIRST_NAME, completed_interventions: COUNT, completed_on: TEXT, link: LINK },
    (v) => ({
      subject: 'Prestation de nettoyage terminée',
      text: lines(
        greeting(v),
        `Votre prestation de nettoyage est terminée : ${passages(v['completed_interventions'])} ` +
          `réalisé${v['completed_interventions'] === '1' ? '' : 's'}, le dernier le ${v['completed_on']}. ` +
          'Merci de votre confiance.',
        `Le compte rendu est disponible dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.request_cancelled.customer',
    'short',
    {
      first_name: FIRST_NAME,
      case: /^(cancelled_by_customer|cancelled_by_supervisor|rejected|declined)$/,
      scope: /^(request|mission)$/,
      link: LINK,
    },
    (v) => ({
      subject: CANCELLATION_SUBJECTS[v['case']] ?? 'Demande de nettoyage',
      text: lines(greeting(v), cancellationText(v), `Détails : ${v['link']}`),
    }),
  ),
];

const PAYMENT_METHODS: Readonly<Record<string, string>> = {
  cash: 'en espèces',
  mobile_money_offline: 'par Mobile Money',
  mobile_money_online: 'par Mobile Money en ligne',
};

/** Phrase du mode de paiement choisi à l'acceptation du devis (cahier des charges, partie 9). */
export function paymentNote(plan: {
  option: string;
  timing: string;
  method: string;
  total: number;
  deposit: number;
}): string {
  const what =
    plan.option === 'deposit'
      ? `acompte de ${formatXof(plan.deposit)}`
      : `totalité (${formatXof(plan.total)})`;
  const when = plan.timing === 'before' ? "avant l'intervention" : "après l'intervention";
  return `Paiement choisi : ${what}, ${when}, ${PAYMENT_METHODS[plan.method] ?? 'selon le moyen convenu'}.`;
}
