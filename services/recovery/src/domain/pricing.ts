import { type StageGroup } from './case';
import { floorBasisPoints, floorRate, isRate, isWholeAmount, rateProduct } from './money';
import { type Outcome, refusal, success } from './outcome';

/**
 * Règles tarifaires du Recouvrement (cahier des charges, partie 13 ; ADR-062 ; message `PricingRule` du
 * contrat). Chaque prix est une règle versionnée, publiée au back-office, figée dans le mandat à sa
 * signature (R-CO-02). Montants entiers en FCFA, taux en points de base ; un calcul n'arrondit qu'une
 * fois, au franc inférieur pour une commission. Les règles de la gestion locative, des annonces et des
 * abonnements vivent dans rental et billing.
 */
export type PricingObject = 'case_fee' | 'recovery_commission' | 'study_fee';
export type Offer = 'b2b' | 'b2c' | 'rent' | 'any';
export type RuleStatus = 'draft' | 'pending_approval' | 'published' | 'archived';

/**
 * Tranche d'une règle `tiered` : jusqu'à `upTo` inclus (`null` pour la dernière, sans limite). Une
 * tranche porte un taux ou un montant fixe, le même choix pour toutes les tranches de la règle.
 */
export interface PricingTier {
  upTo: number | null;
  rateBps: number | null;
  fixedAmount: number | null;
}

export type PricingMode =
  | { kind: 'fixed'; fixedAmount: number }
  | { kind: 'percentage'; rateBps: number }
  /**
   * Par tranche du montant de base. En taux : 15 % jusqu'à 1 000 000 FCFA, 10 % au-delà (13.1), chaque
   * part à son taux (calcul progressif). En montants : frais de dossier par tranche de montant dû (13.2).
   */
  | { kind: 'tiered'; tiers: PricingTier[] }
  /** Taux par groupe d'étapes atteint : amiable, mise en demeure, contentieux (R-CO-01). */
  | { kind: 'by_stage'; stageRates: Record<StageGroup, number> };

/** Bornes par opération (par encaissement pour une commission), null = sans borne. */
export interface PricingBounds {
  minimum: number | null;
  maximum: number | null;
}

/** Cible : offre (ou `any`), commune (clé de geo) et créancier précis (tarif négocié, R-TA-04). */
export interface PricingTarget {
  offer: Offer;
  communeKey: string | null;
  creditorId: string | null;
}

export interface PricingRule {
  id: string;
  object: PricingObject;
  mode: PricingMode;
  bounds: PricingBounds;
  target: PricingTarget;
  validFrom: Date;
  validUntil: Date | null;
  status: RuleStatus;
  version: number;
  createdBy: string;
  /** Deuxième personne qui valide un tarif négocié (R-TA-04). */
  approvedBy: string | null;
  /** Règle publiée dont celle-ci est la nouvelle version, null pour une première version. */
  previousVersionId: string | null;
}

type TierKind = 'rates' | 'amounts';

function tierKind(tiers: readonly PricingTier[]): TierKind | 'mixed' {
  if (tiers.every((t) => t.rateBps !== null && t.fixedAmount === null)) return 'rates';
  if (tiers.every((t) => t.fixedAmount !== null && t.rateBps === null)) return 'amounts';
  return 'mixed';
}

/** Modes admis par objet (contrat) : frais de dossier en montants, commission en taux. */
function modeAllowed(object: PricingObject, mode: PricingMode): boolean {
  switch (object) {
    case 'case_fee':
      return mode.kind === 'fixed' || (mode.kind === 'tiered' && tierKind(mode.tiers) === 'amounts');
    case 'study_fee':
      return mode.kind === 'fixed';
    case 'recovery_commission':
      return mode.kind !== 'tiered' || tierKind(mode.tiers) === 'rates';
  }
}

function tierProblems(tiers: readonly PricingTier[]): string[] {
  if (tiers.length === 0) return ['au moins une tranche'];
  const problems: string[] = [];
  let previous = 0;
  tiers.forEach((tier, index) => {
    const last = index === tiers.length - 1;
    if (last && tier.upTo !== null) problems.push('la dernière tranche est sans limite');
    if (!last && tier.upTo === null) problems.push('seule la dernière tranche est sans limite');
    if (tier.upTo !== null) {
      if (!isWholeAmount(tier.upTo) || tier.upTo <= previous)
        problems.push('tranches entières et croissantes');
      previous = tier.upTo;
    }
    if (tier.rateBps !== null && !isRate(tier.rateBps)) problems.push('taux de 0 à 10 000 points de base');
    if (tier.fixedAmount !== null && !isWholeAmount(tier.fixedAmount)) {
      problems.push('montants entiers positifs ou nuls');
    }
  });
  if (tierKind(tiers) === 'mixed') problems.push('toutes les tranches portent un taux, ou toutes un montant');
  return problems;
}

