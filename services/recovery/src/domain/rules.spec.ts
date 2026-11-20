import {
  type ContactWindow,
  contactWindowProblems,
  isAllowedRecipient,
  isWithinContactWindow,
  nextContactInstant,
} from './contact-policy';
import {
  attemptsLeft,
  checkAttemptAllowed,
  checkLink,
  issueLink,
  NO_ATTEMPTS,
  registerFailure,
  registerSuccess,
  retryAfterSeconds,
  sessionExpiry,
} from './debtor-access';
import {
  creditorApprovalDeadline,
  disputeAnswerDeadline,
  feePaymentDeadline,
  infoCompletionDeadline,
  partnerTransferDeadline,
  prescriptionDate,
  prescriptionState,
  remittanceDeadline,
  reviewDeadline,
  stageDeadline,
} from './deadlines';
import { answerDecision, decisionDays, expireDecision, openDecision } from './decision';
import { creditorAnswered, isOpen, noteCreditorSilence, openDispute, resolveDispute } from './dispute';
import { payOrderEligibility } from './eligibility';
import {
  canTransitionPartner,
  isPartnerSilent,
  type PartnerProfile,
  successRateBp,
  suggestPartners,
} from './partner';
import { brokenPromiseFollowUpDay, cancelPromise, evaluatePromise, newPromise } from './promise';
import { DEFAULT_SCORE_SETTINGS, recoverabilityScore, scoreSettingsProblems } from './score';
import { DEFAULT_SETTINGS, FIXED_RULES, mergeSettings, settingsProblems } from './settings';

const NO_HOLIDAYS = new Set<string>();
const at = (iso: string) => new Date(iso);

describe('réglages (17.1, RecoverySettings)', () => {
  it('valide les réglages par défaut et leurs bornes', () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([]);
    const wrong = mergeSettings(DEFAULT_SETTINGS, {
      amicableDurationDays: 5,
      contactWindow: { start: '19:00', end: '08:00', days: [1] },
      minimumCaseAmount: undefined,
    });
    expect(wrong.minimumCaseAmount).toBe(25_000);
    expect(settingsProblems(wrong)).toEqual([
      'amicableDurationDays doit être un entier de 7 à 90',
      'contactWindow : la fin suit le début',
    ]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, feePaymentDays: 2.5 })).toHaveLength(1);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, debtorSessionMinutes: 121 })).toHaveLength(1);
  });

  it('valide une plage de contact', () => {
    expect(contactWindowProblems(DEFAULT_SETTINGS.contactWindow)).toEqual([]);
    expect(contactWindowProblems({ start: '8h', end: '19:00', days: [] })).toEqual([
      'heures au format HH:MM',
      'au moins un jour',
    ]);
    expect(contactWindowProblems({ start: '08:00', end: '19:00', days: [1, 1] })).toEqual([
      'jours en double',
    ]);
    expect(contactWindowProblems({ start: '08:00', end: '19:00', days: [0] })).toEqual([
      'jours ISO de 1 à 7',
    ]);
  });
});

