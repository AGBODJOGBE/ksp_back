import { addDays, daysBetween, type LocalDay } from './calendar';
import { type CaseStage, type CaseState } from './case';
import { stageDeadline } from './deadlines';
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
    return context.planProgress === 'defaulted' ? { kind: 'advance', to: 'amicable' } : NONE;
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
      return { kind: 'propose', to: 'bailiff', decidedBy: 'creditor' };
    default:
      return NONE;
  }
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
