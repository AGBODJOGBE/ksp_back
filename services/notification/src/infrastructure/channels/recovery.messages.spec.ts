import { type KspEventPayloads, type RecoveryEventType } from '@ksp/contracts';
import { EVENT_CONSUMERS } from '@ksp/platform';
import { RECOVERY_DIRECT_TEMPLATES, RECOVERY_TEMPLATES } from '../../domain/messages/recovery.messages';
import { isOptionalMessage } from '../../domain/preferences';
import { findTemplate, invalidVariables, isEventTemplate } from '../../domain/template';
import { type NotificationIntent, type RuleContext } from '../../application/events/event-rules';
import { LISTENED_EVENTS } from '../../application/events/listened-events';
import { RECOVERY_RULES } from '../../application/events/recovery.rules';
import { WHATSAPP_EVENT_TEMPLATES } from './whatsapp-templates';

const CONTEXT: RuleContext = {
  portalBaseUrl: 'https://ksp.bj',
  timeZone: 'Africa/Porto-Novo',
  cleaningTeamUserIds: [],
  accountsTeamUserIds: [],
  recoverySupervisorUserIds: ['0192f1c4-0000-7000-8000-0000000005a1'],
  recoveryLegalUserIds: ['0192f1c4-0000-7000-8000-0000000004b1'],
};
const CREDITOR = '0192f1c4-0000-7000-8000-00000000c001';
const ORG = '0192f1c4-0000-7000-8000-00000000a001';
const AGENT = '0192f1c4-0000-7000-8000-0000000000a1';
const PARTNER_USER = '0192f1c4-0000-7000-8000-0000000000b1';
const ID = '0192f1c4-0000-7000-8000-00000000e001';
const CASE = '0192f1c4-0000-7000-8000-00000000d001';
const AT = '2026-11-20T10:00:00Z';
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });
const NBSP = ' ';
const base = { caseId: CASE, caseNumber: 'RC-000123', creditor: { type: 'user' as const, id: CREDITOR } };
const CASE_LINK = `https://ksp.bj/mon-espace/recouvrement/dossiers/${CASE}`;

/** Un exemple de chaque événement recovery écouté. */
const SAMPLES: { [T in RecoveryEventType]: KspEventPayloads[T] } = {
  'recovery.case.submitted': {
    ...base,
    kind: 'b2b',
    amountDue: xof(500000),
    source: 'form',
    submittedAt: AT,
  },
  'recovery.case.accepted': { ...base, kind: 'b2b', assignedAgentId: AGENT, score: 72, acceptedAt: AT },
  'recovery.case.info_requested': { ...base, completionDueAt: '2026-12-05T10:00:00Z', requestedAt: AT },
  'recovery.case.rejected': { ...base, reason: 'incomplete', refundedAmount: xof(7500), rejectedAt: AT },
  'recovery.case.stage_changed': {
    ...base,
    kind: 'b2b',
    fromStage: 'notice',
    toStage: 'amicable',
    skipReason: null,
    changedBy: 'system',
    changedAt: AT,
  },
  'recovery.case.suspended': {
    ...base,
    reason: 'dispute',
    disputeId: ID,
    creditorAnswerDueAt: '2026-11-30T10:00:00Z',
    suspendedAt: AT,
  },
  'recovery.case.resumed': { ...base, disputeId: ID, resolution: 'correct_amount', resumedAt: AT },
  'recovery.case.closed': {
    ...base,
    kind: 'b2b',
    reason: 'paid',
    totalCollected: xof(500000),
    settlementCertificateDocumentId: ID,
    closedAt: AT,
  },
  'recovery.decision.requested': {
    ...base,
    decisionId: ID,
    kind: 'stage_skip',
    expiresAt: '2026-12-05T10:00:00Z',
    requestedAt: AT,
  },
  'recovery.plan.signed': {
    ...base,
    planId: ID,
    total: xof(300000),
    installmentsCount: 3,
    firstDueDate: '2026-12-05',
    renegotiation: false,
    documentId: ID,
    signedAt: AT,
  },
  'recovery.plan.installment_missed': {
    ...base,
    planId: ID,
    installmentRank: 2,
    dueDate: '2027-01-05',
    amount: xof(100000),
    missedCount: 1,
    missedAt: AT,
  },
  'recovery.plan.defaulted': { ...base, planId: ID, missedCount: 2, defaultedAt: AT },
  'recovery.notice.issued': { ...base, noticeId: ID, documentId: ID, deadlineDays: 15, issuedAt: AT },
  'recovery.payment.collected': {
    ...base,
    kind: 'b2b',
    collectionId: ID,
    source: 'payment_link',
    gross: xof(40000),
    allocatedCosts: xof(0),
    allocatedInterests: xof(0),
    allocatedPrincipal: xof(40000),
    overpaid: xof(0),
    commission: xof(4000),
    commissionSettlement: 'deducted',
    stage: 'payment_plan',
    amountDueAfter: xof(460000),
    receivedAt: AT,
  },
  'recovery.remittance.paid': {
    ...base,
    collectionId: ID,
    gross: xof(40000),
    commission: xof(4000),
    net: xof(36000),
    walletTransactionId: ID,
    creditedAt: AT,
  },
  'recovery.partner.assigned': {
    ...base,
    assignmentId: ID,
    partnerId: ID,
    partnerKind: 'bailiff',
    partnerUserId: PARTNER_USER,
    assignedAt: AT,
  },
  'recovery.partner.act_recorded': {
    ...base,
    actId: ID,
    assignmentId: ID,
    partnerId: ID,
    actType: 'summons_to_pay',
    actDate: '2026-11-25',
    cost: xof(25000),
    recordedAt: AT,
  },
};