function modeProblems(mode: PricingMode): string[] {
  switch (mode.kind) {
    case 'fixed':
      return isWholeAmount(mode.fixedAmount) ? [] : ['montant entier positif ou nul'];
    case 'percentage':
      return isRate(mode.rateBps) ? [] : ['taux de 0 à 10 000 points de base'];
    case 'tiered':
      return tierProblems(mode.tiers);
    case 'by_stage': {
      const rates = Object.values(mode.stageRates);
      return rates.length === 3 && rates.every(isRate)
        ? []
        : ['un taux de 0 à 10 000 points de base par groupe d’étapes'];
    }
  }
}

/** Problèmes qui empêchent la publication (`RECOVERY_PRICING_RULE_INVALID`). Vide = publiable. */
export function ruleProblems(rule: PricingRule): string[] {
  const problems = [...modeProblems(rule.mode)];
  if (problems.length === 0 && !modeAllowed(rule.object, rule.mode)) {
    problems.push(`mode ${rule.mode.kind} impossible pour ${rule.object}`);
  }
  const { minimum, maximum } = rule.bounds;
  if ((minimum !== null && !isWholeAmount(minimum)) || (maximum !== null && !isWholeAmount(maximum))) {
    problems.push('bornes entières positives ou nulles');
  } else if (minimum !== null && maximum !== null && minimum > maximum) {
    problems.push('le minimum dépasse le maximum');
  }
  if (rule.validUntil !== null && rule.validUntil <= rule.validFrom) problems.push('la fin suit le début');
  if (rule.target.communeKey !== null && rule.target.communeKey.trim() === '') problems.push('commune vide');
  if (rule.target.creditorId !== null && rule.target.creditorId.trim() === '')
    problems.push('créancier vide');
  return problems;
}

function sameScope(a: PricingRule, b: PricingRule): boolean {
  return (
    a.object === b.object &&
    a.target.offer === b.target.offer &&
    a.target.communeKey === b.target.communeKey &&
    a.target.creditorId === b.target.creditorId
  );
}

function isActiveAt(rule: PricingRule, at: Date): boolean {
  return (
    rule.status === 'published' && rule.validFrom <= at && (rule.validUntil === null || at < rule.validUntil)
  );
}

/** Effet de la publication sur une règle publiée de même objet et de même cible, ou sur la version précédente. */
export type Supersession =
  { ruleId: string; action: 'archive' } | { ruleId: string; action: 'end_at'; validUntil: Date };

export interface Publication {
  rule: PricingRule;
  superseded: Supersession[];
}

/**
 * Publication d'un brouillon (PublishPricingRule). Un tarif négocié pour un créancier passe d'abord en
 * `pending_approval` et n'est publié qu'à la validation d'une seconde personne (`approveRule`, R-TA-04) ;
 * une règle générale est publiée tout de suite.
 */
export function publishRule(
  rule: PricingRule,
  others: readonly PricingRule[],
  now: Date,
): Outcome<Publication> {
  if (rule.status !== 'draft') return refusal('RECOVERY_INVALID_TRANSITION', 'Seul un brouillon se publie');
  const problems = ruleProblems(rule);
  if (problems.length > 0) return refusal('RECOVERY_PRICING_RULE_INVALID', problems.join(' ; '));
  if (rule.target.creditorId !== null) {
    return success({ rule: { ...rule, status: 'pending_approval' }, superseded: [] });
  }
  return activate(rule, others, now);
}

/**
 * Validation d'un tarif négocié (ApprovePricingRule) par une autre personne que son auteur
 * (`RECOVERY_APPROVAL_BY_REQUESTER` sinon), puis publication.
 */
export function approveRule(
  rule: PricingRule,
  approver: string,
  others: readonly PricingRule[],
  now: Date,
): Outcome<Publication> {
  if (rule.status !== 'pending_approval') {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Seule une règle en attente de validation se valide');
  }
  if (approver === rule.createdBy) {
    return refusal('RECOVERY_APPROVAL_BY_REQUESTER', 'Un tarif négocié est validé par une deuxième personne');
  }
  return activate({ ...rule, approvedBy: approver }, others, now);
}

/**
 * Mise en vigueur : une seule règle publiée par objet et par cible sur une même période. La précédente
 * (même cible, ou version précédente) est archivée si la nouvelle vaut tout de suite, sinon elle prend
 * fin au début de la nouvelle. Une règle publiée qui commencerait après la nouvelle est un conflit.
 */
