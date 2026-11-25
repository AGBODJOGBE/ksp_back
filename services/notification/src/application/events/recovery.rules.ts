import { type RecoveryCreditorRef, type RecoveryEventPayloads, type RecoveryEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';
import { eventCalendarDate, eventDate } from './rule-dates';

/**
 * Messages des événements du recouvrement (CDC Recouvrement, partie 17.2 ; ADR-060).
 *
 * Destinataires :
 * - le créancier (`creditor`) : son compte, ou les administrateurs actuels de son organisation
 *   (annuaire identity), l'e-mail allant alors à l'e-mail de facturation vérifié ;
 * - le chargé affecté, quand l'événement le donne (`recovery.case.accepted`) ;
 * - le partenaire (huissier, avocat) qui a un accès KSP (`recovery.partner.assigned`) ;
 * - les équipes configurées : superviseurs (`NOTIFICATION_RECOVERY_SUPERVISOR_USER_IDS`) pour les
 *   nouveaux dossiers, juristes (`NOTIFICATION_RECOVERY_LEGAL_USER_IDS`) pour les contestations et
 *   les actes des partenaires, car ces événements ne désignent ni l'un ni l'autre.
 * Le débiteur ne reçoit jamais de message par un événement : recovery l'écrit par appel direct
 * (ADR-061). `recovery.case.stage_changed` n'envoie rien : chaque étape a déjà son message
 * (mise en demeure, partenaire assigné, échéancier rompu, décision demandée).
 *
 * Liens « Mon espace KSP » (chemins du portail à valider) : /mon-espace/recouvrement/dossiers/<caseId>,
 * /mon-espace/recouvrement/decisions/<decisionId>, /mon-espace/portefeuille ; pour une organisation,
 * `?organisation=<organizationId>`. Partenaire : /mon-espace/recouvrement/partenaire/<assignmentId>.
 */

type Variables = Record<string, string>;

function withOrganization(link: string, creditor: RecoveryCreditorRef): string {
  return creditor.type === 'organization' ? `${link}?organisation=${encodeURIComponent(creditor.id)}` : link;
}

function caseLink(context: RuleContext, event: { caseId: string; creditor: RecoveryCreditorRef }): string {
  return withOrganization(
    `${context.portalBaseUrl}/mon-espace/recouvrement/dossiers/${encodeURIComponent(event.caseId)}`,
    event.creditor,
  );
}

/** Message au créancier : son compte, ou les administrateurs de son organisation. */
function toCreditor(
  event: { caseNumber: string; creditor: RecoveryCreditorRef },
  templateCode: string,
  link: string,
  variables: Variables,
): NotificationIntent {
  return {
    userId: event.creditor.id,
    templateCode,
    variables: { ...variables, case_number: event.caseNumber, organization_name: '', link },
    link,
    ...(event.creditor.type === 'organization' ? { organizationId: event.creditor.id } : {}),
  };
}

/** Un message par membre de l'équipe ; aucun si la liste est vide. */
function toTeam(
  userIds: readonly string[],
  templateCode: string,
  caseNumber: string,
  variables: Variables,
): NotificationIntent[] {
  return userIds.map((userId) => ({
    userId,
    templateCode,
    variables: { ...variables, case_number: caseNumber },
    link: null,
  }));
}

const KIND_LABELS: Record<RecoveryEventPayloads['recovery.case.submitted']['kind'], string> = {
  b2b: 'entreprise',
  b2c: 'particulier',
  rent: 'loyers',
};

const REJECTION_REASONS: Record<RecoveryEventPayloads['recovery.case.rejected']['reason'], string> = {
  prescribed: 'la créance est prescrite',
  illegal: 'la créance ne peut pas être recouvrée légalement',
  no_evidence: 'les pièces fournies ne prouvent pas la créance',
  debtor_unreachable: 'le débiteur est introuvable',
  other: 'il ne remplit pas les conditions de recevabilité',
  incomplete: "le complément demandé n'a pas été fourni dans le délai, le dossier est classé",
};

type DecisionKind = RecoveryEventPayloads['recovery.decision.requested']['kind'];

const DECISIONS: Record<DecisionKind, { decision: string; withoutAnswer: string }> = {
  plan_off_scale: {
    decision: 'accepter ou refuser un échéancier proposé en dehors de votre barème',
    withoutAnswer: "l'échéancier sera refusé",
  },
  settlement_discount: {
    decision: 'accepter ou refuser une remise contre un paiement immédiat',
    withoutAnswer: 'la remise sera refusée',
  },
  bailiff_escalation: {
    decision: 'confier le dossier à un huissier (devis des frais et provision à régler)',
    withoutAnswer: 'le dossier sera clôturé pour abandon',
  },
  litigation_escalation: {
    decision: 'engager une procédure judiciaire (devis des frais et provision à régler)',
    withoutAnswer: 'le dossier sera clôturé pour abandon',
  },
  dispute_response: {
    decision: 'répondre à la contestation du débiteur, avec vos pièces',
    withoutAnswer: 'le juriste de KSP décidera au vu des éléments du dossier',
  },
  stage_skip: {
    decision: 'autoriser le passage direct à une étape plus avancée de la procédure',
    withoutAnswer: 'la procédure suivra son cours normal',
  },
};

const RESOLUTIONS: Record<RecoveryEventPayloads['recovery.case.resumed']['resolution'], string> = {
  resume: "la contestation du débiteur n'est pas retenue, la procédure reprend",
  correct_amount: 'le montant dû est corrigé après la contestation, la procédure reprend sur cette base',
};

const CLOSING_REASONS: Record<RecoveryEventPayloads['recovery.case.closed']['reason'], string> = {
  paid: 'le débiteur a réglé la totalité de la somme due',
  settlement_executed: "l'accord transactionnel a été exécuté",
  dispute_upheld: 'la contestation du débiteur a été jugée fondée',
  abandoned_by_creditor: 'il a été arrêté à votre demande ou faute de votre accord',
  unrecoverable: 'la créance est irrécouvrable (débiteur insolvable ou introuvable)',
  prescribed: 'la créance est prescrite',
};

const PARTNERS: Record<RecoveryEventPayloads['recovery.partner.assigned']['partnerKind'], string> = {
  bailiff: 'un huissier de justice partenaire',
  lawyer: 'un avocat partenaire',
};

const ACTS: Record<RecoveryEventPayloads['recovery.partner.act_recorded']['actType'], string> = {
  summons_to_pay: 'sommation de payer',
  service: 'signification',
  conservatory_measure: 'mesure conservatoire',
  seizure: 'saisie',
  injunction_request: 'requête en injonction de payer',
  injunction_order: "ordonnance d'injonction de payer",
  hearing: 'audience',
  judgment: 'décision de justice',
  enforcement: 'exécution forcée',
  insolvency_report: "constat d'insolvabilité",
  other: 'acte du partenaire',
};

export const RECOVERY_RULES: { readonly [T in RecoveryEventType]?: EventRule<T> } = {
  'recovery.case.submitted': (event, context) => [
    toCreditor(event, 'recovery.case_submitted.customer', caseLink(context, event), {
      amount_due: formatXof(event.amountDue.amount),
    }),
    ...toTeam(context.recoverySupervisorUserIds, 'recovery.case_submitted.team', event.caseNumber, {
      kind: KIND_LABELS[event.kind],
      amount_due: formatXof(event.amountDue.amount),
    }),
  ],

  'recovery.case.accepted': (event, context) => [
    toCreditor(event, 'recovery.case_accepted.customer', caseLink(context, event), {}),
    ...(event.assignedAgentId
      ? toTeam([event.assignedAgentId], 'recovery.case_assigned.agent', event.caseNumber, {})
      : []),
  ],

  'recovery.case.info_requested': (event, context) => [
    toCreditor(event, 'recovery.case_info_requested.customer', caseLink(context, event), {
      due_on: eventDate(event.completionDueAt, context),
    }),
  ],

  'recovery.case.rejected': (event, context) => [
    toCreditor(event, 'recovery.case_rejected.customer', caseLink(context, event), {
      reason: REJECTION_REASONS[event.reason],
      ...(event.refundedAmount.amount > 0 ? { refunded: formatXof(event.refundedAmount.amount) } : {}),
    }),
  ],

  'recovery.decision.requested': (event, context) => {
    const { decision, withoutAnswer } = DECISIONS[event.kind];
    const link = withOrganization(
      `${context.portalBaseUrl}/mon-espace/recouvrement/decisions/${encodeURIComponent(event.decisionId)}`,
      event.creditor,
    );
    return [
      toCreditor(event, 'recovery.decision_requested.customer', link, {
        decision,
        expires_on: eventDate(event.expiresAt, context),
        without_answer: withoutAnswer,
      }),
    ];
  },

  'recovery.plan.signed': (event, context) => [
    toCreditor(event, 'recovery.plan_signed.customer', caseLink(context, event), {
      total: formatXof(event.total.amount),
      installments: String(event.installmentsCount),
      first_due_on: eventCalendarDate(event.firstDueDate),
    }),
  ],

  'recovery.plan.installment_missed': (event, context) => [
    toCreditor(event, 'recovery.installment_missed.customer', caseLink(context, event), {
      rank: String(event.installmentRank),
      amount: formatXof(event.amount.amount),
      due_on: eventCalendarDate(event.dueDate),
    }),
  ],

  'recovery.plan.defaulted': (event, context) => [
    toCreditor(event, 'recovery.plan_defaulted.customer', caseLink(context, event), {
      missed: String(event.missedCount),
    }),
  ],

  'recovery.payment.collected': (event, context) => [
    event.source === 'direct_to_creditor'
      ? toCreditor(event, 'recovery.direct_payment_recorded.customer', caseLink(context, event), {
          amount: formatXof(event.gross.amount),
          commission: formatXof(event.commission.amount),
          amount_due_after: formatXof(event.amountDueAfter.amount),
        })
      : toCreditor(event, 'recovery.payment_collected.customer', caseLink(context, event), {
          amount: formatXof(event.gross.amount),
          amount_due_after: formatXof(event.amountDueAfter.amount),
        }),
  ],

  // Un seul message au créancier par encaissement (décision validée, lot R3) : le net est crédité
  // tout de suite après l’encaissement, dont `recovery.payment.collected` a déjà prévenu le créancier.
  'recovery.remittance.paid': () => [],

  'recovery.notice.issued': (event, context) => [
    toCreditor(event, 'recovery.notice_issued.customer', caseLink(context, event), {
      deadline_days: String(event.deadlineDays),
    }),
  ],

  'recovery.partner.assigned': (event, context) => {
    const intents = [
      toCreditor(event, 'recovery.partner_assigned.customer', caseLink(context, event), {
        partner: PARTNERS[event.partnerKind],
      }),
    ];
    if (event.partnerUserId) {
      const link = `${context.portalBaseUrl}/mon-espace/recouvrement/partenaire/${encodeURIComponent(event.assignmentId)}`;
      intents.push({
        userId: event.partnerUserId,
        templateCode: 'recovery.case_assigned.partner',
        variables: { case_number: event.caseNumber, link },
        link,
      });
    }
    return intents;
  },

  'recovery.partner.act_recorded': (event, context) => {
    const act = ACTS[event.actType];
    const actOn = eventCalendarDate(event.actDate);
    return [
      toCreditor(event, 'recovery.act_recorded.customer', caseLink(context, event), {
        act,
        act_on: actOn,
        cost: formatXof(event.cost.amount),
      }),
      ...toTeam(context.recoveryLegalUserIds, 'recovery.act_recorded.team', event.caseNumber, {
        act,
        act_on: actOn,
      }),
    ];
  },

  'recovery.case.suspended': (event, context) => {
    const answerDueOn = eventDate(event.creditorAnswerDueAt, context);
    return [
      toCreditor(event, 'recovery.case_suspended.customer', caseLink(context, event), {
        answer_due_on: answerDueOn,
      }),
      ...toTeam(context.recoveryLegalUserIds, 'recovery.dispute_opened.team', event.caseNumber, {
        answer_due_on: answerDueOn,
      }),
    ];
  },

  'recovery.case.resumed': (event, context) => [
    toCreditor(event, 'recovery.case_resumed.customer', caseLink(context, event), {
      resolution: RESOLUTIONS[event.resolution],
    }),
  ],

  'recovery.case.closed': (event, context) => [
    toCreditor(event, 'recovery.case_closed.customer', caseLink(context, event), {
      reason: CLOSING_REASONS[event.reason],
      total_collected: formatXof(event.totalCollected.amount),
    }),
  ],
};
