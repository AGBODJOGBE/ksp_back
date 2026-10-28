import { type EventTemplateDefinition, type RenderedMessage } from '../template';
import { formatXof } from './format';

/**
 * Messages du Nettoyage (cahier des charges Nettoyage, partie 6), en français. Les variables
 * arrivent déjà mises en forme (dates, montants) ; `first_name` est ajouté par le service à partir
 * du compte du destinataire (vide s'il n'a pas renseigné son nom).
 *
 * Nature du message (règle de choix du canal, voir channel.ts) :
 * - short : message court transactionnel → WhatsApp, e-mail en bascule ;
 * - document : devis, compte rendu → e-mail si l'adresse existe, WhatsApp sinon ou en bascule ;
 * - important : avertissement et suspension pour impayés → WhatsApp et e-mail.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const TEXT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const COUNT = /^[1-9][0-9]{0,4}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;
const COUNT_OR_ZERO = /^(0|[1-9][0-9]{0,4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

/** « 1 passage », « 3 passages ». */
function counted(count: string, singular: string, plural: string): string {
  return count === '1' ? `1 ${singular}` : `${count} ${plural}`;
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

const SUSPENSION_UPDATE_CASE = /^(unpaid_added|organization_added|unpaid_lifted|organization_lifted)$/;

const SUSPENSION_UPDATE_SUBJECTS: Readonly<Record<string, string>> = {
  unpaid_added: 'Factures impayées : suspension maintenue',
  organization_added: 'Compte entreprise suspendu : suspension maintenue',
  unpaid_lifted: 'Règlement reçu : suspension maintenue',
  organization_lifted: 'Compte entreprise réactivé : suspension maintenue',
};

/** Ce qui change, et ce qui maintient la suspension de la prestation. */
function suspensionUpdateText(variables: Readonly<Record<string, string>>): string {
  const unpaid = variables['unpaid_text'] ?? '';
  switch (variables['case']) {
    case 'unpaid_added':
      return (
        `Votre contrat de nettoyage compte ${unpaid}, le seuil de suspension est atteint : ` +
        'même après la réactivation de votre compte entreprise, la prestation restera suspendue ' +
        "jusqu'à votre règlement."
      );
    case 'organization_added':
      return (
        'KSP a suspendu votre compte entreprise : même après le règlement de vos factures, ' +
        "votre prestation de nettoyage restera suspendue jusqu'à sa réactivation."
      );
    case 'unpaid_lifted':
      return (
        'Merci pour votre règlement. Votre prestation de nettoyage reste toutefois suspendue ' +
        'tant que votre compte entreprise est suspendu par KSP.'
      );
    default:
      return (
        'Votre compte entreprise est réactivé, mais la suspension de votre prestation de nettoyage ' +
        `est maintenue : ${unpaid}. Elle reprendra après votre règlement.`
      );
  }
}

/** Reprise d'une prestation suspendue : motif, passages reprogrammés et passages à replanifier. */
function resumedText(variables: Readonly<Record<string, string>>, opening: string): string {
  const rescheduled = variables['rescheduled_count'] ?? '0';
  const failed = variables['failed_count'] ?? '0';
  return lines(
    greeting(variables),
    opening,
    ...(rescheduled !== '0'
      ? [`${counted(rescheduled, 'passage reprogrammé', 'passages reprogrammés')}.`]
      : []),
    ...(failed !== '0'
      ? [
          `Un superviseur vous contactera pour replanifier ${
            failed === '1' ? 'le passage restant' : `les ${failed} passages restants`
          }.`,
        ]
      : []),
    `Suivi : ${variables['link']}`,
  );
}

/** Reprise annoncée à l'équipe Nettoyage : motif, puis passages reprogrammés et à replanifier. */
function teamResumedText(variables: Readonly<Record<string, string>>, reason: string): string {
  const failed = variables['failed_count'] ?? '0';
  return (
    `La mission ${variables['mission_id']} ${reason} : ` +
    `${counted(variables['rescheduled_count'] ?? '0', 'passage reprogrammé', 'passages reprogrammés')}` +
    (failed !== '0'
      ? `, ${counted(failed, 'passage', 'passages')} à replanifier à la main au back-office.`
      : '.')
  );
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
  // Impayés, suspension et reprise (cahier des charges Nettoyage, partie 10).
  template(
    'cleaning.suspension_warning.customer',
    'important',
    { first_name: FIRST_NAME, unpaid_text: TEXT, threshold: COUNT, link: LINK },
    (v) => ({
      subject: 'Factures impayées : risque de suspension',
      text: lines(
        greeting(v),
        `Votre contrat de nettoyage compte ${v['unpaid_text']}. Au seuil de ${v['threshold']} impayés, ` +
          'le service sera suspendu et les passages à venir annulés.',
        `Réglez vos factures dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.contract_suspended.customer',
    'important',
    { first_name: FIRST_NAME, unpaid_text: TEXT, link: LINK },
    (v) => ({
      subject: 'Prestation de nettoyage suspendue',
      text: lines(
        greeting(v),
        `Votre prestation de nettoyage est suspendue : ${v['unpaid_text']}, le seuil de suspension est atteint. ` +
          'Les passages à venir sont annulés.',
        'Après votre règlement, le service reprendra et vos passages seront reprogrammés, ' +
          'sauf si une autre cause de suspension reste en cours (nous vous en informerons).',
        `Réglez dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  // Organisation cliente suspendue par KSP (ADR-030) : rien à régler, le service reprend à la
  // réactivation du compte entreprise.
  template(
    'cleaning.contract_suspended_organization.customer',
    'important',
    { first_name: FIRST_NAME, link: LINK },
    (v) => ({
      subject: 'Prestation de nettoyage suspendue',
      text: lines(
        greeting(v),
        'Votre prestation de nettoyage est suspendue : KSP a suspendu votre compte entreprise. ' +
          'Les passages à venir sont annulés.',
        'Après la réactivation de votre compte entreprise, le service reprendra et vos passages seront ' +
          'reprogrammés, sauf si une autre cause de suspension reste en cours (nous vous en informerons).',
        `Suivi : ${v['link']}`,
      ),
    }),
  ),
  // Une cause s'ajoute à la suspension en cours, ou est levée alors qu'une autre la maintient
  // (ADR-030). `case` : unpaid_added, organization_added, unpaid_lifted, organization_lifted.
  template(
    'cleaning.suspension_updated.customer',
    'important',
    { first_name: FIRST_NAME, case: SUSPENSION_UPDATE_CASE, unpaid_text: TEXT, link: LINK },
    (v) => ({
      subject: SUSPENSION_UPDATE_SUBJECTS[v['case']] ?? 'Prestation de nettoyage toujours suspendue',
      text: lines(greeting(v), suspensionUpdateText(v), `Mon espace KSP : ${v['link']}`),
    }),
  ),
  template('cleaning.contract_suspended.agent', 'short', { first_name: FIRST_NAME }, (v) => ({
    subject: 'Passages de nettoyage annulés',
    text: lines(
      greeting(v),
      'Des passages de nettoyage qui vous étaient confiés sont annulés : le contrat du client est suspendu. ' +
        'Consultez votre planning dans votre espace KSP.',
    ),
  })),
  template(
    'cleaning.contract_resumed.customer',
    'short',
    { first_name: FIRST_NAME, rescheduled_count: COUNT_OR_ZERO, failed_count: COUNT_OR_ZERO, link: LINK },
    (v) => ({
      subject: 'Prestation de nettoyage reprise',
      text: resumedText(v, 'Merci pour votre règlement : votre prestation de nettoyage reprend.'),
    }),
  ),
  // Reprise à la réactivation du compte entreprise par KSP (ADR-030).
  template(
    'cleaning.contract_resumed_organization.customer',
    'short',
    { first_name: FIRST_NAME, rescheduled_count: COUNT_OR_ZERO, failed_count: COUNT_OR_ZERO, link: LINK },
    (v) => ({
      subject: 'Prestation de nettoyage reprise',
      text: resumedText(v, 'Votre compte entreprise est réactivé : votre prestation de nettoyage reprend.'),
    }),
  ),
  template(
    'cleaning.contract_resumed.team',
    'short',
    {
      first_name: FIRST_NAME,
      mission_id: UUID,
      rescheduled_count: COUNT_OR_ZERO,
      failed_count: COUNT_OR_ZERO,
    },
    (v) => ({
      subject: 'Prestation de nettoyage reprise après règlement',
      text: lines(greeting(v), teamResumedText(v, 'a repris après règlement des impayés')),
    }),
  ),
  template(
    'cleaning.contract_resumed_organization.team',
    'short',
    {
      first_name: FIRST_NAME,
      mission_id: UUID,
      rescheduled_count: COUNT_OR_ZERO,
      failed_count: COUNT_OR_ZERO,
    },
    (v) => ({
      subject: 'Prestation de nettoyage reprise après réactivation du compte entreprise',
      text: lines(
        greeting(v),
        teamResumedText(v, 'a repris après la réactivation du compte entreprise par KSP'),
      ),
    }),
  ),
  template(
    'cleaning.rescheduling_failed.team',
    'short',
    { first_name: FIRST_NAME, mission_id: UUID, failed_count: COUNT },
    (v) => ({
      subject: 'Passages de nettoyage à replanifier',
      text: lines(
        greeting(v),
        `Reprogrammation incomplète pour la mission ${v['mission_id']} : ` +
          `${counted(v['failed_count'], 'passage', 'passages')} à replanifier à la main au back-office, ` +
          "faute d'agents libres.",
      ),
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

/** « 2 factures impayées » (entreprise) ou « 1 passage impayé » (particulier en récurrent). */
export function unpaidText(cause: string, count: number): string {
  const n = String(count);
  return cause === 'unpaid_interventions'
    ? counted(n, 'passage impayé', 'passages impayés')
    : counted(n, 'facture impayée', 'factures impayées');
}