function intentsOf<T extends RecoveryEventType>(
  type: T,
  payload: KspEventPayloads[T] = SAMPLES[type] as KspEventPayloads[T],
) {
  const rule = RECOVERY_RULES[type];
  return rule ? rule(payload, CONTEXT) : [];
}

/** Variables telles qu'envoyées : `first_name` est ajouté par le service. */
function sent(intent: NotificationIntent): Record<string, string> {
  return { ...intent.variables, first_name: 'Koffi' };
}

describe('événements du recouvrement écoutés (partie 17.2)', () => {
  const recoveryTypes = Object.keys(SAMPLES) as RecoveryEventType[];
  const listened = recoveryTypes.filter((type) => type !== 'recovery.case.stage_changed');

  it('16 événements écoutés, déclarés dans EVENT_CONSUMERS ; le changement d’étape n’envoie rien', () => {
    expect(listened.every((type) => LISTENED_EVENTS.includes(type))).toBe(true);
    expect(LISTENED_EVENTS).not.toContain('recovery.case.stage_changed');
    expect(listened.every((type) => (EVENT_CONSUMERS.notification as readonly string[]).includes(type))).toBe(
      true,
    );
    expect(intentsOf('recovery.case.stage_changed')).toEqual([]);
  });

  // Reversement : aucun message, l’encaissement a déjà prévenu le créancier (un seul message).
  const messaged = listened.filter((type) => type !== 'recovery.remittance.paid');

  it.each(messaged)('%s : modèles connus, variables valides, texte et modèle WhatsApp complets', (type) => {
    const intents = intentsOf(type);
    expect(intents.length).toBeGreaterThan(0);
    for (const intent of intents) {
      const template = findTemplate(intent.templateCode)!;
      expect(template).not.toBeNull();
      expect(isEventTemplate(template)).toBe(true);
      expect(invalidVariables(template, sent(intent))).toEqual([]);
      const rendered = template.render!(sent(intent));
      expect(rendered.text).not.toMatch(/undefined|\{\w+\}/);
      const whatsapp = WHATSAPP_EVENT_TEMPLATES[intent.templateCode]!;
      expect(whatsapp.name(sent(intent))).toMatch(/^ksp_recovery_[a-z_]+$/);
      expect(whatsapp.parameters(sent(intent)).every((parameter) => parameter.trim() !== '')).toBe(true);
    }
  });
});

