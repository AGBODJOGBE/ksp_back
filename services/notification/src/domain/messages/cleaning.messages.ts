import { type EventTemplateDefinition, type RenderedMessage } from '../template';

/**
 * Messages du Nettoyage, en français. Les variables arrivent déjà mises en forme (dates, montants) ;
 * `first_name` est ajouté par le service à partir du compte du destinataire (vide s'il n'a pas
 * renseigné son nom).
 *
 * Refonte v2 (ADR-054) : seuls restent les messages des six événements v1 réécrits sur place
 * (demande annulée, visite planifiée ou annulée, devis envoyé, rappel avant l'expiration, devis
 * expiré). Les messages des demandes groupées, des missions, des passages, de la suspension et de la
 * reprise sont retirés avec la v1. Les messages de la v2 (lot G) sont dans cleaning-customer,
 * cleaning-sessions et cleaning-team.messages.ts.
 *
 * Nature du message (règle de choix du canal, voir channel.ts) :
 * - short : message court transactionnel → WhatsApp, e-mail en bascule ;
 * - document : devis → e-mail si l'adresse existe, WhatsApp sinon ou en bascule.
 *
 * Prestation (ADR-035 point 14) : un message cite sa prestation quand la règle en donne le nom
 * (`service_name`, facultatif) ; sans lui, l'ancien libellé. Les événements v2 n'en portent plus.
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const TEXT = /^[^\n]{1,300}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
const COUNT = /^[1-9][0-9]{0,4}$/;
const AMOUNT = /^[0-9\u00a0]{1,20}\u00a0FCFA$/;
const SERVICE_NAME = /^[^\n]{1,150}$/;
/** Liste d'objets cités (devis, dossier), sur une ligne. */
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