function activate(rule: PricingRule, others: readonly PricingRule[], now: Date): Outcome<Publication> {
  const scope = others.filter((other) => other.id !== rule.id && sameScope(other, rule));
  const live = others.filter(
    (other) =>
      other.id !== rule.id &&
      other.status === 'published' &&
      (sameScope(other, rule) || other.id === rule.previousVersionId),
  );
  if (live.some((other) => sameScope(other, rule) && other.validFrom >= rule.validFrom)) {
    return refusal('RECOVERY_PRICING_RULE_CONFLICT', 'Une règle publiée commence après celle-ci');
  }
  const superseded: Supersession[] = live
    .filter((other) => other.validUntil === null || other.validUntil > rule.validFrom)
    .map((other) =>
      rule.validFrom <= now
        ? { ruleId: other.id, action: 'archive' }
        : { ruleId: other.id, action: 'end_at', validUntil: rule.validFrom },
    );
  const previous = others.find((other) => other.id === rule.previousVersionId);
  const version = Math.max(0, previous?.version ?? 0, ...scope.map((other) => other.version)) + 1;
  return success({ rule: { ...rule, status: 'published', version }, superseded });
}

export function archiveRule(rule: PricingRule): Outcome<PricingRule> {
  if (rule.status !== 'published' && rule.status !== 'pending_approval') {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Seule une règle publiée ou en attente s’archive');
  }
  return success({ ...rule, status: 'archived' });
}

export interface PricingQuery {
  offer: Exclude<Offer, 'any'>;
  communeKey: string | null;
  creditorId: string | null;
}

/** Spécificité d'une règle : créancier précis, puis offre et commune, puis offre, puis `any` (ADR-062). */
function specificity(rule: PricingRule): number {
  return (
    (rule.target.creditorId ? 4 : 0) +
    (rule.target.offer !== 'any' ? 2 : 0) +
    (rule.target.communeKey ? 1 : 0)
  );
}

/** Règle applicable à un instant (R-TA-04) ; à spécificité égale, la plus récente. */
export function resolveRule(
  rules: readonly PricingRule[],
  object: PricingObject,
  query: PricingQuery,
  at: Date,
): PricingRule | null {
  const candidates = rules.filter(
    (rule) =>
      rule.object === object &&
      (rule.target.offer === 'any' || rule.target.offer === query.offer) &&
      isActiveAt(rule, at) &&
      (rule.target.creditorId === null || rule.target.creditorId === query.creditorId) &&
      (rule.target.communeKey === null || rule.target.communeKey === query.communeKey),
  );
  candidates.sort((a, b) => specificity(b) - specificity(a) || b.validFrom.getTime() - a.validFrom.getTime());
  return candidates[0] ?? null;
}

/** Borne appliquée au résultat (`boundApplied` du simulateur), null sinon. */
export type BoundApplied = 'minimum' | 'maximum' | null;

export interface PricedAmount {
  amount: number;
  boundApplied: BoundApplied;
}

function bounded(value: number, bounds: PricingBounds): PricedAmount {
  if (bounds.minimum !== null && value < bounds.minimum)
    return { amount: bounds.minimum, boundApplied: 'minimum' };
  if (bounds.maximum !== null && value > bounds.maximum)
    return { amount: bounds.maximum, boundApplied: 'maximum' };
  return { amount: value, boundApplied: null };
}

function tierFor(tiers: readonly PricingTier[], amount: number): PricingTier {
  return tiers.find((tier) => tier.upTo === null || amount <= tier.upTo) ?? tiers[tiers.length - 1]!;
}

/** Numérateur exact d'une commission par tranches de taux sur un cumul (FCFA × points de base). */
function tieredNumerator(tiers: readonly PricingTier[], cumulative: number): number {
  let numerator = 0;
  let floor = 0;
  for (const tier of tiers) {
    const ceiling = tier.upTo ?? Number.POSITIVE_INFINITY;
    const part = Math.max(0, Math.min(cumulative, ceiling) - floor);
    numerator += rateProduct(part, tier.rateBps ?? 0);
    if (!Number.isSafeInteger(numerator)) throw new RangeError('Montant hors de la plage de calcul exact');
    if (cumulative <= ceiling) break;
    floor = ceiling;
  }
  return numerator;
}

/** Frais de dossier selon le montant dû (R-SD-04) : montant fixe, ou montant de la tranche du dû. */
export function caseFee(rule: PricingRule, amountDue: number): PricedAmount {
  const raw =
    rule.mode.kind === 'fixed'
      ? rule.mode.fixedAmount
      : rule.mode.kind === 'tiered'
        ? (tierFor(rule.mode.tiers, amountDue).fixedAmount ?? 0)
        : 0;
  return bounded(raw, rule.bounds);
}

/**
 * Forfait d'étude retenu sur les frais remboursés d'un dossier refusé (4.4), jamais plus que les frais.
 */
export function studyFee(rule: PricingRule, paidCaseFee: number): number {
  const raw = rule.mode.kind === 'fixed' ? rule.mode.fixedAmount : 0;
  return Math.min(bounded(raw, rule.bounds).amount, paidCaseFee);
}