describe('destinataires et liens', () => {
  it('créancier particulier : son compte, lien vers le dossier dans Mon espace', () => {
    const [intent] = intentsOf('recovery.case.accepted');
    expect(intent).toEqual({
      userId: CREDITOR,
      templateCode: 'recovery.case_accepted.customer',
      variables: { case_number: 'RC-000123', organization_name: '', link: CASE_LINK },
      link: CASE_LINK,
    });
  });

  it('créancier organisation : administrateurs de l’organisation, lien dans son contexte', () => {
    const [intent] = intentsOf('recovery.case.accepted', {
      ...SAMPLES['recovery.case.accepted'],
      creditor: { type: 'organization', id: ORG },
    });
    expect(intent).toMatchObject({
      organizationId: ORG,
      link: `${CASE_LINK}?organisation=${ORG}`,
      variables: { link: `${CASE_LINK}?organisation=${ORG}` },
    });
  });

  it('dossier accepté : le chargé affecté est prévenu ; sans chargé, seul le créancier', () => {
    expect(intentsOf('recovery.case.accepted').map((intent) => [intent.userId, intent.templateCode])).toEqual(
      [
        [CREDITOR, 'recovery.case_accepted.customer'],
        [AGENT, 'recovery.case_assigned.agent'],
      ],
    );
    expect(
      intentsOf('recovery.case.accepted', { ...SAMPLES['recovery.case.accepted'], assignedAgentId: null }),
    ).toHaveLength(1);
  });

  it('nouveau dossier : les superviseurs configurés, sans lien (back-office)', () => {
    const [, team] = intentsOf('recovery.case.submitted');
    expect(team).toEqual({
      userId: CONTEXT.recoverySupervisorUserIds[0],
      templateCode: 'recovery.case_submitted.team',
      variables: { case_number: 'RC-000123', kind: 'entreprise', amount_due: `500${NBSP}000${NBSP}FCFA` },
      link: null,
    });
  });

  it('contestation et acte d’un partenaire : les juristes configurés', () => {
    expect(intentsOf('recovery.case.suspended').map((intent) => intent.templateCode)).toEqual([
      'recovery.case_suspended.customer',
      'recovery.dispute_opened.team',
    ]);
    expect(intentsOf('recovery.partner.act_recorded')[1]).toMatchObject({
      userId: CONTEXT.recoveryLegalUserIds[0],
      variables: { act: 'sommation de payer', act_on: '25 novembre 2026' },
    });
  });

  it('partenaire assigné : le partenaire avec un accès KSP reçoit le lien de sa mission', () => {
    const intents = intentsOf('recovery.partner.assigned');
    expect(intents[1]).toEqual({
      userId: PARTNER_USER,
      templateCode: 'recovery.case_assigned.partner',
      variables: {
        case_number: 'RC-000123',
        link: `https://ksp.bj/mon-espace/recouvrement/partenaire/${ID}`,
      },
      link: `https://ksp.bj/mon-espace/recouvrement/partenaire/${ID}`,
    });
    expect(
      intentsOf('recovery.partner.assigned', {
        ...SAMPLES['recovery.partner.assigned'],
        partnerUserId: null,
      }),
    ).toHaveLength(1);
  });

  it('décision à prendre : lien vers la décision, délai et conséquence d’une absence de réponse', () => {
    const [intent] = intentsOf('recovery.decision.requested', {
      ...SAMPLES['recovery.decision.requested'],
      kind: 'bailiff_escalation',
    });
    expect(intent!.link).toBe(`https://ksp.bj/mon-espace/recouvrement/decisions/${ID}`);
    const text = findTemplate(intent!.templateCode)!.render!(sent(intent!)).text;
    expect(text).toContain('confier le dossier à un huissier');
    expect(text).toContain('avant le 5 décembre 2026 ; sans réponse, le dossier sera clôturé pour abandon.');
  });

  it('jours civils (échéance, date d’un acte) écrits tels quels, quel que soit le fuseau', () => {
    const west = { ...CONTEXT, timeZone: 'America/Los_Angeles' };
    const missed = RECOVERY_RULES['recovery.plan.installment_missed']!(
      SAMPLES['recovery.plan.installment_missed'],
      west,
    );
    expect(missed[0]!.variables['due_on']).toBe('5 janvier 2027');
    const act = RECOVERY_RULES['recovery.partner.act_recorded']!(
      SAMPLES['recovery.partner.act_recorded'],
      west,
    );
    expect(act[0]!.variables['act_on']).toBe('25 novembre 2026');
    expect(() =>
      intentsOf('recovery.plan.signed', { ...SAMPLES['recovery.plan.signed'], firstDueDate: '2026-02-30' }),
    ).toThrow('date illisible');
  });

  it('reversement : aucun message, un seul message au créancier par encaissement', () => {
    expect(intentsOf('recovery.remittance.paid')).toEqual([]);
  });
});

