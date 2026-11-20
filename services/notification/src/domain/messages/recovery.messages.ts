import {
  type EventTemplateDefinition,
  type MessageKind,
  type RenderedMessage,
  type TemplateDefinition,
} from '../template';

/**
 * Messages du recouvrement (CDC Recouvrement, partie 17.2 ; ADR-060 et ADR-061), en français.
 *
 * Deux familles :
 * - messages des événements `recovery.*` (`RECOVERY_TEMPLATES`) : au créancier (`.customer`, compte
 *   ou administrateurs de son organisation), au chargé (`.agent`), au partenaire (`.partner`) et
 *   aux équipes KSP (`.team` : superviseurs, juristes). Les variables arrivent mises en forme
 *   (montants en FCFA entiers, dates en toutes lettres) ; `first_name` est ajouté par le service ;
 * - messages au débiteur (`RECOVERY_DIRECT_TEMPLATES`) : envoyés par appel direct de recovery
 *   (SendNotification), jamais par un événement, car le débiteur n'a pas de compte et ses
 *   coordonnées ne sortent pas de recovery (ADR-061). Tous secrets : ils portent un code ou un lien
 *   personnel, ni le texte ni les variables ne sont conservés ni journalisés. Les plages de contact
 *   (8 h – 19 h, lundi – samedi) et le rythme des relances sont tenus par recovery.
 *
 * Ton (R-DB-02, partie 17.2) : courtois, factuel, sans menace ni pression ; chaque message au
 * débiteur dit qui écrit, pour le compte de qui, et comment contester. Textes juridiques à faire
 * relire par l'avocat avant la production (mentions sur les données personnelles comprises).
 */

const FIRST_NAME = /^[^\n]{0,100}$/;
const OPTIONAL_FIRST_NAME = /^[^\n]{1,100}$/;
const CASE_NUMBER = /^RC-[0-9]{6,}$/;
const AMOUNT = /^-?[0-9\u00a0]{1,20}\u00a0FCFA$/;
const TEXT = /^[^\n]{1,300}$/;
const COUNT = /^[1-9][0-9]{0,3}$/;
const LINK = /^https?:\/\/\S{1,300}$/;
/** Lien personnel du débiteur : il porte un jeton (ADR-061). */
const PERSONAL_LINK = /^https?:\/\/\S{1,500}$/;
const CODE = /^[0-9]{6}$/;
const MINUTES = /^[1-9][0-9]{0,3}$/;
/** Nom du créancier affiché au débiteur (R-DB-01 : son nom seulement). */
const CREDITOR_NAME = /^[^\n]{1,200}$/;
/** Raison sociale de l'organisation créancière ; vide pour un particulier ou une fiche inconnue. */
const ORGANIZATION_NAME = /^[^\n]{0,200}$/;

function greeting(variables: Readonly<Record<string, string>>): string {
  const name = variables['first_name']?.trim();
  return name ? `Bonjour ${name},` : 'Bonjour,';
}

/** Débiteur : formule de politesse, avec son nom quand recovery le donne. */
function politeGreeting(variables: Readonly<Record<string, string>>): string {
  return `Bonjour ${variables['first_name']?.trim() || 'Madame, Monsieur'},`;
}

/** Objet de l'e-mail, suivi de la raison sociale quand le créancier est une organisation. */
function subject(text: string, variables: Readonly<Record<string, string>>): string {
  const organization = variables['organization_name']?.trim();
  return organization ? `${text} — ${organization}` : text;
}

function lines(...parts: string[]): string {
  return parts.join('\n');
}

/** Message au créancier : `organization_name` et `link` toujours présents. */
function creditor(
  code: string,
  kind: MessageKind,
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
  optionalVariables?: Readonly<Record<string, RegExp>>,
): EventTemplateDefinition {
  return {
    code,
    channels: ['whatsapp', 'email'],
    secret: false,
    kind,
    variables: {
      first_name: FIRST_NAME,
      organization_name: ORGANIZATION_NAME,
      case_number: CASE_NUMBER,
      link: LINK,
      ...variables,
    },
    ...(optionalVariables ? { optionalVariables } : {}),
    render,
  };
}

