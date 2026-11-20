import { addMonths, daysBetween, localDay, type LocalDay } from './calendar';
import { type Outcome, refusal, success } from './outcome';

/**
 * Dossier de recouvrement (cahier des charges, parties 4, 5 et 16.3).
 *
 * Statut : brouillon → frais à payer → en examen ⇄ complément demandé → actif ⇄ suspendu → clos ;
 * en examen → refusé. L'étape ne vaut que pour un dossier actif ou suspendu : notification du mandat →
 * échéancier → relance amiable → mise en demeure → huissier → procédure judiciaire. Une étape ne
 * s'ouvre que quand la précédente a échoué ; un saut n'est permis que dans les deux cas de R-PR-03.
 */
export type CaseKind = 'b2b' | 'b2c' | 'rent';

export type CaseStatus =
  | 'draft'
  | 'awaiting_fee'
  | 'under_review'
  | 'info_requested'
  | 'active'
  | 'suspended'
  | 'closed'
  | 'rejected';

export type CaseStage = 'notice' | 'payment_plan' | 'amicable' | 'formal_notice' | 'bailiff' | 'litigation';

/** Ordre des étapes, de la plus douce à la plus lourde. */
export const STAGE_ORDER: readonly CaseStage[] = [
  'notice',
  'payment_plan',
  'amicable',
  'formal_notice',
  'bailiff',
  'litigation',
];

/** Motifs de clôture (R-PR-10). */
export type ClosureReason =
  | 'paid'
  | 'settlement_executed'
  | 'dispute_upheld'
  | 'abandoned_by_creditor'
  | 'unrecoverable'
  | 'prescribed';

/**
 * Motifs de refus (4.4, AssessCase) : créance prescrite, illégale, sans preuve, débiteur introuvable,
 * autre ; `incomplete` est réservé au classement automatique d'un complément non fourni dans le délai.
 */
export type RejectionReason =
  'prescribed' | 'illegal' | 'no_evidence' | 'debtor_unreachable' | 'other' | 'incomplete';

/** Cas de saut d'étape permis (R-PR-03). */
export type SkipReason = 'prescription_near' | 'asset_flight_risk';

const STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  draft: ['awaiting_fee'],
  awaiting_fee: ['under_review'],
  under_review: ['info_requested', 'active', 'rejected'],
  info_requested: ['under_review', 'rejected'],
  // Un dossier suspendu se clôt aussi : contestation fondée (R-PR-02) ou arrêt par le créancier.
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
  rejected: [],
};

/** Passages d'étape ordinaires (partie 5) ; l'échéancier peut être renégocié une fois en relance amiable. */
const STAGE_TRANSITIONS: Record<CaseStage, readonly CaseStage[]> = {
  notice: ['payment_plan', 'amicable'],
  payment_plan: ['amicable'],
  amicable: ['payment_plan', 'formal_notice'],
  formal_notice: ['bailiff'],
  bailiff: ['litigation'],
  litigation: [],
};

/** Étapes payantes : devis accepté et provision payée par le créancier avant de commencer (R-PR-04). */
const STAGES_REQUIRING_APPROVAL: ReadonlySet<CaseStage> = new Set(['bailiff', 'litigation']);

/** Cibles d'un saut (R-PR-03) : directement la mise en demeure ou l'huissier. */
const SKIP_TARGETS: ReadonlySet<CaseStage> = new Set(['formal_notice', 'bailiff']);

export interface CaseState {
  kind: CaseKind;
  status: CaseStatus;
  /** Étape en cours ; null tant que le dossier n'est pas actif. */
  stage: CaseStage | null;
  /** Étape la plus avancée jamais atteinte : elle fixe le groupe d'étapes de la commission (R-CO-01). */
  highestStage: CaseStage | null;
  closureReason: ClosureReason | null;
  rejectionReason: RejectionReason | null;
}

/** Trace d'un changement d'étape (`StageTransition`), versée au journal de preuve (R-PR-08). */
export interface StageChange {
  from: CaseStage | null;
  to: CaseStage;
  skipped: boolean;
  skipReason: SkipReason | null;
}

export function newCase(kind: CaseKind): CaseState {
  return {
    kind,
    status: 'draft',
    stage: null,
    highestStage: null,
    closureReason: null,
    rejectionReason: null,
  };
}