describe('délais et prescription', () => {
  it('examine un dossier sous 2 jours ouvrés, jusqu’à la fin du jour', () => {
    expect(reviewDeadline(at('2026-11-20T15:00:00Z'), DEFAULT_SETTINGS, NO_HOLIDAYS).toISOString()).toBe(
      '2026-11-24T22:59:00.000Z',
    );
  });

  it('reverse au créancier et attend le virement du partenaire sous 5 jours ouvrés', () => {
    expect(remittanceDeadline(at('2026-11-20T15:00:00Z'), DEFAULT_SETTINGS, new Set(['2026-11-25']))).toBe(
      '2026-11-30',
    );
    expect(
      partnerTransferDeadline(
        at('2026-11-20T15:00:00Z'),
        FIXED_RULES.partnerTransferBusinessDays,
        NO_HOLIDAYS,
      ),
    ).toBe('2026-11-27');
  });

  it('calcule les délais en jours civils', () => {
    const start = at('2026-11-20T10:00:00Z');
    expect(feePaymentDeadline(start, DEFAULT_SETTINGS).toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(infoCompletionDeadline(start, DEFAULT_SETTINGS).toISOString()).toBe('2026-12-05T10:00:00.000Z');
    expect(creditorApprovalDeadline(start, DEFAULT_SETTINGS).toISOString()).toBe('2026-12-05T10:00:00.000Z');
    expect(disputeAnswerDeadline(start, DEFAULT_SETTINGS).toISOString()).toBe('2026-11-30T10:00:00.000Z');
    expect(stageDeadline('notice', start, DEFAULT_SETTINGS)?.toISOString()).toBe('2026-11-28T10:00:00.000Z');
    expect(stageDeadline('amicable', start, DEFAULT_SETTINGS)?.toISOString()).toBe(
      '2026-12-11T10:00:00.000Z',
    );
    expect(stageDeadline('formal_notice', start, DEFAULT_SETTINGS)?.toISOString()).toBe(
      '2026-12-05T10:00:00.000Z',
    );
    expect(stageDeadline('bailiff', start, DEFAULT_SETTINGS)).toBeNull();
  });

  it('date la prescription et alerte 90 jours avant', () => {
    expect(prescriptionDate('2024-03-31', 24)).toBe('2026-03-31');
    expect(prescriptionDate('2024-03-31', 24, '2025-01-10')).toBe('2027-01-10');
    expect(prescriptionDate('2024-03-31', 24, '2023-01-10')).toBe('2026-03-31');
    expect(prescriptionState('2027-03-01', '2026-11-20', 90)).toBe('running');
    expect(prescriptionState('2027-01-15', '2026-11-20', 90)).toBe('alert');
    expect(prescriptionState('2026-11-20', '2026-11-20', 90)).toBe('prescribed');
  });
});

describe('règles de contact', () => {
  const window: ContactWindow = DEFAULT_SETTINGS.contactWindow;

  it('contacte de 8 h à 19 h, du lundi au samedi, heure du Bénin', () => {
    expect(isWithinContactWindow(at('2026-11-20T07:00:00Z'), window)).toBe(true); // vendredi 8 h
    expect(isWithinContactWindow(at('2026-11-20T06:59:00Z'), window)).toBe(false);
    expect(isWithinContactWindow(at('2026-11-20T18:00:00Z'), window)).toBe(false); // 19 h
    expect(isWithinContactWindow(at('2026-11-22T10:00:00Z'), window)).toBe(false); // dimanche
    expect(isWithinContactWindow(at('2026-11-22T10:00:00Z'), { ...window, days: [7] })).toBe(true);
  });

  it('reporte au prochain instant permis', () => {
    const inside = at('2026-11-20T10:00:00Z');
    expect(nextContactInstant(inside, window)).toBe(inside);
    expect(nextContactInstant(at('2026-11-20T05:00:00Z'), window).toISOString()).toBe(
      '2026-11-20T07:00:00.000Z',
    );
    expect(nextContactInstant(at('2026-11-21T19:00:00Z'), window).toISOString()).toBe(
      '2026-11-23T07:00:00.000Z',
    );
    expect(nextContactInstant(at('2026-11-20T05:00:00Z'), { ...window, start: '08:30' }).toISOString()).toBe(
      '2026-11-20T07:30:00.000Z',
    );
    expect(() => nextContactInstant(inside, { ...window, days: [] })).toThrow(RangeError);
  });

  it('ne contacte jamais l’employeur ni les voisins', () => {
    expect(isAllowedRecipient('debtor')).toBe(true);
    expect(isAllowedRecipient('guarantor')).toBe(true);
    expect(isAllowedRecipient('employer')).toBe(false);
    expect(isAllowedRecipient('neighbour')).toBe(false);
  });
});

describe('injonction de payer', () => {
  const input = {
    nature: 'unpaid_invoice' as const,
    disputed: false,
    hasEvidence: true,
    amountDetermined: true,
    dueDay: '2026-09-30',
    today: '2026-11-20',
  };

  it('propose l’injonction pour une créance certaine, liquide et exigible', () => {
    expect(payOrderEligibility(input)).toEqual({ eligible: true, unmet: [] });
    expect(payOrderEligibility({ ...input, nature: 'acknowledgment_of_debt' }).eligible).toBe(true);
  });

  it('liste les critères non réunis', () => {
    expect(
      payOrderEligibility({
        ...input,
        nature: 'other',
        disputed: true,
        amountDetermined: false,
        dueDay: '2026-12-01',
      }),
    ).toEqual({ eligible: false, unmet: ['certain', 'liquid', 'due', 'origin'] });
    expect(payOrderEligibility({ ...input, hasEvidence: false }).unmet).toEqual(['certain']);
  });
});

describe('accès du débiteur (partie 7, ADR-061)', () => {
  const now = at('2026-11-20T10:00:00Z');
  const options = {
    maxAttempts: FIXED_RULES.debtorCodeMaxAttempts,
    lockMinutes: FIXED_RULES.debtorLockMinutes,
  };

  it('ouvre un lien valable 30 jours ; expiré ou révoqué, le même refus qu’un lien inconnu', () => {
    const link = issueLink(now, DEFAULT_SETTINGS.debtorLinkDays);
    expect(link.expiresAt.toISOString()).toBe('2026-12-20T10:00:00.000Z');
    expect(checkLink(link, at('2026-12-20T09:59:00Z')).ok).toBe(true);
    expect(checkLink(link, at('2026-12-20T10:00:00Z'))).toMatchObject({
      code: 'RECOVERY_DEBTOR_LINK_INVALID',
    });
    expect(checkLink({ ...link, revokedAt: now }, now)).toMatchObject({
      code: 'RECOVERY_DEBTOR_LINK_INVALID',
    });
  });

  it('bloque une heure après 5 codes faux, puis remet le compteur à zéro', () => {
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < 4; i += 1) attempts = registerFailure(attempts, now, options);
    expect(attempts).toEqual({ failures: 4, lockedUntil: null });
    expect(attemptsLeft(attempts, options.maxAttempts)).toBe(1);
    expect(checkAttemptAllowed(attempts, now)).toEqual({ ok: true, value: attempts });
    attempts = registerFailure(attempts, now, options);
    expect(attempts.lockedUntil?.toISOString()).toBe('2026-11-20T11:00:00.000Z');
    expect(attemptsLeft(attempts, options.maxAttempts)).toBe(0);
    expect(checkAttemptAllowed(attempts, at('2026-11-20T10:59:00Z'))).toMatchObject({
      code: 'RECOVERY_DEBTOR_LOCKED',
    });
    expect(retryAfterSeconds(attempts, at('2026-11-20T10:59:30Z'))).toBe(30);
    expect(retryAfterSeconds(attempts, at('2026-11-20T11:00:00Z'))).toBe(0);
    expect(checkAttemptAllowed(attempts, at('2026-11-20T11:00:00Z'))).toEqual({
      ok: true,
      value: NO_ATTEMPTS,
    });
    expect(registerSuccess()).toEqual(NO_ATTEMPTS);
  });

  it('ouvre une session de 30 minutes', () => {
    expect(sessionExpiry(now, DEFAULT_SETTINGS.debtorSessionMinutes).toISOString()).toBe(
      '2026-11-20T10:30:00.000Z',
    );
  });
});