/** Message au personnel KSP ou au partenaire : court, toujours envoyé (hors préférences). */
function staff(
  code: string,
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
): EventTemplateDefinition {
  return {
    code,
    channels: ['whatsapp', 'email'],
    secret: false,
    kind: 'short',
    variables: { first_name: FIRST_NAME, case_number: CASE_NUMBER, ...variables },
    render,
  };
}

/** Rappel « suivez votre dossier » des messages au créancier. */
function follow(variables: Readonly<Record<string, string>>): string {
  return `Suivez le dossier dans Mon espace KSP, rubrique « Recouvrement » : ${variables['link']}`;
}

export const RECOVERY_TEMPLATES: readonly EventTemplateDefinition[] = [
  creditor('recovery.case_submitted.customer', 'short', { amount_due: AMOUNT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} reçu`, v),
    text: lines(
      greeting(v),
      `Votre dossier de recouvrement ${v['case_number']} est bien reçu (montant confié : ` +
        `${v['amount_due']}).`,
      "KSP examine sa recevabilité ; aucune démarche n'est faite auprès du débiteur avant cette " +
        'décision, dont vous serez prévenu.',
      follow(v),
    ),
  })),
  creditor('recovery.case_accepted.customer', 'short', {}, (v) => ({
    subject: subject(`Dossier ${v['case_number']} recevable`, v),
    text: lines(
      greeting(v),
      `Votre dossier ${v['case_number']} est recevable : un chargé de recouvrement le prend en ` +
        'charge et informe le débiteur que KSP agit pour votre compte.',
      "Nous cherchons d'abord un règlement amiable ; toute étape payante vous sera soumise avant de commencer.",
      follow(v),
    ),
  })),
  creditor('recovery.case_info_requested.customer', 'important', { due_on: TEXT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} : complément demandé`, v),
    text: lines(
      greeting(v),
      `Pour examiner votre dossier ${v['case_number']}, KSP a besoin d'un complément (pièce ou ` +
        'information) : le détail est indiqué sur le dossier.',
      `Merci de le fournir avant le ${v['due_on']} ; sans réponse à cette date, le dossier sera classé.`,
      `Compléter le dossier : ${v['link']}`,
    ),
  })),
  creditor(
    'recovery.case_rejected.customer',
    'document',
    { reason: TEXT },
    (v) => ({
      subject: subject(`Dossier ${v['case_number']} non retenu`, v),
      text: lines(
        greeting(v),
        `Votre dossier ${v['case_number']} n'est pas retenu : ${v['reason']}.`,
        v['refunded']
          ? `Vos frais de dossier vous sont remboursés sur votre portefeuille KSP, moins le forfait ` +
              `d'étude : ${v['refunded']}.`
          : "Les frais de dossier réglés couvrent l'étude du dossier ; aucun autre montant ne vous sera " +
              'demandé.',
        `Détail : ${v['link']}`,
      ),
    }),
    { refunded: AMOUNT },
  ),
  creditor(
    'recovery.decision_requested.customer',
    'important',
    { decision: TEXT, expires_on: TEXT, without_answer: TEXT },
    (v) => ({
      subject: subject(`Dossier ${v['case_number']} : votre décision est attendue`, v),
      text: lines(
        greeting(v),
        `Une décision vous est demandée sur le dossier ${v['case_number']} : ${v['decision']}.`,
        `Merci de répondre avant le ${v['expires_on']} ; sans réponse, ${v['without_answer']}.`,
        `Répondre en un clic dans Mon espace KSP, rubrique « Décisions à prendre » : ${v['link']}`,
      ),
    }),
  ),
  creditor(
    'recovery.plan_signed.customer',
    'short',
    { total: AMOUNT, installments: COUNT, first_due_on: TEXT },
    (v) => ({
      subject: subject(`Dossier ${v['case_number']} : échéancier signé`, v),
      text: lines(
        greeting(v),
        `Le débiteur a signé un échéancier sur le dossier ${v['case_number']} : ${v['total']} en ` +
          `${v['installments'] === '1' ? '1 échéance' : `${v['installments']} échéances`}, la première le ` +
          `${v['first_due_on']}.`,
        'Cette signature vaut reconnaissance de dette. Chaque paiement reçu vous est reversé, net de la commission.',
        follow(v),
      ),
    }),
  ),
  creditor(
    'recovery.installment_missed.customer',
    'short',
    { rank: COUNT, amount: AMOUNT, due_on: TEXT },
    (v) => ({
      subject: subject(`Dossier ${v['case_number']} : échéance non payée`, v),
      text: lines(
        greeting(v),
        `L'échéance n° ${v['rank']} de ${v['amount']}, prévue le ${v['due_on']}, n'a pas été payée ` +
          `sur le dossier ${v['case_number']}.`,
        'Votre chargé de recouvrement relance le débiteur.',
        follow(v),
      ),
    }),
  ),
  creditor('recovery.plan_defaulted.customer', 'short', { missed: COUNT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} : échéancier rompu`, v),
    text: lines(
      greeting(v),
      `L'échéancier du dossier ${v['case_number']} est rompu (` +
        `${v['missed'] === '1' ? '1 échéance non payée' : `${v['missed']} échéances non payées`}).`,
      'Le dossier passe en relance amiable ; les étapes suivantes vous seront proposées si elle échoue.',
      follow(v),
    ),
  })),
  creditor(
    'recovery.payment_collected.customer',
    'short',
    { amount: AMOUNT, amount_due_after: AMOUNT },
    (v) => ({
      subject: subject(`Dossier ${v['case_number']} : paiement reçu`, v),
      text: lines(
        greeting(v),
        `KSP a reçu ${v['amount']} du débiteur sur le dossier ${v['case_number']}. Reste dû : ` +
          `${v['amount_due_after']}.`,
        'Le montant net de la commission est crédité sur votre portefeuille KSP.',
        follow(v),
      ),
    }),
  ),
  creditor(
    'recovery.direct_payment_recorded.customer',
    'short',
    { amount: AMOUNT, commission: AMOUNT, amount_due_after: AMOUNT },
    (v) => ({
      subject: subject(`Dossier ${v['case_number']} : paiement direct enregistré`, v),
      text: lines(
        greeting(v),
        `Le paiement de ${v['amount']} que vous avez reçu directement du débiteur est enregistré sur ` +
          `le dossier ${v['case_number']}. Reste dû : ${v['amount_due_after']}.`,
        `La commission correspondante (${v['commission']}) vous sera facturée, comme prévu au mandat.`,
        follow(v),
      ),
    }),
  ),
  creditor(
    'recovery.remittance_paid.customer',
    'short',
    { gross: AMOUNT, commission: AMOUNT, net: AMOUNT },
    (v) => ({
      subject: subject(`Reversement de ${v['net']} — dossier ${v['case_number']}`, v),
      text: lines(
        greeting(v),
        `${v['net']} sont crédités sur votre portefeuille KSP pour le dossier ${v['case_number']} ` +
          `(encaissé ${v['gross']}, commission ${v['commission']}).`,
        `Retirez-les quand vous le souhaitez depuis votre portefeuille : ${v['link']}`,
      ),
    }),
  ),
  creditor('recovery.notice_issued.customer', 'document', { deadline_days: COUNT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} : mise en demeure envoyée`, v),
    text: lines(
      greeting(v),
      `Une mise en demeure a été adressée au débiteur pour le dossier ${v['case_number']}. Il dispose ` +
        `de ${v['deadline_days']} jours pour régler.`,
      'Une copie est disponible sur le dossier. Sans règlement, le passage à un huissier vous sera proposé.',
      follow(v),
    ),
  })),
  creditor('recovery.partner_assigned.customer', 'short', { partner: TEXT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} confié à ${v['partner']}`, v),
    text: lines(
      greeting(v),
      `Le dossier ${v['case_number']} est confié à ${v['partner']}, comme vous l'avez accepté.`,
      'Chacun de ses actes vous sera signalé.',
      follow(v),
    ),
  })),
  creditor('recovery.act_recorded.customer', 'short', { act: TEXT, act_on: TEXT, cost: AMOUNT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} : ${v['act']}`, v),
    text: lines(
      greeting(v),
      `Nouvel acte sur le dossier ${v['case_number']} : ${v['act']}, le ${v['act_on']} ` +
        `(coût : ${v['cost']}).`,
      follow(v),
    ),
  })),
  creditor('recovery.case_suspended.customer', 'important', { answer_due_on: TEXT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} : contestation du débiteur`, v),
    text: lines(
      greeting(v),
      `Le débiteur conteste le dossier ${v['case_number']} : la procédure est suspendue le temps de ` +
        "l'examen.",
      `Merci de répondre avec vos pièces avant le ${v['answer_due_on']} ; le juriste de KSP décidera ` +
        'ensuite de la suite.',
      `Répondre : ${v['link']}`,
    ),
  })),
  creditor('recovery.case_resumed.customer', 'short', { resolution: TEXT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} : la procédure reprend`, v),
    text: lines(greeting(v), `Dossier ${v['case_number']} : ${v['resolution']}.`, follow(v)),
  })),
  creditor('recovery.case_closed.customer', 'document', { reason: TEXT, total_collected: AMOUNT }, (v) => ({
    subject: subject(`Dossier ${v['case_number']} clôturé`, v),
    text: lines(
      greeting(v),
      `Le dossier ${v['case_number']} est clôturé : ${v['reason']}. Total recouvré : ` +
        `${v['total_collected']}.`,
      'Le bilan et le relevé du dossier sont disponibles dans Mon espace KSP.',
      `Détail : ${v['link']}`,
    ),
  })),

  // Personnel KSP et partenaires.
  staff('recovery.case_submitted.team', { kind: TEXT, amount_due: AMOUNT }, (v) => ({
    subject: `Nouveau dossier ${v['case_number']} à examiner`,
    text: lines(
      greeting(v),
      `Un nouveau dossier de recouvrement attend l'examen de recevabilité : ${v['case_number']} ` +
        `(${v['kind']}, ${v['amount_due']}).`,
      'Ouvrez la file « Recevabilité » du back-office KSP.',
    ),
  })),
  staff('recovery.case_assigned.agent', {}, (v) => ({
    subject: `Dossier ${v['case_number']} affecté`,
    text: lines(
      greeting(v),
      `Le dossier ${v['case_number']} vous est affecté : le débiteur va recevoir la notification du ` +
        'mandat.',
      'Retrouvez-le dans « Ma journée » du back-office KSP.',
    ),
  })),
  staff('recovery.dispute_opened.team', { answer_due_on: TEXT }, (v) => ({
    subject: `Contestation sur le dossier ${v['case_number']}`,
    text: lines(
      greeting(v),
      `Le débiteur conteste le dossier ${v['case_number']}, suspendu jusqu'à votre décision. Le ` +
        `créancier peut répondre jusqu'au ${v['answer_due_on']}.`,
      'Examinez la contestation dans le back-office KSP.',
    ),
  })),
  staff('recovery.act_recorded.team', { act: TEXT, act_on: TEXT }, (v) => ({
    subject: `Dossier ${v['case_number']} : ${v['act']}`,
    text: lines(
      greeting(v),
      `Le partenaire a enregistré un acte sur le dossier ${v['case_number']} : ${v['act']}, le ` +
        `${v['act_on']}.`,
    ),
  })),
  staff('recovery.case_assigned.partner', { link: LINK }, (v) => ({
    subject: `Dossier ${v['case_number']} confié par KSP`,
    text: lines(
      greeting(v),
      `KSP vous confie le dossier de recouvrement ${v['case_number']}. Les pièces utiles à votre ` +
        'mission sont dans votre accès partenaire.',
      `Ouvrir le dossier : ${v['link']}`,
    ),
  })),
];

