import { type CaseState } from './case';
import { amicableStepsDue, nextProgression, type ProgressionContext } from './progression';
import { DEFAULT_SETTINGS } from './settings';

const START = new Date('2026-11-01T10:00:00Z');

function state(stage: CaseState['stage'], status: CaseState['status'] = 'active'): CaseState {
  return { kind: 'b2c', status, stage, highestStage: stage, closureReason: null, rejectionReason: null };
}

function context(overrides: Partial<ProgressionContext>): ProgressionContext {
  return {
    state: state('notice'),
    stageStartedAt: START,
    now: new Date('2026-11-20T10:00:00Z'),
    planPending: false,
    planProgress: null,
    settings: DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe('avancement automatique (UC-RC-26)', () => {
  it('passe en relance amiable sans réponse 8 jours après la notification', () => {
    expect(nextProgression(context({}))).toEqual({ kind: 'advance', to: 'amicable' });
    expect(nextProgression(context({ now: new Date('2026-11-09T09:00:00Z') }))).toEqual({ kind: 'none' });
    // Un échéancier en cours d'accord retient le dossier ; une simple réponse sans échéancier, non.
    expect(nextProgression(context({ planPending: true }))).toEqual({ kind: 'none' });
  });

  it('passe en relance amiable quand l’échéancier est rompu', () => {
    expect(nextProgression(context({ state: state('payment_plan'), planProgress: 'defaulted' }))).toEqual({
      kind: 'advance',
      to: 'amicable',
    });
    expect(nextProgression(context({ state: state('payment_plan'), planProgress: 'on_track' }))).toEqual({
      kind: 'none',
    });
  });

  it('propose les étapes décidées par une personne', () => {
    expect(nextProgression(context({ state: state('amicable') }))).toEqual({ kind: 'none' });
    expect(
      nextProgression(context({ state: state('amicable'), now: new Date('2026-11-22T10:00:00Z') })),
    ).toEqual({
      kind: 'propose',
      to: 'formal_notice',
      decidedBy: 'supervisor',
    });
    expect(nextProgression(context({ state: state('formal_notice') }))).toEqual({
      kind: 'propose',
      to: 'bailiff',
      decidedBy: 'creditor',
    });
  });

  it('ne fait rien pour un dossier suspendu, une mise en demeure non remise ou une étape sans délai', () => {
    expect(nextProgression(context({ state: state('notice', 'suspended') }))).toEqual({ kind: 'none' });
    expect(nextProgression(context({ state: state('formal_notice'), stageStartedAt: null }))).toEqual({
      kind: 'none',
    });
    expect(nextProgression(context({ state: state('bailiff') }))).toEqual({ kind: 'none' });
  });
});

describe('séquence de relance amiable (étape 3)', () => {
  it('liste les actions du jour et en retard, sans celles déjà faites', () => {
    expect(amicableStepsDue('2026-11-10', '2026-11-17', new Set([0])).map((s) => [s.day, s.action])).toEqual([
      ['2026-11-13', 'call'],
      ['2026-11-17', 'letter_or_email'],
    ]);
    expect(amicableStepsDue('2026-11-10', '2026-11-09', new Set())).toEqual([]);
  });
});