describe('textes', () => {
  it('dossier refusé : motif ; remboursement seulement s’il y en a un, avec son modèle WhatsApp', () => {
    const [refund] = intentsOf('recovery.case.rejected');
    const template = findTemplate('recovery.case_rejected.customer')!;
    expect(template.render!(sent(refund!)).text).toContain(
      "le complément demandé n'a pas été fourni dans le délai, le dossier est classé.",
    );
    expect(template.render!(sent(refund!)).text).toContain(`7${NBSP}500${NBSP}FCFA`);
    expect(WHATSAPP_EVENT_TEMPLATES['recovery.case_rejected.customer']!.name(sent(refund!))).toBe(
      'ksp_recovery_case_rejected_refund',
    );
    const [none] = intentsOf('recovery.case.rejected', {
      ...SAMPLES['recovery.case.rejected'],
      reason: 'prescribed',
      refundedAmount: xof(0),
    });
    expect(none!.variables['refunded']).toBeUndefined();
    expect(WHATSAPP_EVENT_TEMPLATES['recovery.case_rejected.customer']!.name(sent(none!))).toBe(
      'ksp_recovery_case_rejected',
    );
  });

  it('paiement reçu directement par le créancier : commission facturée, modèle propre', () => {
    const [intent] = intentsOf('recovery.payment.collected', {
      ...SAMPLES['recovery.payment.collected'],
      source: 'direct_to_creditor',
      commissionSettlement: 'invoiced',
    });
    expect(intent!.templateCode).toBe('recovery.direct_payment_recorded.customer');
    expect(findTemplate(intent!.templateCode)!.render!(sent(intent!)).text).toContain(
      `La commission correspondante (4${NBSP}000${NBSP}FCFA) vous sera facturée`,
    );
  });

  it('échéancier rompu après une seule échéance manquée : singulier', () => {
    const [intent] = intentsOf('recovery.plan.defaulted', {
      ...SAMPLES['recovery.plan.defaulted'],
      missedCount: 1,
    });
    expect(findTemplate(intent!.templateCode)!.render!(sent(intent!)).text).toContain(
      '(1 échéance non payée)',
    );
  });

  it('organisation : raison sociale dans l’objet de l’e-mail', () => {
    const [intent] = intentsOf('recovery.case.closed');
    const rendered = findTemplate(intent!.templateCode)!.render!({
      ...sent(intent!),
      organization_name: 'SARL Bénin Propre',
    });
    expect(rendered.subject).toBe('Dossier RC-000123 clôturé — SARL Bénin Propre');
  });

  it('nature des messages : décisions, complément et contestation importants ; équipes toujours envoyées', () => {
    const kinds = Object.fromEntries(RECOVERY_TEMPLATES.map((template) => [template.code, template.kind]));
    expect(kinds['recovery.decision_requested.customer']).toBe('important');
    expect(kinds['recovery.case_info_requested.customer']).toBe('important');
    expect(kinds['recovery.case_suspended.customer']).toBe('important');
    expect(isOptionalMessage(findTemplate('recovery.payment_collected.customer')!)).toBe(true);
    expect(isOptionalMessage(findTemplate('recovery.decision_requested.customer')!)).toBe(false);
    expect(isOptionalMessage(findTemplate('recovery.case_submitted.team')!)).toBe(false);
  });
});

