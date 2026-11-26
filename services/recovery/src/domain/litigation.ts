import { addDaysToInstant } from './calendar';
import { type CaseStage, type CaseState, type ClosureReason } from './case';
import { isWholeAmount } from './money';
import { type Outcome, refusal, success } from './outcome';
import { type PartnerKind } from './partner';

/**
 * Contentieux (lot R5, parties 5 et 8) : mise en demeure et sa remise, étapes payantes (devis accepté
 * et provision du créancier, R-PR-04), consommation des provisions par les actes des partenaires,
 * clôtures décidées au back-office (R-PR-10) et découpage du journal de preuve exporté (ADR-060,
 * point 12). KSP n'avance jamais de frais de procédure : tout passe par la provision du créancier, et
 * un dépassement donne lieu à une nouvelle provision (ADR-060, point 10).
 */

/** Délai laissé au débiteur après la réception de la mise en demeure, en jours (contrat : 8 à 60). */
export const NOTICE_DEADLINE_DAYS = { min: 8, max: 60 } as const;

export type NoticeDeliveryMethod = 'hand_delivery' | 'registered_mail' | 'bailiff' | 'email';
export const NOTICE_DELIVERY_METHODS: readonly NoticeDeliveryMethod[] = [
  'hand_delivery',
  'registered_mail',
  'bailiff',
  'email',
];

/** Fin du délai de la mise en demeure : N jours après sa remise au débiteur (étape 4). */
export function noticeDeadline(deliveredAt: Date, deadlineDays: number): Date {
  return addDaysToInstant(deliveredAt, deadlineDays);
}

/** Étapes payantes (R-PR-04) : huissier (étape 5), procédure judiciaire (étape 6). */
export type PaidStage = 'bailiff' | 'litigation';
export const PAID_STAGES: readonly PaidStage[] = ['bailiff', 'litigation'];

/**
 * Devis demandé au créancier : passage à l'étape payante suivante, ou provision complémentaire à
 * l'étape en cours (dépassement des frais, nouveau partenaire).
 */
export type EscalationKind = 'escalation' | 'top_up';

/**
 * Devis possible pour cette étape payante : depuis la mise en demeure restée sans effet (délai écoulé
 * après sa remise) vers l'huissier, depuis l'huissier vers la procédure judiciaire, ou provision
 * complémentaire à l'étape payante en cours. Seul un dossier actif est concerné.
 */
export function escalationRequest(
  state: Pick<CaseState, 'status' | 'stage'>,
  target: PaidStage,
  noticeExpired: boolean,
): Outcome<EscalationKind> {
  if (state.status !== 'active' || state.stage === null) {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Seul un dossier actif passe à une étape payante');
  }
  if (state.stage === target) return success('top_up');
  if (target === 'bailiff' && state.stage === 'formal_notice') {
    return noticeExpired
      ? success('escalation')
      : refusal(
          'RECOVERY_INVALID_TRANSITION',
          'La mise en demeure doit être remise et son délai écoulé avant de proposer l’huissier',
        );
  }
  if (target === 'litigation' && state.stage === 'bailiff') return success('escalation');
  return refusal('RECOVERY_INVALID_TRANSITION', `Pas de devis « ${target} » à l’étape « ${state.stage} »`);
}

/**
 * Métier du partenaire selon l'étape : un huissier pour l'étape 5 ; un avocat, ou l'huissier de
 * l'exécution forcée, pour l'étape 6.
 */
export function partnerFitsStage(kind: PartnerKind, stage: PaidStage): boolean {
  return stage === 'litigation' || kind === 'bailiff';
}

export interface FeeLine {
  label: string;
  amount: number;
}

/** Lignes d'un devis : 30 au plus (contrat). */
export const MAX_FEE_LINES = 30;

/**
 * Total d'un devis et provision demandée : la provision couvre tout le devis, KSP n'avançant aucun
 * frais (ADR-060, point 10).
 */
export function feeQuoteTotals(lines: readonly FeeLine[]): Outcome<{ total: number; provision: number }> {
  if (lines.length === 0 || lines.length > MAX_FEE_LINES) {
    return refusal('RECOVERY_INVALID_AMOUNT', `Un devis compte de 1 à ${MAX_FEE_LINES} lignes`);
  }
  if (lines.some((line) => !isWholeAmount(line.amount) || line.amount <= 0)) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Chaque ligne du devis est un montant entier et positif');
  }
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Total du devis hors bornes');
  }
  return success({ total, provision: total });
}

/** Provision payée et sa consommation par les frais des actes. */
export interface ProvisionBalance {
  id: string;
  amount: number;
  consumed: number;
}

