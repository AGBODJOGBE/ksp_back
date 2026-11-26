import { addDays, daysBetween, type LocalDay } from './calendar';
import { advanceStage, type CaseStage, type CaseState, type StageMove, stageRank } from './case';
import { stageDeadline } from './deadlines';
import { type Outcome, refusal, success } from './outcome';
import { type PlanProgress } from './payment-plan';
import { type RecoverySettings } from './settings';

/**
 * Avancement des dossiers à l'échéance des délais (UC-RC-26, partie 5). Le système avance seul les
 * étapes automatiques (pas de réponse à la notification, échéancier rompu) ; il ne fait que proposer
 * les étapes décidées par une personne : escalade vers la mise en demeure (superviseur), huissier
 * (créancier, après la mise en demeure).
 */
export type Decider = 'supervisor' | 'creditor';

export type ProgressionAction =
  | { kind: 'none' }
  | { kind: 'advance'; to: CaseStage }
  | { kind: 'propose'; to: CaseStage; decidedBy: Decider };

export interface ProgressionContext {
  state: CaseState;
  /** Début de l'étape ; pour la mise en demeure, sa réception par le débiteur (null tant qu'elle n'est pas remise). */
  stageStartedAt: Date | null;
  now: Date;
  /**
   * Un échéancier est en cours d'accord (proposé, en attente du créancier ou de la signature). Une
   * contestation suspend le dossier : elle n'a pas besoin d'être signalée ici.
   */
  planPending: boolean;
  /** Suivi de l'échéancier en cours, à l'étape échéancier. */
  planProgress: PlanProgress | null;
  settings: RecoverySettings;
}

const NONE: ProgressionAction = { kind: 'none' };

export function nextProgression(context: ProgressionContext): ProgressionAction {
  const { state, stageStartedAt, now, settings } = context;
  if (state.status !== 'active' || state.stage === null) return NONE;
  if (state.stage === 'payment_plan') {
    return context.planProgress === 'defaulted' ? { kind: 'advance', to: planDefaultStage(state) } : NONE;
  }
  if (stageStartedAt === null) return NONE;
  const deadline = stageDeadline(state.stage, stageStartedAt, settings);
  if (deadline === null || now < deadline) return NONE;
  switch (state.stage) {
    case 'notice':
      // Échéancier en cours d'accord : on attend son issue. Sinon, avec ou sans réponse (un simple
      // rappel demandé ne doit pas bloquer le dossier), relance amiable.
      return context.planPending ? NONE : { kind: 'advance', to: 'amicable' };
    case 'amicable':
      return { kind: 'propose', to: 'formal_notice', decidedBy: 'supervisor' };
    case 'formal_notice':
      // Le courrier invite le débiteur à convenir d'un échéancier : on attend l'issue de celui en cours.
      return context.planPending ? NONE : { kind: 'propose', to: 'bailiff', decidedBy: 'creditor' };
    default:
      return NONE;
  }
}

/**
 * Étapes où un échéancier se négocie (6.1) : notification, échéancier (renégociation), relance amiable,
 * et mise en demeure, dont le courrier invite le débiteur à convenir d'un échéancier.
 */
export const PLAN_STAGES: readonly CaseStage[] = ['notice', 'payment_plan', 'amicable', 'formal_notice'];

/**
 * Étape où revient un dossier dont l'échéancier est rompu : la relance amiable, ou la mise en demeure
 * si elle a déjà été atteinte (le débiteur l'a reçue : on ne la refait pas, la suite est l'huissier).
 */
export function planDefaultStage(state: Pick<CaseState, 'highestStage'>): CaseStage {
  const reached = state.highestStage;
  return reached !== null && stageRank(reached) >= stageRank('formal_notice') ? 'formal_notice' : 'amicable';
}

/** Retour à une étape déjà franchie : l'étape la plus avancée, qui fixe la commission, ne change pas. */
function backTo(state: CaseState, to: CaseStage): StageMove {
  return {
    state: { ...state, stage: to },
    change: { from: state.stage, to, skipped: false, skipReason: null },
  };
}

/**
 * Passage d'étape à la signature d'un échéancier (6.1, R-EC-02) : l'étape « échéancier » s'ouvre depuis
 * la notification ou la relance amiable, et aussi depuis la mise en demeure (retour à l'échéancier, la
 * mise en demeure restant l'étape la plus avancée). Null : déjà à l'étape échéancier (renégociation).
 */
export function planSignedMove(state: CaseState): Outcome<StageMove | null> {
  if (state.status !== 'active' || state.stage === null || !PLAN_STAGES.includes(state.stage)) {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Aucun échéancier ne se signe à cette étape');
  }
  if (state.stage === 'payment_plan') return success(null);
  if (state.stage === 'formal_notice') return success(backTo(state, 'payment_plan'));
  return advanceStage(state, 'payment_plan');
}

/**
 * Passage d'étape à la rupture de l'échéancier (2 échéances manquées, 1 après une renégociation) :
 * relance amiable, ou retour à la mise en demeure déjà faite. Null : le dossier n'est plus à l'étape
 * échéancier (rien à changer).
 */
export function planDefaultedMove(state: CaseState): Outcome<StageMove | null> {
  if (state.status !== 'active' || state.stage !== 'payment_plan') return success(null);
  const to = planDefaultStage(state);
  return to === 'amicable' ? advanceStage(state, 'amicable') : success(backTo(state, to));
}

/** Action de la séquence de relance amiable (étape 3). */
export type AmicableAction = 'message' | 'call' | 'letter_or_email' | 'visit';

export interface AmicableStep {
  /** Jour de l'action après l'entrée en relance amiable (J0, J3…). */
  offsetDays: number;
  action: AmicableAction;
}

/** Séquence par défaut : message J0, appel J3, courrier ou e-mail J7, appel J14 ; visite possible, à la main. */
export const DEFAULT_AMICABLE_SEQUENCE: readonly AmicableStep[] = [
  { offsetDays: 0, action: 'message' },
  { offsetDays: 3, action: 'call' },
  { offsetDays: 7, action: 'letter_or_email' },
  { offsetDays: 14, action: 'call' },
];

export interface ScheduledAmicableStep extends AmicableStep {
  index: number;
  day: LocalDay;
}

/**
 * Actions de la séquence à faire aujourd'hui ou en retard, non encore faites (« Ma journée » du chargé ;
 * les messages partent seuls, dans la plage de contact).
 */
export function amicableStepsDue(
  startedOn: LocalDay,
  today: LocalDay,
  done: ReadonlySet<number>,
  sequence: readonly AmicableStep[] = DEFAULT_AMICABLE_SEQUENCE,
): ScheduledAmicableStep[] {
  return sequence
    .map((step, index) => ({ ...step, index, day: addDays(startedOn, step.offsetDays) }))
    .filter((step) => !done.has(step.index) && daysBetween(step.day, today) >= 0);
}