describe('décisions du créancier (UC-RC-06, 07)', () => {
  const now = at('2026-11-20T10:00:00Z');

  it('donne à chaque décision son délai', () => {
    expect(decisionDays('plan_off_scale', DEFAULT_SETTINGS)).toBe(3);
    expect(decisionDays('settlement_discount', DEFAULT_SETTINGS)).toBe(3);
    expect(decisionDays('dispute_response', DEFAULT_SETTINGS)).toBe(10);
    expect(decisionDays('bailiff_escalation', DEFAULT_SETTINGS)).toBe(15);
    expect(decisionDays('stage_skip', DEFAULT_SETTINGS)).toBe(15);
  });

  it('se prend une seule fois, avant son échéance', () => {
    const skip = openDecision('stage_skip', now, DEFAULT_SETTINGS);
    expect(skip.expiresAt.toISOString()).toBe('2026-12-05T10:00:00.000Z');
    const approved = answerDecision(skip, 'approve', now);
    expect(approved).toMatchObject({ ok: true, value: { status: 'approved' } });
    if (approved.ok)
      expect(answerDecision(approved.value, 'reject', now)).toMatchObject({
        code: 'RECOVERY_DECISION_CLOSED',
      });
    expect(answerDecision(skip, 'reject', at('2026-12-05T10:00:00Z'))).toMatchObject({
      code: 'RECOVERY_DECISION_CLOSED',
    });
    expect(answerDecision(skip, 'answer', now)).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
    const dispute = openDecision('dispute_response', now, DEFAULT_SETTINGS);
    expect(answerDecision(dispute, 'answer', now)).toMatchObject({ ok: true, value: { status: 'answered' } });
    expect(answerDecision(dispute, 'approve', now)).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });

  it('expire sans réponse : refus, abandon du dossier ou décision du juriste', () => {
    const later = at('2026-12-31T10:00:00Z');
    expect(expireDecision(openDecision('plan_off_scale', now, DEFAULT_SETTINGS), now)).toBeNull();
    expect(expireDecision(openDecision('plan_off_scale', now, DEFAULT_SETTINGS), later)).toMatchObject({
      decision: { status: 'expired' },
      effect: 'refused',
    });
    expect(expireDecision(openDecision('litigation_escalation', now, DEFAULT_SETTINGS), later)?.effect).toBe(
      'abandon_case',
    );
    expect(expireDecision(openDecision('dispute_response', now, DEFAULT_SETTINGS), later)?.effect).toBe(
      'legal_officer_decides',
    );
  });
});