export function provisionRemainder(provisions: readonly ProvisionBalance[]): number {
  return provisions.reduce((sum, provision) => sum + Math.max(0, provision.amount - provision.consumed), 0);
}

/**
 * Frais d'un acte imputés sur les provisions payées, la plus ancienne d'abord. Au-delà, le dépassement
 * n'est pas avancé par KSP : il appelle une provision complémentaire du créancier.
 */
export function consumeProvisions(
  provisions: readonly ProvisionBalance[],
  cost: number,
): { provisions: ProvisionBalance[]; overrun: number } {
  let left = cost;
  const next = provisions.map((provision) => {
    const available = Math.max(0, provision.amount - provision.consumed);
    const taken = Math.min(available, left);
    left -= taken;
    return { ...provision, consumed: provision.consumed + taken };
  });
  return { provisions: next, overrun: left };
}

/** Types d'actes des partenaires (contrat `LegalAct.type`). */
export type LegalActType =
  | 'summons_to_pay'
  | 'service'
  | 'conservatory_measure'
  | 'seizure'
  | 'injunction_request'
  | 'injunction_order'
  | 'hearing'
  | 'judgment'
  | 'enforcement'
  | 'insolvency_report'
  | 'other';

export const LEGAL_ACT_TYPES: readonly LegalActType[] = [
  'summons_to_pay',
  'service',
  'conservatory_measure',
  'seizure',
  'injunction_request',
  'injunction_order',
  'hearing',
  'judgment',
  'enforcement',
  'insolvency_report',
  'other',
];

/**
 * Clôtures décidées au back-office (R-PR-10) ; les autres motifs ont leur propre chemin : « payé » et
 * « accord transactionnel exécuté » à l'encaissement, « contestation fondée » par la décision du
 * juriste sur la contestation.
 */
export type ManualClosureReason = Extract<
  ClosureReason,
  'abandoned_by_creditor' | 'unrecoverable' | 'prescribed'
>;
export const MANUAL_CLOSURE_REASONS: readonly ManualClosureReason[] = [
  'abandoned_by_creditor',
  'unrecoverable',
  'prescribed',
];

export interface ClosureEvidence {
  /** La date de prescription est atteinte. */
  prescribed: boolean;
  /** Constat d'insolvabilité ou de disparition : pièce jointe ou acte d'un huissier. */
  insolvencyEstablished: boolean;
  /** Aucun contact abouti depuis le délai réglé (6 mois). */
  noContactForLong: boolean;
}

/**
 * Clôture manuelle (R-PR-10) : « irrecouvrable » seulement sur constat d'un huissier (ou pièce) ou
 * après N mois sans contact possible ; « prescrit » seulement à la date de prescription atteinte ;
 * « abandon par le créancier » sur sa demande (refus d'une étape payante, demande écrite).
 */
export function manualClosure(
  reason: ManualClosureReason,
  evidence: ClosureEvidence,
): Outcome<ClosureReason> {
  if (reason === 'unrecoverable' && !evidence.insolvencyEstablished && !evidence.noContactForLong) {
    return refusal(
      'RECOVERY_INVALID_TRANSITION',
      'Irrecouvrable : constat d’insolvabilité ou de disparition, ou délai sans contact possible écoulé',
    );
  }
  if (reason === 'prescribed' && !evidence.prescribed) {
    return refusal('RECOVERY_INVALID_TRANSITION', 'La date de prescription n’est pas atteinte');
  }
  return success(reason);
}

/**
 * Découpage du journal de preuve en parties (ADR-060, point 12) : au plus `maxEntries` entrées et
 * `maxBytes` octets de JSON par partie (la première limite atteinte s'applique), dans l'ordre. `size`
 * donne la taille JSON d'une entrée, séparateur compris ; une entrée seule plus grande que la limite
 * fait sa propre partie (elle est bornée en amont).
 */
export function splitJournal<T>(
  entries: readonly T[],
  size: (entry: T) => number,
  maxEntries: number,
  maxBytes: number,
): T[][] {
  const parts: T[][] = [];
  let current: T[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const entryBytes = size(entry);
    if (current.length > 0 && (current.length >= maxEntries || bytes + entryBytes > maxBytes)) {
      parts.push(current);
      current = [];
      bytes = 2;
    }
    current.push(entry);
    bytes += entryBytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Étape payante d'un dossier, ou null avant l'huissier. */
export function paidStageOf(stage: CaseStage | null): PaidStage | null {
  return stage === 'bailiff' || stage === 'litigation' ? stage : null;
}
