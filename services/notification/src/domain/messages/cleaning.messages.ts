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
 *
 * Prestation (ADR-035 point 14) : les messages d'une demande citent sa prestation quand l'événement
 * en donne le nom (`service_name`, facultatif) ; sans lui, l'ancien libellé. Un envoi groupé, une
 * visite commune et un envoi groupé de devis ont chacun un seul message, qui liste les prestations.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const TEXT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const COUNT = /^[1-9][0-9]{0,4}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;
const COUNT_OR_ZERO = /^(0|[1-9][0-9]{0,4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_NAME = /^[^\n]{1,150}$/;
/** Liste des prestations d'un groupe (10 au plus), sur une ligne. */
const LIST = /^[^\n]{1,1000}$/;
/** Nom de la prestation, facultatif (absent des événements antérieurs à son ajout). */
const WITH_SERVICE = { service_name: SERVICE_NAME } as const;

/** Nom de la prestation entre guillemets, ou null sans nom. */
function service(variables: Readonly<Record<string, string>>): string | null {
  const name = variables['service_name']?.trim();
  return name ? `« ${name} »` : null;
}

/** Objet suivi du nom de la prestation quand il est connu. */
function titled(subject: string, variables: Readonly<Record<string, string>>): string {
  const name = variables['service_name']?.trim();
  return name ? `${subject} — ${name}` : subject;
}

/** « pour « Vitres » », ou le libellé d'avant sans nom de prestation. */
function forService(variables: Readonly<Record<string, string>>, fallback: string): string {
  const name = service(variables);
  return name ? `pour ${name}` : fallback;
}

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
  const name = service(variables);
  const scope = variables['scope'] === 'mission' ? 'votre prestation' : 'votre demande';
  const what = `${scope} ${name ?? 'de nettoyage'}`;
  switch (variables['case']) {
    case 'cancelled_by_customer':
      return `Votre annulation est bien enregistrée : ${what} est annulée.`;
    case 'cancelled_by_supervisor':
      return `KSP a dû annuler ${what}. Pour toute question, contactez le service client KSP.`;
    case 'rejected':
      return `Nous ne sommes malheureusement pas en mesure de donner suite à votre demande ${name ?? 'de nettoyage'}.`;
    default:
      return (
        `Nous avons bien noté votre refus du devis${name ? ` pour ${name}` : ''}. ` +
        'Vous pouvez faire une nouvelle demande à tout moment.'
      );
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
  optionalVariables?: Readonly<Record<string, RegExp>>,
): EventTemplateDefinition {
  return {
    code,
    channels: ['whatsapp', 'email'],
    secret: false,
    kind,
    variables,
    render,
    ...(optionalVariables ? { optionalVariables } : {}),
  };
}

export const CLEANING_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'cleaning.quote_requested.customer',
    'short',
    { first_name: FIRST_NAME, visit_required: /^(true|false)$/, link: LINK },
    (v) => ({
      subject: titled('Demande de devis reçue', v),
      text: lines(
        greeting(v),
        `Nous avons bien reçu votre demande de devis ${forService(v, 'de nettoyage')}. ` +
          (v['visit_required'] === 'true'
            ? "Un superviseur vous contactera pour convenir d'une visite des lieux avant d'établir le devis."
            : "Un superviseur l'étudie et vous enverra votre devis."),
        `Suivez-la dans Mon espace KSP : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  // Envoi groupé (ADR-035 point 14) : un message pour toutes les demandes créées ensemble.
  template(
    'cleaning.quote_group_requested.customer',
    'short',
    {
      first_name: FIRST_NAME,
      visit_required: /^(true|false)$/,
      request_count: COUNT,
      services: LIST,
      link: LINK,
    },
    (v) => ({
      subject: 'Demandes de devis reçues',
      text: lines(
        greeting(v),
        `Nous avons bien reçu vos ${v['request_count']} demandes de devis pour un même lieu : ${v['services']}. ` +
          (v['visit_required'] === 'true'
            ? "Un superviseur vous contactera pour convenir d'une visite des lieux commune avant d'établir vos devis."
            : 'Un superviseur les étudie et vous enverra vos devis.'),
        `Suivez-les dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.visit_scheduled.customer',
    'short',
    { first_name: FIRST_NAME, date: TEXT, link: LINK },
    (v) => ({
      subject: titled('Visite des lieux planifiée', v),
      text: lines(
        greeting(v),
        `La visite des lieux pour votre demande ${service(v) ?? 'de nettoyage'} est prévue le ${v['date']}. ` +
          "Un agent KSP se présentera à l'adresse indiquée dans votre demande.",
        `Détails : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.visit_scheduled.agent',
    'short',
    { first_name: FIRST_NAME, date: TEXT },
    (v) => ({
      subject: titled('Nouvelle visite technique', v),
      text: lines(
        greeting(v),
        `Une visite technique${service(v) ? ` pour ${service(v)}` : ''} vous est confiée le ${v['date']}. ` +
          "Retrouvez l'adresse et les détails dans votre espace KSP.",
      ),
    }),
    WITH_SERVICE,
  ),
  // Visite commune à plusieurs demandes d'un groupe (ADR-035 points 2 et 14) : un message.
  template(
    'cleaning.group_visit_scheduled.customer',
    'short',
    { first_name: FIRST_NAME, date: TEXT, services: LIST, link: LINK },
    (v) => ({
      subject: 'Visite des lieux planifiée',
      text: lines(
        greeting(v),
        `La visite des lieux commune à vos demandes ${v['services']} est prévue le ${v['date']}. ` +
          "Un agent KSP se présentera à l'adresse indiquée dans vos demandes.",
        `Détails : ${v['link']}`,
      ),
    }),
  ),
  template(
    'cleaning.group_visit_scheduled.agent',
    'short',
    { first_name: FIRST_NAME, date: TEXT, request_count: COUNT, services: LIST },
    (v) => ({
      subject: 'Nouvelle visite technique commune',
      text: lines(
        greeting(v),
        `Une visite technique commune à ${v['request_count']} demandes (${v['services']}) vous est confiée ` +
          `le ${v['date']}. Retrouvez l'adresse et les détails dans votre espace KSP.`,
      ),
    }),
  ),
  template(
    'cleaning.quote_sent.customer',
    'document',
    { first_name: FIRST_NAME, total: AMOUNT, valid_until: TEXT, link: LINK },
    (v) => ({
      subject: titled('Votre devis de nettoyage', v),
      text: lines(
        greeting(v),
        `Votre devis ${forService(v, 'de nettoyage')} est prêt : ${v['total']}, ` +
          `valable jusqu'au ${v['valid_until']}.`,
        `Consultez-le, puis acceptez-le ou refusez-le dans Mon espace KSP : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  // Devis d'un groupe envoyés ensemble (ADR-035 points 4 et 14) : un message, total et validité.
  template(
    'cleaning.quote_group_sent.customer',
    'document',
    {
      first_name: FIRST_NAME,
      quote_count: COUNT,
      quotes: LIST,
      total: AMOUNT,
      valid_until: TEXT,
      link: LINK,
    },
    (v) => ({
      subject: 'Vos devis de nettoyage',
      text: lines(
        greeting(v),
        `Vos ${v['quote_count']} devis de nettoyage sont prêts : ${v['quotes']}. ` +
          `Total : ${v['total']}, valables jusqu'au ${v['valid_until']}.`,
        `Consultez-les, puis acceptez-les ou refusez-les dans Mon espace KSP : ${v['link']}`,
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
      subject: titled('Réservation de nettoyage confirmée', v),
      text: lines(
        greeting(v),
        `Merci, votre réservation${service(v) ? ` pour ${service(v)}` : ''} est confirmée : ` +
          `${passages(v['planned_interventions'])} pour ${v['total']}.`,
        v['payment_note'],
        `Nous vous préviendrons dès que la date d'intervention sera fixée. Suivi : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.mission_scheduled.customer',
    'short',
    { first_name: FIRST_NAME, date: TEXT, duration: TEXT, link: LINK },
    (v) => ({
      subject: titled('Intervention de nettoyage planifiée', v),
      text: lines(
        greeting(v),
        `Votre intervention ${forService(v, 'de nettoyage')} est planifiée le ${v['date']} ` +
          `(durée prévue : ${v['duration']}). Notre équipe se présentera à l'adresse convenue.`,
        `Suivi : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.mission_scheduled.agent',
    'short',
    { first_name: FIRST_NAME, date: TEXT, duration: TEXT },
    (v) => ({
      subject: titled('Nouvelle intervention de nettoyage', v),
      text: lines(
        greeting(v),
        `Une intervention ${forService(v, 'de nettoyage')} vous est confiée le ${v['date']} ` +
          `(durée prévue : ${v['duration']}). Retrouvez les détails dans votre espace KSP.`,
      ),
    }),
    WITH_SERVICE,
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
      subject: titled(CANCELLATION_SUBJECTS[v['case']] ?? 'Demande de nettoyage', v),
      text: lines(greeting(v), cancellationText(v), `Détails : ${v['link']}`),
    }),
    WITH_SERVICE,
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
  // Compléments du Nettoyage (ADR-053).
  template(
    'cleaning.quote_expiry_reminder.customer',
    'short',
    { first_name: FIRST_NAME, quote_count: COUNT, quotes: LIST, valid_until: TEXT, link: LINK },
    (v) => {
      const one = v['quote_count'] === '1';
      return {
        subject: one ? 'Votre devis expire bientôt' : 'Vos devis expirent bientôt',
        text: lines(
          greeting(v),
          (one ? `Votre devis ${v['quotes']} reste valable` : `Vos devis ${v['quotes']} restent valables`) +
            ` jusqu'au ${v['valid_until']}.`,
          `Pour en profiter, ${one ? 'acceptez-le' : 'acceptez-les'} dans Mon espace KSP : ${v['link']}`,
        ),
      };
    },
  ),
  template(
    'cleaning.quote_expired.customer',
    'short',
    { first_name: FIRST_NAME, quote_count: COUNT, quotes: LIST, link: LINK },
    (v) => {
      const one = v['quote_count'] === '1';
      return {
        subject: one ? 'Votre devis a expiré' : 'Vos devis ont expiré',
        text: lines(
          greeting(v),
          (one ? `Votre devis ${v['quotes']} a expiré` : `Vos devis ${v['quotes']} ont expiré`) +
            ' sans réponse. Vous pouvez faire une nouvelle demande quand vous le souhaitez.',
          `Détails : ${v['link']}`,
        ),
      };
    },
  ),
  template(
    'cleaning.intervention_rescheduled.customer',
    'short',
    { first_name: FIRST_NAME, date: TEXT, previous_date: TEXT, duration: TEXT, link: LINK },
    (v) => ({
      subject: titled('Intervention de nettoyage reportée', v),
      text: lines(
        greeting(v),
        `Votre intervention ${forService(v, 'de nettoyage')} prévue le ${v['previous_date']} est reportée ` +
          `au ${v['date']} (durée prévue : ${v['duration']}).`,
        `Suivi : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.intervention_rescheduled.agent',
    'short',
    { first_name: FIRST_NAME, date: TEXT, previous_date: TEXT, duration: TEXT },
    (v) => ({
      subject: titled('Intervention de nettoyage reportée', v),
      text: lines(
        greeting(v),
        `L'intervention ${forService(v, 'de nettoyage')} prévue le ${v['previous_date']} est reportée au ` +
          `${v['date']} (durée prévue : ${v['duration']}) ; elle vous est confiée. ` +
          'Retrouvez les détails dans votre espace KSP.',
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.intervention_released.agent',
    'short',
    { first_name: FIRST_NAME, previous_date: TEXT },
    (v) => ({
      subject: titled('Intervention de nettoyage retirée', v),
      text: lines(
        greeting(v),
        `L'intervention ${forService(v, 'de nettoyage')} prévue le ${v['previous_date']} ne vous est plus confiée.`,
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.intervention_unscheduled.customer',
    'short',
    { first_name: FIRST_NAME, previous_date: TEXT, link: LINK },
    (v) => ({
      subject: titled('Intervention de nettoyage à replanifier', v),
      text: lines(
        greeting(v),
        `Votre intervention ${forService(v, 'de nettoyage')} prévue le ${v['previous_date']} est annulée et sera ` +
          'replanifiée : nous vous communiquerons la nouvelle date. Votre prestation et son prix ne changent pas.',
        `Suivi : ${v['link']}`,
      ),
    }),
    WITH_SERVICE,
  ),
  template(
    'cleaning.visit_cancelled.agent',
    'short',
    { first_name: FIRST_NAME, date: TEXT, services: LIST },
    (v) => ({
      subject: 'Visite technique annulée',
      text: lines(
        greeting(v),
        `La visite technique prévue le ${v['date']} (${v['services']}) est annulée : la demande a été close. ` +
          "Vous n'avez pas à vous déplacer.",
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

/** Prestation citée dans une liste : son nom entre guillemets, ou un libellé neutre sans nom. */
export function quotedService(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `« ${trimmed} »` : 'une prestation de nettoyage';
}

/** « A », « A et B », « A, B et C ». */
export function enumeration(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

/** « 2 factures impayées » (entreprise) ou « 1 passage impayé » (particulier en récurrent). */
export function unpaidText(cause: string, count: number): string {
  const n = String(count);
  return cause === 'unpaid_interventions'
    ? counted(n, 'passage impayé', 'passages impayés')
    : counted(n, 'facture impayée', 'factures impayées');
}