describe('score de recouvrabilité (R-SD-07)', () => {
  it('donne 100 au meilleur dossier', () => {
    const score = recoverabilityScore(
      {
        debtAgeDays: 30,
        writtenAcknowledgment: true,
        evidenceQuality: 'strong',
        amountDue: 300_000,
        validContactCount: 3,
        partialPaymentsMade: true,
      },
      DEFAULT_SCORE_SETTINGS,
    );
    expect(score.value).toBe(100);
  });

  const old = {
    debtAgeDays: 400,
    writtenAcknowledgment: false,
    evidenceQuality: 'medium' as const,
    amountDue: 8_000_000,
    validContactCount: 1,
    partialPaymentsMade: false,
  };

  it('pondère un dossier ancien, sans reconnaissance ni contact', () => {
    // 30×25 + 0 + 60×20 + 40×10 + 50×15 + 0 = 3 100 → 31
    expect(recoverabilityScore(old, DEFAULT_SCORE_SETTINGS)).toEqual({
      value: 31,
      breakdown: {
        debtAge: 30,
        writtenAcknowledgment: 0,
        evidenceQuality: 60,
        amount: 40,
        validContacts: 50,
        partialPayments: 0,
      },
    });
  });

  it('ramène la somme des poids à 100', () => {
    const weights = DEFAULT_SCORE_SETTINGS.weights;
    const doubled = {
      debtAge: weights.debtAge * 2,
      writtenAcknowledgment: weights.writtenAcknowledgment * 2,
      evidenceQuality: weights.evidenceQuality * 2,
      amount: weights.amount * 2,
      validContacts: weights.validContacts * 2,
      partialPayments: weights.partialPayments * 2,
    };
    expect(recoverabilityScore(old, { ...DEFAULT_SCORE_SETTINGS, weights: doubled }).value).toBe(31);
    const none = {
      debtAge: 0,
      writtenAcknowledgment: 0,
      evidenceQuality: 0,
      amount: 0,
      validContacts: 0,
      partialPayments: 0,
    };
    expect(recoverabilityScore(old, { ...DEFAULT_SCORE_SETTINGS, weights: none }).value).toBe(0);
  });

  it('valide les réglages du score', () => {
    expect(scoreSettingsProblems(DEFAULT_SCORE_SETTINGS)).toEqual([]);
    expect(
      scoreSettingsProblems({
        ...DEFAULT_SCORE_SETTINGS,
        weights: { ...DEFAULT_SCORE_SETTINGS.weights, debtAge: 101 },
        evidencePoints: { strong: 120, medium: 60, weak: 20 },
        amountSteps: [{ upTo: 10, points: 50 }],
        contactsForFullPoints: 0,
      }),
    ).toHaveLength(4);
  });
});

describe('partenaires (partie 8)', () => {
  const partner = (id: string, overrides: Partial<PartnerProfile> = {}): PartnerProfile => ({
    id,
    kind: 'bailiff',
    status: 'active',
    areas: ['cotonou'],
    openAssignments: 3,
    closedAssignments: 10,
    successfulAssignments: 6,
    averageDays: 40,
    ...overrides,
  });

  it('propose le moins chargé, puis le plus efficace, puis le plus rapide (R-HU-02)', () => {
    const partners = [
      partner('busy', { openAssignments: 9 }),
      partner('good', { successfulAssignments: 9 }),
      partner('average'),
      partner('slow', { averageDays: 90 }),
      partner('new', { closedAssignments: 0, successfulAssignments: 0, averageDays: null }),
      partner('far', { areas: ['parakou'], openAssignments: 0 }),
      partner('lawyer', { kind: 'lawyer', openAssignments: 0 }),
      partner('off', { status: 'suspended', openAssignments: 0 }),
    ];
    expect(suggestPartners(partners, 'bailiff', 'cotonou').map((p) => p.id)).toEqual([
      'good',
      'average',
      'slow',
      'new',
      'busy',
    ]);
  });

  it('calcule le taux de succès, neutre sans historique', () => {
    expect(successRateBp(partner('a'))).toBe(6_000);
    expect(successRateBp(partner('b', { closedAssignments: 0 }))).toBe(5_000);
  });

  it('active un partenaire seulement après vérification', () => {
    expect(canTransitionPartner('pending_verification', 'active')).toBe(true);
    expect(canTransitionPartner('pending_verification', 'suspended')).toBe(false);
    expect(canTransitionPartner('suspended', 'active')).toBe(true);
  });

  it('alerte le juriste après 15 jours sans mise à jour (R-HU-04)', () => {
    const days = DEFAULT_SETTINGS.partnerSilenceAlertDays;
    expect(isPartnerSilent(at('2026-11-05T10:00:00Z'), at('2026-11-20T09:00:00Z'), days)).toBe(false);
    expect(isPartnerSilent(at('2026-11-05T10:00:00Z'), at('2026-11-20T10:00:00Z'), days)).toBe(true);
  });
});