export function canTransitionStatus(from: CaseStatus, to: CaseStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function canAdvanceStage(from: CaseStage, to: CaseStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

export function stageRank(stage: CaseStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function requiresCreditorApproval(stage: CaseStage): boolean {
  return STAGES_REQUIRING_APPROVAL.has(stage);
}

function higher(a: CaseStage | null, b: CaseStage): CaseStage {
  return a !== null && stageRank(a) >= stageRank(b) ? a : b;
}

function invalidStatus(from: CaseStatus, to: CaseStatus): Outcome<never> {
  return refusal('RECOVERY_INVALID_TRANSITION', `Passage du dossier de « ${from} » à « ${to} » refusé`);
}

/**
 * Changement de statut hors clôture et refus : frais à payer, examen, complément, acceptation (actif),
 * suspension par une contestation et reprise.
 */
export function changeStatus(
  state: CaseState,
  to: Exclude<CaseStatus, 'closed' | 'rejected'>,
): Outcome<CaseState> {
  if (!canTransitionStatus(state.status, to)) return invalidStatus(state.status, to);
  if (to === 'active' && state.status === 'under_review') return accept(state);
  return success({ ...state, status: to });
}

/**
 * Dossier recevable (4.4) : il devient actif à l'étape de notification du mandat. Un dossier « loyers »
 * suit la procédure locative (partie 9), dont les étapes arrivent avec le lot G (ADR-060) : pas encore
 * activable.
 */
function accept(state: CaseState): Outcome<CaseState> {
  if (state.kind === 'rent') {
    return refusal(
      'RECOVERY_INVALID_TRANSITION',
      'La procédure des loyers impayés arrive avec la gestion locative',
    );
  }
  return success({ ...state, status: 'active', stage: 'notice', highestStage: 'notice' });
}

export function reject(state: CaseState, reason: RejectionReason): Outcome<CaseState> {
  if (!canTransitionStatus(state.status, 'rejected')) return invalidStatus(state.status, 'rejected');
  if (reason === 'incomplete' && state.status !== 'info_requested') {
    return refusal(
      'RECOVERY_INVALID_TRANSITION',
      'Un dossier n’est classé incomplet qu’après une demande de complément',
    );
  }
  return success({ ...state, status: 'rejected', rejectionReason: reason });
}

/** Clôture (R-PR-10) ; une contestation fondée ne se tranche que sur un dossier suspendu (R-PR-02). */
export function close(state: CaseState, reason: ClosureReason): Outcome<CaseState> {
  if (!canTransitionStatus(state.status, 'closed')) return invalidStatus(state.status, 'closed');
  if (reason === 'dispute_upheld' && state.status !== 'suspended') {
    return refusal(
      'RECOVERY_INVALID_TRANSITION',
      'Seul un dossier suspendu par une contestation se clôt « contestation fondée »',
    );
  }
  return success({ ...state, status: 'closed', closureReason: reason });
}

export interface StageMove {
  state: CaseState;
  change: StageChange;
}

/**
 * Passage ordinaire à l'étape suivante (partie 5). Les étapes payantes exigent l'accord du créancier
 * (R-PR-04), donné hors du domaine (devis accepté et provision payée).
 */
export function advanceStage(state: CaseState, to: CaseStage, creditorApproval = false): Outcome<StageMove> {
  if (state.status !== 'active' || state.stage === null) {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Seul un dossier actif change d’étape');
  }
  if (!canAdvanceStage(state.stage, to)) {
    return refusal('RECOVERY_INVALID_TRANSITION', `Passage de l'étape « ${state.stage} » à « ${to} » refusé`);
  }
  if (requiresCreditorApproval(to) && !creditorApproval) {
    return refusal(
      'RECOVERY_CREDITOR_APPROVAL_REQUIRED',
      'Étape payante : accord du créancier et provision requis',
    );
  }
  return success(move(state, to, false, null));
}

export interface SkipContext {
  reason: SkipReason;
  /** Date de prescription du dossier, obligatoire pour le motif `prescription_near`. */
  prescriptionDate: LocalDay | null;
  today: LocalDay;
  /** Seuil de « prescription proche » : moins de 90 jours (R-PR-03, `FIXED_RULES`). */
  prescriptionNearDays: number;
}

/** Saut demandé : il ouvre une décision `stage_skip` soumise au créancier (ChangeCaseStage). */
export interface StageSkipRequest {
  from: CaseStage;
  to: CaseStage;
  reason: SkipReason;
}

/**
 * Contrôle d'un saut d'étape (R-PR-03) : vers la mise en demeure ou l'huissier, depuis une étape
 * antérieure, seulement si la prescription est proche ou si les biens du débiteur risquent de
 * disparaître. Le juriste le demande (permission hors du domaine) ; l'étape ne change qu'à l'accord du
 * créancier sur la décision `stage_skip` (`skipStage`).
 */
export function requestStageSkip(
  state: CaseState,
  to: CaseStage,
  context: SkipContext,
): Outcome<StageSkipRequest> {
  if (state.status !== 'active' || state.stage === null) {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Seul un dossier actif change d’étape');
  }
  if (!SKIP_TARGETS.has(to) || stageRank(to) <= stageRank(state.stage) || canAdvanceStage(state.stage, to)) {
    return refusal(
      'RECOVERY_STAGE_SKIP_NOT_ALLOWED',
      'Saut permis seulement vers la mise en demeure ou l’huissier',
    );
  }
  if (context.reason === 'prescription_near') {
    if (context.prescriptionDate === null) {
      return refusal('RECOVERY_STAGE_SKIP_NOT_ALLOWED', 'Date de prescription inconnue');
    }
    if (daysBetween(context.today, context.prescriptionDate) >= context.prescriptionNearDays) {
      return refusal('RECOVERY_STAGE_SKIP_NOT_ALLOWED', 'La prescription n’est pas proche');
    }
  }
  return success({ from: state.stage, to, reason: context.reason });
}

/**
 * Saut d'étape exécuté à l'acceptation de la décision `stage_skip` par le créancier ; sans elle,
 * `RECOVERY_CREDITOR_APPROVAL_REQUIRED`. Les conditions sont contrôlées de nouveau au moment du saut.
 */
export function skipStage(
  state: CaseState,
  to: CaseStage,
  context: SkipContext,
  creditorApproval: boolean,
): Outcome<StageMove> {
  const request = requestStageSkip(state, to, context);
  if (!request.ok) return request;
  if (!creditorApproval) {
    return refusal('RECOVERY_CREDITOR_APPROVAL_REQUIRED', 'Un saut d’étape demande l’accord du créancier');
  }
  return success(move(state, to, true, context.reason));
}

function move(state: CaseState, to: CaseStage, skipped: boolean, skipReason: SkipReason | null): StageMove {
  return {
    state: { ...state, stage: to, highestStage: higher(state.highestStage, to) },
    change: { from: state.stage, to, skipped, skipReason },
  };
}

/**
 * Groupe d'étapes de la commission par étape (ADR-062, `StageRate`) : `amicable` (notification,
 * échéancier, relance), `formal_notice`, `litigation` (huissier et judiciaire).
 */
export type StageGroup = 'amicable' | 'formal_notice' | 'litigation';

export function stageGroup(stage: CaseStage | null): StageGroup {
  if (stage === null) return 'amicable';
  if (stage === 'formal_notice') return 'formal_notice';
  return stage === 'bailiff' || stage === 'litigation' ? 'litigation' : 'amicable';
}

/**
 * Commission due sur un paiement direct au créancier après l'arrêt du dossier (R-PR-06) : oui s'il est
 * reçu dans les N jours qui suivent l'arrêt (30, `FIXED_RULES`). Avant l'arrêt, elle est toujours due
 * (R-PR-07).
 */
export function isCommissionDueOnDirectPayment(
  stoppedAt: Date | null,
  paidAt: Date,
  directPaymentCommissionDays: number,
): boolean {
  if (stoppedAt === null || paidAt <= stoppedAt) return true;
  return paidAt.getTime() - stoppedAt.getTime() <= directPaymentCommissionDays * 86_400_000;
}

/**
 * Irrecouvrable faute de contact (R-PR-10) : aucun contact abouti depuis N mois (6 par défaut), comptés
 * en jours du Bénin ; un dernier contact le 31 août atteint la limite le 28 ou 29 février.
 */
export function isUnrecoverableForLackOfContact(
  lastSuccessfulContactAt: Date,
  now: Date,
  unrecoverableAfterMonths: number,
): boolean {
  return localDay(now) >= addMonths(localDay(lastSuccessfulContactAt), unrecoverableAfterMonths);
}
