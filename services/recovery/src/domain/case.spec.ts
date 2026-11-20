import {
  advanceStage,
  type CaseState,
  canTransitionStatus,
  changeStatus,
  close,
  isCommissionDueOnDirectPayment,
  isUnrecoverableForLackOfContact,
  newCase,
  reject,
  requestStageSkip,
  requiresCreditorApproval,
  type SkipContext,
  skipStage,
  stageGroup,
} from './case';
import { type Outcome } from './outcome';

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.code} : ${outcome.reason}`);
  return outcome.value;
}

function codeOf<T>(outcome: Outcome<T>): string | null {
  return outcome.ok ? null : outcome.code;
}

function activeCase(): CaseState {
  let state = newCase('b2b');
  state = value(changeStatus(state, 'awaiting_fee'));
  state = value(changeStatus(state, 'under_review'));
  return value(changeStatus(state, 'active'));
}

const SKIP: SkipContext = {
  reason: 'prescription_near',
  prescriptionDate: '2027-01-15',
  today: '2026-11-20',
  prescriptionNearDays: 90,
};

describe('dossier : statuts (16.3)', () => {
  it('suit le circuit brouillon → frais → examen → actif, à l’étape de notification du mandat', () => {
    const state = activeCase();
    expect(state).toMatchObject({ status: 'active', stage: 'notice', highestStage: 'notice' });
  });

  it('refuse un passage hors du circuit', () => {
    expect(codeOf(changeStatus(newCase('b2c'), 'active'))).toBe('RECOVERY_INVALID_TRANSITION');
    expect(canTransitionStatus('closed', 'active')).toBe(false);
  });

  it('va et vient entre examen et complément demandé', () => {
    let state = value(changeStatus(value(changeStatus(newCase('b2c'), 'awaiting_fee')), 'under_review'));
    state = value(changeStatus(state, 'info_requested'));
    state = value(changeStatus(state, 'under_review'));
    expect(state.status).toBe('under_review');
  });

  it('refuse un dossier irrecevable, ou classe un dossier resté incomplet', () => {
    const review = value(changeStatus(value(changeStatus(newCase('b2c'), 'awaiting_fee')), 'under_review'));
    expect(value(reject(review, 'no_evidence')).rejectionReason).toBe('no_evidence');
    expect(codeOf(reject(review, 'incomplete'))).toBe('RECOVERY_INVALID_TRANSITION');
    const waiting = value(changeStatus(review, 'info_requested'));
    expect(value(reject(waiting, 'incomplete')).status).toBe('rejected');
    expect(codeOf(reject(activeCase(), 'prescribed'))).toBe('RECOVERY_INVALID_TRANSITION');
  });

  it('n’active pas encore un dossier de loyers (procédure locative au lot G)', () => {
    let state = newCase('rent');
    state = value(changeStatus(value(changeStatus(state, 'awaiting_fee')), 'under_review'));
    expect(codeOf(changeStatus(state, 'active'))).toBe('RECOVERY_INVALID_TRANSITION');
  });

  it('suspend et reprend un dossier sans perdre son étape', () => {
    const suspended = value(changeStatus(activeCase(), 'suspended'));
    const resumed = value(changeStatus(suspended, 'active'));
    expect(resumed).toMatchObject({ status: 'active', stage: 'notice' });
  });

  it('clôt un dossier ; « contestation fondée » seulement s’il est suspendu (R-PR-02, R-PR-10)', () => {
    expect(value(close(activeCase(), 'paid'))).toMatchObject({ status: 'closed', closureReason: 'paid' });
    expect(codeOf(close(activeCase(), 'dispute_upheld'))).toBe('RECOVERY_INVALID_TRANSITION');
    const suspended = value(changeStatus(activeCase(), 'suspended'));
    expect(value(close(suspended, 'dispute_upheld')).closureReason).toBe('dispute_upheld');
    expect(codeOf(close(newCase('b2b'), 'paid'))).toBe('RECOVERY_INVALID_TRANSITION');
  });
});

describe('dossier : étapes (partie 5)', () => {
  it('passe de la notification à la relance amiable, puis à la mise en demeure', () => {
    const amicable = value(advanceStage(activeCase(), 'amicable'));
    expect(amicable.change).toEqual({ from: 'notice', to: 'amicable', skipped: false, skipReason: null });
    const notice = value(advanceStage(amicable.state, 'formal_notice'));
    expect(notice.state).toMatchObject({ stage: 'formal_notice', highestStage: 'formal_notice' });
  });

  it('garde l’étape la plus avancée quand l’échéancier est renégocié en relance amiable', () => {
    const amicable = value(advanceStage(activeCase(), 'amicable')).state;
    const plan = value(advanceStage(amicable, 'payment_plan')).state;
    expect(plan).toMatchObject({ stage: 'payment_plan', highestStage: 'amicable' });
  });

  it('refuse un passage hors de l’ordre et un dossier inactif', () => {
    expect(codeOf(advanceStage(activeCase(), 'bailiff'))).toBe('RECOVERY_INVALID_TRANSITION');
    expect(codeOf(advanceStage(newCase('b2b'), 'amicable'))).toBe('RECOVERY_INVALID_TRANSITION');
  });

  it('exige l’accord du créancier pour l’huissier et le judiciaire (R-PR-04)', () => {
    let state = value(advanceStage(activeCase(), 'amicable')).state;
    state = value(advanceStage(state, 'formal_notice')).state;
    expect(codeOf(advanceStage(state, 'bailiff'))).toBe('RECOVERY_CREDITOR_APPROVAL_REQUIRED');
    state = value(advanceStage(state, 'bailiff', true)).state;
    expect(value(advanceStage(state, 'litigation', true)).state.stage).toBe('litigation');
    expect(requiresCreditorApproval('formal_notice')).toBe(false);
  });
});

describe('dossier : saut d’étape tracé (R-PR-03)', () => {
  it('demande le saut (décision stage_skip), puis l’exécute à l’accord du créancier', () => {
    expect(value(requestStageSkip(activeCase(), 'formal_notice', SKIP))).toEqual({
      from: 'notice',
      to: 'formal_notice',
      reason: 'prescription_near',
    });
    const move = value(skipStage(activeCase(), 'formal_notice', SKIP, true));
    expect(move.change).toEqual({
      from: 'notice',
      to: 'formal_notice',
      skipped: true,
      skipReason: 'prescription_near',
    });
  });

  it('saute à l’huissier en cas de risque de disparition des biens', () => {
    const move = value(
      skipStage(
        activeCase(),
        'bailiff',
        { ...SKIP, reason: 'asset_flight_risk', prescriptionDate: null },
        true,
      ),
    );
    expect(move.state.highestStage).toBe('bailiff');
  });

  it('refuse un saut sans accord, sans prescription proche, ou vers une étape non permise', () => {
    expect(codeOf(skipStage(activeCase(), 'formal_notice', SKIP, false))).toBe(
      'RECOVERY_CREDITOR_APPROVAL_REQUIRED',
    );
    expect(
      codeOf(requestStageSkip(activeCase(), 'formal_notice', { ...SKIP, prescriptionDate: '2027-06-01' })),
    ).toBe('RECOVERY_STAGE_SKIP_NOT_ALLOWED');
    expect(codeOf(requestStageSkip(activeCase(), 'formal_notice', { ...SKIP, prescriptionDate: null }))).toBe(
      'RECOVERY_STAGE_SKIP_NOT_ALLOWED',
    );
    expect(codeOf(requestStageSkip(activeCase(), 'litigation', SKIP))).toBe(
      'RECOVERY_STAGE_SKIP_NOT_ALLOWED',
    );
    expect(codeOf(requestStageSkip(activeCase(), 'amicable', SKIP))).toBe('RECOVERY_STAGE_SKIP_NOT_ALLOWED');
    expect(codeOf(skipStage(newCase('b2b'), 'bailiff', SKIP, true))).toBe('RECOVERY_INVALID_TRANSITION');
  });
});

describe('dossier : règles transverses', () => {
  it('range les étapes en groupes de la commission par étape (ADR-062)', () => {
    expect(stageGroup(null)).toBe('amicable');
    expect(stageGroup('payment_plan')).toBe('amicable');
    expect(stageGroup('formal_notice')).toBe('formal_notice');
    expect(stageGroup('bailiff')).toBe('litigation');
    expect(stageGroup('litigation')).toBe('litigation');
  });

  it('commissionne un paiement direct reçu dans les 30 jours de l’arrêt (R-PR-06, R-PR-07)', () => {
    const stoppedAt = new Date('2026-11-01T10:00:00Z');
    expect(isCommissionDueOnDirectPayment(null, new Date('2026-11-05T10:00:00Z'), 30)).toBe(true);
    expect(isCommissionDueOnDirectPayment(stoppedAt, new Date('2026-12-01T10:00:00Z'), 30)).toBe(true);
    expect(isCommissionDueOnDirectPayment(stoppedAt, new Date('2026-12-01T10:00:01Z'), 30)).toBe(false);
  });

  it('classe irrecouvrable après 6 mois sans contact possible (R-PR-10)', () => {
    const last = new Date('2026-05-20T10:00:00Z');
    expect(isUnrecoverableForLackOfContact(last, new Date('2026-11-19T10:00:00Z'), 6)).toBe(false);
    expect(isUnrecoverableForLackOfContact(last, new Date('2026-11-20T10:00:00Z'), 6)).toBe(true);
    // Fin de mois : 31 août + 6 mois = 28 février, pas 3 mars.
    const endOfMonth = new Date('2026-08-31T10:00:00Z');
    expect(isUnrecoverableForLackOfContact(endOfMonth, new Date('2027-02-27T10:00:00Z'), 6)).toBe(false);
    expect(isUnrecoverableForLackOfContact(endOfMonth, new Date('2027-02-28T10:00:00Z'), 6)).toBe(true);
  });
});