describe('promesses (R-PR-09)', () => {
  it('tient, rompt et relance le lendemain', () => {
    const promise = newPromise(50_000, '2026-11-30', '2026-11-20');
    if (!promise.ok) throw new Error(promise.reason);
    expect(evaluatePromise(promise.value, 20_000, '2026-11-30')).toBe('pending');
    expect(evaluatePromise(promise.value, 50_000, '2026-11-29')).toBe('kept');
    expect(evaluatePromise(promise.value, 20_000, '2026-12-01')).toBe('broken');
    expect(evaluatePromise({ ...promise.value, status: 'kept' }, 0, '2026-12-05')).toBe('kept');
    expect(brokenPromiseFollowUpDay(promise.value)).toBe('2026-12-01');
  });

  it('annule une promesse en attente seulement', () => {
    const promise = newPromise(50_000, '2026-11-30', '2026-11-20');
    if (!promise.ok) throw new Error(promise.reason);
    expect(cancelPromise(promise.value)).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(cancelPromise({ ...promise.value, status: 'kept' })).toMatchObject({
      code: 'RECOVERY_INVALID_TRANSITION',
    });
  });

  it('refuse un montant nul ou une date passée', () => {
    expect(newPromise(0, '2026-11-30', '2026-11-20').ok).toBe(false);
    expect(newPromise(10_000, '2026-11-19', '2026-11-20').ok).toBe(false);
  });
});

describe('contestation (R-PR-02)', () => {
  const now = at('2026-11-20T10:00:00Z');

  it('attend le créancier 10 jours, puis note son silence pour le juriste', () => {
    const dispute = openDispute('already_paid', now, DEFAULT_SETTINGS.disputeAnswerDays);
    expect(dispute.creditorAnswerDueAt.toISOString()).toBe('2026-11-30T10:00:00.000Z');
    expect(noteCreditorSilence(dispute, at('2026-11-29T10:00:00Z'))).toBe(dispute);
    expect(noteCreditorSilence(dispute, at('2026-11-30T10:00:00Z'))).toMatchObject({
      status: 'open',
      creditorSilent: true,
    });
    const answered = creditorAnswered(dispute);
    expect(answered).toMatchObject({
      ok: true,
      value: { status: 'creditor_answered', creditorSilent: false },
    });
    if (answered.ok) {
      expect(creditorAnswered(answered.value)).toMatchObject({ code: 'RECOVERY_DECISION_CLOSED' });
      expect(noteCreditorSilence(answered.value, at('2026-12-30T10:00:00Z'))).toBe(answered.value);
    }
  });

  it('tranche une seule fois : reprise (rejetée), correction ou clôture (fondée)', () => {
    const dispute = openDispute('wrong_amount', now, 10);
    expect(resolveDispute(dispute, 'resume')).toMatchObject({ ok: true, value: { status: 'rejected' } });
    expect(resolveDispute(dispute, 'correct_amount')).toMatchObject({
      ok: true,
      value: { status: 'amount_corrected' },
    });
    const upheld = resolveDispute(dispute, 'close');
    expect(upheld).toMatchObject({ ok: true, value: { status: 'upheld' } });
    if (upheld.ok) {
      expect(isOpen(upheld.value)).toBe(false);
      expect(resolveDispute(upheld.value, 'resume')).toMatchObject({ code: 'RECOVERY_DECISION_CLOSED' });
    }
  });
});