export interface FeeRefund {
  /** Forfait d'étude gardé par KSP. */
  retained: number;
  /** Remboursé au portefeuille du créancier. */
  refunded: number;
}

/**
 * Remboursement des frais de dossier d'un dossier refusé (4.4, décision du 2026-11-20) : irrecevable
 * ou classé faute de complément, les frais payés sont remboursés moins le forfait d'étude. Sans règle
 * de forfait d'étude publiée, tout est remboursé.
 */
export function rejectionRefund(studyRule: PricingRule | null, paidCaseFee: number): FeeRefund {
  const retained = studyRule === null ? 0 : studyFee(studyRule, paidCaseFee);
  return { retained, refunded: paidCaseFee - retained };
}

export interface CommissionInput {
  /** Base commissionnable de cet encaissement (intérêts et principal imputés). */
  base: number;
  /** Base déjà commissionnée sur le dossier, pour les tranches et l'arrondi unique sur un cumul. */
  collectedBefore: number;
  /** Commission déjà prélevée sur le dossier, pour le minimum au cumul. */
  commissionBefore: number;
  /** Groupe de l'étape la plus avancée atteinte à l'encaissement (R-CO-01). */
  stageGroup: StageGroup;
  /** Cet encaissement solde le dossier (clôture « payé ») : le complément jusqu'au minimum s'y prélève. */
  closesCase: boolean;
}

export interface CommissionResult {
  commission: number;
  /** Part reversée au créancier (R-CO-03 ; KSP n'avance jamais de frais de procédure). */
  net: number;
  boundApplied: BoundApplied;
}

/**
 * Commission d'un encaissement (R-CO-01). Pourcentage et tranches de taux sont calculés sur le cumul du
 * dossier puis différenciés : un seul arrondi au franc inférieur sur toute la vie du dossier, le cumul
 * des commissions est exactement l'arrondi du calcul exact. Le taux par étape, qui change avec l'étape
 * atteinte, est arrondi au franc inférieur à chaque encaissement (KSP ne prélève jamais plus que le
 * taux).
 *
 * Bornes (décision du 2026-11-20) : le maximum vaut pour chaque encaissement ; le minimum vaut pour le
 * cumul du dossier. Tant que la commission cumulée reste sous le minimum, chaque encaissement est pris
 * au taux normal ; l'encaissement qui solde le dossier (clôture « payé ») porte le complément jusqu'au
 * minimum. La commission ne dépasse jamais l'encaissement : un complément plus grand que le dernier
 * encaissement est limité à celui-ci, les sommes déjà reversées au créancier ne sont pas reprises.
 */
export function commission(rule: PricingRule, input: CommissionInput): CommissionResult {
  if (input.base <= 0) return { commission: 0, net: 0, boundApplied: null };
  let value = rawCommission(rule.mode, input);
  let boundApplied: BoundApplied = null;
  const { minimum, maximum } = rule.bounds;
  if (maximum !== null && value > maximum) {
    value = maximum;
    boundApplied = 'maximum';
  }
  if (input.closesCase && minimum !== null && input.commissionBefore + value < minimum) {
    value = minimum - input.commissionBefore;
    boundApplied = 'minimum';
  }
  value = Math.min(value, input.base);
  return { commission: value, net: input.base - value, boundApplied };
}

function rawCommission(mode: PricingMode, { base, collectedBefore, stageGroup }: CommissionInput): number {
  const after = collectedBefore + base;
  switch (mode.kind) {
    case 'percentage':
      return floorRate(after, mode.rateBps) - floorRate(collectedBefore, mode.rateBps);
    case 'tiered':
      if (tierKind(mode.tiers) !== 'rates') return 0;
      return (
        floorBasisPoints(tieredNumerator(mode.tiers, after)) -
        floorBasisPoints(tieredNumerator(mode.tiers, collectedBefore))
      );
    case 'by_stage':
      return floorRate(base, mode.stageRates[stageGroup]);
    case 'fixed':
      return mode.fixedAmount;
  }
}

export interface CommissionSimulation {
  collected: number;
  commission: number;
  net: number;
}

/**
 * Simulateur du back-office (R-TA-01) : effet d'une règle sur un dossier recouvré en N encaissements
 * égaux (le dernier porte le reste et solde le dossier), à un groupe d'étapes donné.
 */
export function simulateCommission(
  rule: PricingRule,
  collected: number,
  group: StageGroup,
  payments = 1,
): CommissionSimulation {
  const count = Math.max(1, Math.trunc(payments));
  const share = Math.floor(collected / count);
  let before = 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1;
    const base = last ? collected - before : share;
    total += commission(rule, {
      base,
      collectedBefore: before,
      commissionBefore: total,
      stageGroup: group,
      closesCase: last,
    }).commission;
    before += base;
  }
  return { collected, commission: total, net: collected - total };
}
