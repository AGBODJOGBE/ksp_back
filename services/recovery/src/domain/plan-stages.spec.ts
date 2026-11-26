import { type CaseStage, type CaseState } from './case';
import {
  nextProgression,
  PLAN_STAGES,
  planDefaultedMove,
  planDefaultStage,
  planSignedMove,
} from './progression';
import { DEFAULT_SETTINGS } from './settings';

function state(
  stage: CaseStage | null,
  highestStage: CaseStage | null = stage,
  status: CaseState['status'] = 'active',
): CaseState {
  return { kind: 'b2c', status, stage, highestStage, closureReason: null, rejectionReason: null };
}

describe('échéancier après la mise en demeure (6.1)', () => {
  it('un échéancier se négocie aussi à l’étape de la mise en demeure, jamais chez l’huissier', () => {
    expect(PLAN_STAGES).toEqual(['notice', 'payment_plan', 'amicable', 'formal_notice']);
    expect(PLAN_STAGES).not.toContain('bailiff');
  });

  it('signé à la mise en demeure : retour à l’échéancier, la mise en demeure reste l’étape atteinte', () => {
    const move = planSignedMove(state('formal_notice'));
    expect(move).toEqual({
      ok: true,
      value: {
        state: { ...state('formal_notice'), stage: 'payment_plan', highestStage: 'formal_notice' },
        change: { from: 'formal_notice', to: 'payment_plan', skipped: false, skipReason: null },
      },
    });
  });

  it('signé à la notification ou en relance amiable : passage ordinaire ; renégocié : rien ne change', () => {
    const fromNotice = planSignedMove(state('notice'));
    expect(fromNotice.ok && fromNotice.value?.state).toMatchObject({
      stage: 'payment_plan',
      highestStage: 'payment_plan',
    });
    const fromAmicable = planSignedMove(state('amicable'));
    expect(fromAmicable.ok && fromAmicable.value?.change).toMatchObject({
      from: 'amicable',
      to: 'payment_plan',
    });
    expect(planSignedMove(state('payment_plan', 'amicable'))).toEqual({ ok: true, value: null });
  });

  it('refusé à l’huissier, au judiciaire, ou sur un dossier qui n’est pas actif', () => {
    for (const refused of [
      state('bailiff'),
      state('litigation'),
      state('formal_notice', 'formal_notice', 'suspended'),
    ]) {
      expect(planSignedMove(refused)).toMatchObject({ ok: false, code: 'RECOVERY_INVALID_TRANSITION' });
    }
  });

  it('rompu : relance amiable, ou retour à la mise en demeure déjà faite', () => {
    expect(planDefaultStage(state('payment_plan', 'payment_plan'))).toBe('amicable');
    expect(planDefaultStage(state('payment_plan', 'formal_notice'))).toBe('formal_notice');

    const toAmicable = planDefaultedMove(state('payment_plan', 'payment_plan'));
    expect(toAmicable.ok && toAmicable.value?.change).toMatchObject({ from: 'payment_plan', to: 'amicable' });
    const back = planDefaultedMove(state('payment_plan', 'formal_notice'));
    expect(back.ok && back.value).toEqual({
      state: { ...state('payment_plan', 'formal_notice'), stage: 'formal_notice' },
      change: { from: 'payment_plan', to: 'formal_notice', skipped: false, skipReason: null },
    });
    // Plus à l'étape échéancier (dossier suspendu ou déjà repassé) : rien à faire.
    expect(planDefaultedMove(state('amicable'))).toEqual({ ok: true, value: null });
    expect(planDefaultedMove(state('payment_plan', 'payment_plan', 'suspended'))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('avancement : l’huissier n’est pas proposé tant qu’un échéancier est en cours d’accord', () => {
    const context = {
      stageStartedAt: new Date('2026-11-01T10:00:00Z'),
      now: new Date('2026-12-20T10:00:00Z'),
      planProgress: null,
      settings: DEFAULT_SETTINGS,
    };
    expect(nextProgression({ ...context, state: state('formal_notice'), planPending: true })).toEqual({
      kind: 'none',
    });
    expect(nextProgression({ ...context, state: state('formal_notice'), planPending: false })).toEqual({
      kind: 'propose',
      to: 'bailiff',
      decidedBy: 'creditor',
    });
    expect(
      nextProgression({
        ...context,
        state: state('payment_plan', 'formal_notice'),
        planPending: false,
        planProgress: 'defaulted',
      }),
    ).toEqual({ kind: 'advance', to: 'formal_notice' });
  });
});