/** Message direct au débiteur : secret, WhatsApp puis e-mail, `first_name` facultatif. */
function debtor(
  code: string,
  variables: Readonly<Record<string, RegExp>>,
  render: (variables: Readonly<Record<string, string>>) => RenderedMessage,
): TemplateDefinition {
  return {
    code,
    channels: ['whatsapp', 'email'],
    secret: true,
    variables,
    optionalVariables: { first_name: OPTIONAL_FIRST_NAME },
    render,
  };
}

/** Rappel des droits du débiteur, dans chaque message qui porte son lien (R-DB-02). */
const CONTEST =
  'Si vous pensez ne rien devoir, ou que le montant est faux, vous pouvez le contester depuis ce lien.';

/**
 * Recours rappelé dans les messages qui suivent un accord du débiteur (échéance, paiement,
 * échéancier) : une question ou un désaccord passe toujours par son lien personnel.
 */
const QUESTIONS = 'Une question ou un désaccord ? Écrivez-nous depuis votre lien personnel.';

export const RECOVERY_DIRECT_TEMPLATES: readonly TemplateDefinition[] = [
  {
    // Code d'accès à l'espace du débiteur : WhatsApp par le modèle d'authentification « Copier le
    // code » (comme identity.otp), e-mail en repli (débiteur sans téléphone, ADR-061).
    code: 'recovery.debtor_access_code',
    channels: ['whatsapp', 'email'],
    secret: true,
    variables: { code: CODE, expires_in_minutes: MINUTES },
    render: (v) => ({
      // Le code n'est pas dans l'objet : l'objet s'affiche partout (aperçus, statistiques).
      subject: "Votre code d'accès KSP",
      text: lines(
        'Bonjour,',
        `Voici votre code pour ouvrir votre dossier : ${v['code']}`,
        `Il est valable ${v['expires_in_minutes'] === '1' ? '1 minute' : `${v['expires_in_minutes']} minutes`}. ` +
          'Ne le communiquez à personne : KSP ne vous le demandera jamais par téléphone.',
        "Si vous n'avez rien demandé, ignorez ce message.",
      ),
    }),
  },
  debtor(
    'recovery.debtor_mandate_notice',
    {
      creditor_name: CREDITOR_NAME,
      case_number: CASE_NUMBER,
      amount_due: AMOUNT,
      link: PERSONAL_LINK,
      link_expires_on: TEXT,
    },
    (v) => ({
      subject: `Votre dossier ${v['case_number']} — ${v['creditor_name']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP vous écrit pour le compte de ${v['creditor_name']}, qui l'a chargé du ` +
          `recouvrement d'une somme de ${v['amount_due']} (dossier ${v['case_number']}).`,
        'Depuis votre lien personnel, vous pouvez consulter le détail et les pièces, payer en une ou ' +
          'plusieurs fois, proposer un échéancier ou demander à être rappelé.',
        CONTEST,
        `Votre lien (valable jusqu'au ${v['link_expires_on']}, à ne transmettre à personne) : ${v['link']}`,
        'KSP traite vos coordonnées pour ce seul dossier ; vous pouvez exercer vos droits sur vos ' +
          'données en nous écrivant depuis ce lien.',
      ),
    }),
  ),
  debtor(
    'recovery.debtor_reminder',
    { creditor_name: CREDITOR_NAME, case_number: CASE_NUMBER, amount_due: AMOUNT, link: PERSONAL_LINK },
    (v) => ({
      subject: `Rappel — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Pour le compte de ${v['creditor_name']}, le Groupe KSP vous rappelle que ${v['amount_due']} ` +
          `restent dus sur le dossier ${v['case_number']}.`,
        'Vous pouvez payer ou proposer un échéancier adapté à vos moyens depuis votre lien personnel.',
        CONTEST,
        `Votre lien : ${v['link']}`,
      ),
    }),
  ),
  debtor(
    'recovery.debtor_installment_reminder',
    {
      creditor_name: CREDITOR_NAME,
      case_number: CASE_NUMBER,
      amount: AMOUNT,
      due_on: TEXT,
      link: PERSONAL_LINK,
    },
    (v) => ({
      subject: `Échéance du ${v['due_on']} — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP vous rappelle que votre prochaine échéance de ${v['amount']} (dossier ` +
          `${v['case_number']}, pour le compte de ${v['creditor_name']}) est prévue le ${v['due_on']}.`,
        `Payer par Mobile Money ou par carte : ${v['link']}`,
        'Si elle est déjà réglée, merci de ne pas tenir compte de ce message.',
        QUESTIONS,
      ),
    }),
  ),
  debtor(
    'recovery.debtor_payment_link',
    {
      creditor_name: CREDITOR_NAME,
      case_number: CASE_NUMBER,
      amount: AMOUNT,
      link: PERSONAL_LINK,
      expires_on: TEXT,
    },
    (v) => ({
      subject: `Paiement de ${v['amount']} — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP vous transmet le lien pour payer ${v['amount']} sur le dossier ` +
          `${v['case_number']} (pour le compte de ${v['creditor_name']}), par Mobile Money ou par carte.`,
        `Lien valable jusqu'au ${v['expires_on']} : ${v['link']}`,
        'Un reçu vous est remis dès le paiement confirmé.',
        QUESTIONS,
      ),
    }),
  ),
  debtor(
    'recovery.debtor_plan_confirmed',
    {
      creditor_name: CREDITOR_NAME,
      case_number: CASE_NUMBER,
      total: AMOUNT,
      installments: COUNT,
      first_due_on: TEXT,
      link: PERSONAL_LINK,
    },
    (v) => ({
      subject: `Votre échéancier — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP vous confirme votre échéancier pour le dossier ${v['case_number']} (pour le ` +
          `compte de ${v['creditor_name']}) : ${v['total']} en ` +
          `${v['installments'] === '1' ? '1 échéance' : `${v['installments']} échéances`}, ` +
          `la première le ${v['first_due_on']}.`,
        'Vous recevrez un rappel avant chaque échéance. Le document signé et votre calendrier sont ' +
          `disponibles ici : ${v['link']}`,
        QUESTIONS,
      ),
    }),
  ),
  debtor(
    'recovery.debtor_formal_notice',
    {
      creditor_name: CREDITOR_NAME,
      case_number: CASE_NUMBER,
      amount_due: AMOUNT,
      deadline_days: COUNT,
      link: PERSONAL_LINK,
    },
    (v) => ({
      subject: `Mise en demeure — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP vous adresse, pour le compte de ${v['creditor_name']}, une mise en demeure ` +
          `pour le dossier ${v['case_number']} : ${v['amount_due']} restent dus.`,
        `Vous disposez de ${v['deadline_days']} jours pour régler la somme ou convenir d'un ` +
          'échéancier depuis votre lien personnel. Le courrier est consultable au même endroit.',
        CONTEST,
        `Votre lien : ${v['link']}`,
      ),
    }),
  ),
  debtor(
    'recovery.debtor_settlement_certificate',
    { creditor_name: CREDITOR_NAME, case_number: CASE_NUMBER, link: PERSONAL_LINK },
    (v) => ({
      subject: `Attestation de solde — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP vous confirme que le dossier ${v['case_number']} (pour le compte de ` +
          `${v['creditor_name']}) est soldé : plus rien ne vous est demandé. Merci pour vos règlements.`,
        `Votre attestation de solde est disponible ici : ${v['link']}`,
      ),
    }),
  ),
  debtor(
    'recovery.debtor_dispute_received',
    { creditor_name: CREDITOR_NAME, case_number: CASE_NUMBER, link: PERSONAL_LINK },
    (v) => ({
      subject: `Contestation enregistrée — dossier ${v['case_number']}`,
      text: lines(
        politeGreeting(v),
        `Le Groupe KSP a bien enregistré votre contestation du dossier ${v['case_number']} (pour le ` +
          `compte de ${v['creditor_name']}). La procédure est suspendue pendant son examen.`,
        `Vous serez informé de la décision. Suivi : ${v['link']}`,
      ),
    }),
  ),
];