describe('messages directs au débiteur (ADR-061)', () => {
  const VARIABLES: Record<string, Record<string, string>> = {
    'recovery.debtor_access_code': { code: '482913', expires_in_minutes: '10' },
    'recovery.debtor_mandate_notice': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      amount_due: `500${NBSP}000${NBSP}FCFA`,
      link: 'https://ksp.bj/recouvrement/abc',
      link_expires_on: '20 décembre 2026',
    },
    'recovery.debtor_reminder': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      amount_due: `500${NBSP}000${NBSP}FCFA`,
      link: 'https://ksp.bj/recouvrement/abc',
    },
    'recovery.debtor_installment_reminder': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      amount: `100${NBSP}000${NBSP}FCFA`,
      due_on: '5 décembre 2026',
      link: 'https://ksp.bj/payer/abc',
    },
    'recovery.debtor_payment_link': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      amount: `100${NBSP}000${NBSP}FCFA`,
      link: 'https://ksp.bj/payer/abc',
      expires_on: '5 décembre 2026',
    },
    'recovery.debtor_plan_confirmed': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      total: `300${NBSP}000${NBSP}FCFA`,
      installments: '3',
      first_due_on: '5 décembre 2026',
      link: 'https://ksp.bj/recouvrement/abc',
    },
    'recovery.debtor_formal_notice': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      amount_due: `500${NBSP}000${NBSP}FCFA`,
      deadline_days: '15',
      link: 'https://ksp.bj/recouvrement/abc',
    },
    'recovery.debtor_settlement_certificate': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      link: 'https://ksp.bj/recouvrement/abc',
    },
    'recovery.debtor_dispute_received': {
      creditor_name: 'SARL Bénin Propre',
      case_number: 'RC-000123',
      link: 'https://ksp.bj/recouvrement/abc',
    },
  };

  it('tous secrets, réservés à l’envoi direct, par WhatsApp puis e-mail', () => {
    expect(RECOVERY_DIRECT_TEMPLATES.map((template) => template.code).sort()).toEqual(
      Object.keys(VARIABLES).sort(),
    );
    for (const template of RECOVERY_DIRECT_TEMPLATES) {
      expect(template.secret).toBe(true);
      expect(isEventTemplate(template)).toBe(false);
      expect(template.channels).toEqual(['whatsapp', 'email']);
    }
  });

  it.each(Object.keys(VARIABLES))('%s : variables valides, texte complet, modèle WhatsApp', (code) => {
    const template = findTemplate(code)!;
    const variables = VARIABLES[code]!;
    expect(invalidVariables(template, variables)).toEqual([]);
    expect(template.render!(variables).text).not.toMatch(/undefined|\{\w+\}/);
    if (code !== 'recovery.debtor_access_code') {
      const whatsapp = WHATSAPP_EVENT_TEMPLATES[code]!;
      // Sans nom du débiteur : « Madame, Monsieur » (Meta refuse un paramètre vide).
      expect(whatsapp.parameters(variables)[0]).toBe('Madame, Monsieur');
      expect(whatsapp.parameters(variables).every((parameter) => parameter.trim() !== '')).toBe(true);
    }
  });

  it('chaque message qui porte le lien dit pour le compte de qui et comment contester (R-DB-02)', () => {
    const notice = findTemplate('recovery.debtor_mandate_notice')!.render!(
      VARIABLES['recovery.debtor_mandate_notice']!,
    ).text;
    expect(notice).toContain('pour le compte de SARL Bénin Propre');
    expect(notice).toContain('vous pouvez le contester depuis ce lien');
    expect(notice).toContain('vos coordonnées');
  });

  it.each(Object.keys(VARIABLES).filter((code) => code !== 'recovery.debtor_access_code'))(
    '%s : dit qui écrit, pour le compte de qui, et le recours du débiteur',
    (code) => {
      const text = findTemplate(code)!.render!(VARIABLES[code]!).text;
      expect(text).toContain('Groupe KSP');
      expect(text).toContain('SARL Bénin Propre');
      if (code !== 'recovery.debtor_settlement_certificate' && code !== 'recovery.debtor_dispute_received') {
        expect(text).toMatch(/contester depuis ce lien|Une question ou un désaccord/);
      }
    },
  );

  it('code d’accès : jamais dans l’objet de l’e-mail', () => {
    const rendered = findTemplate('recovery.debtor_access_code')!.render!(
      VARIABLES['recovery.debtor_access_code']!,
    );
    expect(rendered.subject).not.toContain('482913');
    expect(rendered.text).toContain('482913');
  });
});
