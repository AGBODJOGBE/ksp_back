import { type EventTemplateDefinition } from '../template';
import {
  AMOUNT,
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
 * Messages du Nettoyage v2 au client : demande, visite, devis et programme (CDC Nettoyage v2,
 * 16.2). Le dossier est désigné par son numéro (DN-000124), le programme par le sien (PN-000057) ;
 * le lieu par les libellés du catalogue en vigueur. Les messages de paiement et de suspension
 * partent toujours (preferences.ts) ; la suspension et l'avertissement d'impayés sont importants
 * (WhatsApp et e-mail).
 */

/** Causes de suspension écrites en clair, dans l'ordre des causes de l'événement (variable `causes`). */
const CAUSES = TEXT;

export const CLEANING_CUSTOMER_TEMPLATES: readonly EventTemplateDefinition[] = [
  template(
    'cleaning.request_submitted.customer',
    'short',
    {
      request_number: NUMBER,
      place: TEXT,
      case: oneOf('paid', 'awaiting_payment'),
      visit_fee: AMOUNT,
      link: LINK,
    },
    (v) => ({
      subject: `Demande de nettoyage ${v['request_number']} reçue`,
      text: lines(
        greeting(v),
        `Nous avons bien reçu votre demande ${v['request_number']} : ${v['place']}.`,
        v['case'] === 'paid'
          ? `Les frais de visite (${v['visit_fee']}) sont réglés : nous vous proposerons bientôt une date de visite des lieux.`
          : `Réglez les frais de visite (${v['visit_fee']}) depuis Mon espace KSP pour que nous planifiions la visite des lieux.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.visit_fee_paid.customer',
    'short',
    { request_number: NUMBER, amount: AMOUNT, link: LINK },
    (v) => ({
      subject: `Frais de visite réglés — ${v['request_number']}`,
      text: lines(
        greeting(v),
        `Nous avons bien reçu le paiement des frais de visite de votre demande ${v['request_number']} : ${v['amount']}. ` +
          'Nous vous proposerons une date de visite des lieux.',
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.visit_rescheduled.customer',
    'short',
    { request_number: NUMBER, date: TEXT, previous_date: TEXT, link: LINK },
    (v) => ({
      subject: `Visite des lieux déplacée — ${v['request_number']}`,
      text: lines(
        greeting(v),
        `La visite des lieux de votre demande ${v['request_number']}, prévue le ${v['previous_date']}, ` +
          `est déplacée au ${v['date']}.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.visit_cancelled.customer',
    'short',
    { case: oneOf('slot_changed', 'ksp', 'agent_no_show'), request_number: NUMBER, date: TEXT, link: LINK },
    (v) => ({
      subject: `Visite des lieux annulée — ${v['request_number']}`,
      text: lines(
        greeting(v),
        v['case'] === 'slot_changed'
          ? `La visite des lieux du ${v['date']} (dossier ${v['request_number']}) est annulée, comme vous l'avez demandé : ` +
              'nous vous proposerons un nouveau créneau.'
          : `Nous avons dû annuler la visite des lieux prévue le ${v['date']} (dossier ${v['request_number']}). ` +
              'Nous vous proposerons une nouvelle date ; la prochaine visite ne vous sera pas facturée.',
        v['refund'] ? `Les frais de visite (${v['refund']}) sont remboursés sur votre portefeuille KSP.` : '',
        details(v),
      ),
    }),
    { refund: AMOUNT },
  ),
  template('cleaning.visit_arrived.customer', 'short', { request_number: NUMBER, link: LINK }, (v) => ({
    subject: `L'agent KSP est arrivé — ${v['request_number']}`,
    text: lines(
      greeting(v),
      `L'agent KSP est arrivé pour la visite des lieux de votre demande ${v['request_number']}.`,
      details(v),
    ),
  })),
  template('cleaning.visit_completed.customer', 'short', { request_number: NUMBER, link: LINK }, (v) => ({
    subject: `Visite des lieux terminée — ${v['request_number']}`,
    text: lines(
      greeting(v),
      `La visite des lieux de votre demande ${v['request_number']} est terminée. ` +
        'Nous préparons votre devis : vous le recevrez dans Mon espace KSP.',
      details(v),
    ),
  })),
  template(
    'cleaning.renewal_proposed.customer',
    'document',
    { request_number: NUMBER, total: AMOUNT, valid_until: TEXT, link: LINK },
    (v) => ({
      subject: `Renouvellement de votre programme de nettoyage — ${v['request_number']}`,
      text: lines(
        greeting(v),
        `Nous vous proposons de renouveler votre programme de nettoyage (dossier ${v['request_number']}) : ` +
          `${v['total']}, offre valable jusqu'au ${v['valid_until']}.`,
        `Consultez-la, puis acceptez-la ou refusez-la dans Mon espace KSP : ${v['link']}`,
      ),
    }),
  ),
  template('cleaning.quote_forwarded.customer', 'short', { request_number: NUMBER, link: LINK }, (v) => ({
    subject: `Devis à valider — ${v['request_number']}`,
    text: lines(
      greeting(v),
      `Un membre de votre organisation vous transmet pour accord le devis du dossier ${v['request_number']}.`,
      `Acceptez-le ou refusez-le dans Mon espace KSP : ${v['link']}`,
    ),
  })),
  template(
    'cleaning.program_confirmed.customer',
    'document',
    {
      program_number: NUMBER,
      place: TEXT,
      sessions_count: COUNT,
      first_date: TEXT,
      total: AMOUNT,
      link: LINK,
    },
    (v) => ({
      subject: `Programme de nettoyage ${v['program_number']} confirmé`,
      text: lines(
        greeting(v),
        `Votre programme ${v['program_number']} est confirmé : ${v['place']}, ` +
          `${plural(v['sessions_count'], 'séance')}, la première le ${v['first_date']}.`,
        `Montant total : ${v['total']}. Nous vous préviendrons dès que l'équipe de chaque séance sera désignée.`,
        details(v),
      ),
    }),
  ),
  template(
    'cleaning.program_completed.customer',
    'short',
    {
      program_number: NUMBER,
      sessions_completed: INTEGER,
      end_date: TEXT,
      case: oneOf('one_off', 'recurring'),
      link: LINK,
    },
    (v) => ({
      subject: `Programme de nettoyage ${v['program_number']} terminé`,
      text: lines(
        greeting(v),
        `Votre programme ${v['program_number']} est terminé depuis le ${v['end_date']} : ` +
          `${plural(v['sessions_completed'], 'séance réalisée', 'séances réalisées')}. Merci de votre confiance.`,
        v['case'] === 'one_off'
          ? `Pour la même prestation au même lieu, commandez à nouveau : ${v['link']}`
          : details(v),
      ),
    }),
  ),
  template(
    'cleaning.program_cancelled.customer',
    'short',
    { case: oneOf('customer', 'ksp'), link: LINK },
    (v) => ({
      subject: 'Programme de nettoyage arrêté',
      text: lines(
        greeting(v),
        v['case'] === 'customer'
          ? "L'arrêt de votre programme de nettoyage est enregistré : ses séances à venir sont annulées."
          : 'KSP a arrêté votre programme de nettoyage : ses séances à venir sont annulées. ' +
              'Pour toute question, contactez le service client KSP.',
        details(v),
      ),
    }),
  ),
  template('cleaning.program_suspended.customer', 'important', { causes: CAUSES, link: LINK }, (v) => ({
    subject: 'Programme de nettoyage suspendu',
    text: lines(
      greeting(v),
      `Votre programme de nettoyage est suspendu (${v['causes']}). Ses séances à venir sont mises en attente.`,
      `Pour régulariser la situation : ${v['link']}`,
    ),
  })),
  template(
    'cleaning.program_suspension_updated.customer',
    'important',
    { case: oneOf('cause_added', 'cause_lifted'), cause: TEXT, causes: CAUSES, link: LINK },
    (v) => ({
      subject: 'Suspension de votre programme de nettoyage',
      text: lines(
        greeting(v),
        v['case'] === 'cause_added'
          ? `Une nouvelle cause s'ajoute à la suspension de votre programme de nettoyage : ${v['cause']}.`
          : `La cause « ${v['cause']} » est levée, mais votre programme de nettoyage reste suspendu.`,
        `Causes en cours : ${v['causes']}.`,
        `Pour régulariser la situation : ${v['link']}`,
      ),
    }),
  ),
  template('cleaning.program_resumed.customer', 'short', { link: LINK }, (v) => ({
    subject: 'Programme de nettoyage repris',
    text: lines(
      greeting(v),
      'Votre programme de nettoyage reprend. Nous planifions vos prochaines séances : ' +
        "vous serez prévenu dès que l'équipe de chacune sera désignée.",
      details(v),
    ),
  })),
  template(
    'cleaning.unpaid_warning.customer',
    'important',
    { unpaid_count: COUNT, suspension_threshold: COUNT, link: LINK },
    (v) => ({
      subject: `Factures impayées${v['organization_name'] ? ` — ${v['organization_name']}` : ''}`,
      text: lines(
        greeting(v),
        `Votre organisation a ${plural(v['unpaid_count'], 'facture impayée', 'factures impayées')}. ` +
          `À ${v['suspension_threshold']} factures impayées, ses programmes de nettoyage sont suspendus.`,
        `Réglez vos factures : ${v['link']}`,
      ),
    }),
    { organization_name: /^[^\n]{0,200}$/ },
  ),
  // Décisions du lot G : demande refusée, devis retiré, paiement laissé au portefeuille, client
  // absent à la visite. Messages d'argent ou de clôture : ils partent toujours (preferences.ts).
  template(
    'cleaning.request_rejected.customer',
    'short',
    { request_number: NUMBER, reason: TEXT, link: LINK },
    (v) => ({
      subject: `Demande de nettoyage ${v['request_number']} non retenue`,
      text: lines(
        greeting(v),
        `Nous ne pouvons malheureusement pas donner suite à votre demande ${v['request_number']} (motif : ${v['reason']}).`,
        v['refund'] ? `Les frais de visite (${v['refund']}) sont remboursés sur votre portefeuille KSP.` : '',
        details(v),
      ),
    }),
    { refund: AMOUNT },
  ),
  template('cleaning.quote_withdrawn.customer', 'short', { request_number: NUMBER, link: LINK }, (v) => ({
    subject: `Devis retiré — ${v['request_number']}`,
    text: lines(
      greeting(v),
      `Le devis du dossier ${v['request_number']} est retiré : il ne peut plus être accepté. ` +
        'KSP organise une nouvelle visite des lieux, sans frais, puis vous enverra un nouveau devis.',
      details(v),
    ),
  })),
  template(
    'cleaning.payment_left_in_wallet.customer',
    'short',
    { amount: AMOUNT, object: TEXT, reason: TEXT, link: LINK },
    (v) => ({
      subject: 'Paiement reçu',
      text: lines(
        greeting(v),
        `Nous avons bien reçu votre paiement de ${v['amount']} pour ${v['object']}, qui n'est plus à payer (${v['reason']}). ` +
          'Le montant est disponible dans votre portefeuille KSP.',
        details(v, 'Votre portefeuille'),
      ),
    }),
  ),
  template(
    'cleaning.visit_missed.customer',
    'short',
    { request_number: NUMBER, date: TEXT, visit_fee: AMOUNT, pay_before: TEXT, link: LINK },
    (v) => ({
      subject: `Visite des lieux manquée — ${v['request_number']}`,
      text: lines(
        greeting(v),
        `L'agent KSP a constaté votre absence à la visite des lieux du ${v['date']} (dossier ${v['request_number']}).`,
        `Pour une nouvelle visite, réglez les nouveaux frais de visite (${v['visit_fee']}) avant le ${v['pay_before']} : ` +
          'sans paiement à cette date, la demande sera annulée.',
        details(v),
      ),
    }),
  ),
];
