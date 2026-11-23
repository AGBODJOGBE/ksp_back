import { type StageGroup, stageGroup, STAGE_ORDER, type CaseStage } from '../domain/case';
import { isWholeAmount } from '../domain/money';
import {
  approveRule,
  archiveRule,
  caseFee,
  commission,
  type Offer,
  type PricedAmount,
  type PricingMode,
  type PricingObject,
  type PricingRule,
  type PricingTier,
  publishRule,
  resolveRule,
  studyFee,
} from '../domain/pricing';
import {
  type AuditLog,
  type Clock,
  type IdGenerator,
  type PricingRuleFilter,
  type PricingRuleStore,
  type SettingsStore,
  type StoredPricingRule,
} from './ports';
import { loadSettings } from './settings.use-cases';
import {
  BACKOFFICE_MFA_SECONDS,
  CRITICAL_MFA_SECONDS,
  currentCreditor,
  PRICING_READERS,
  RECOVERY_ADMINS,
  requireStaff,
} from './shared/access';
import { formatXof, RecoveryErrors, unwrap } from './shared/errors';

export interface PricingDeps {
  rules: PricingRuleStore;
  settings: SettingsStore;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
}

const OBJECTS: readonly PricingObject[] = ['case_fee', 'recovery_commission', 'study_fee'];
const OFFERS: readonly Offer[] = ['b2b', 'b2c', 'rent', 'any'];
const MODES: readonly PricingMode['kind'][] = ['fixed', 'percentage', 'tiered', 'by_stage'];
const STAGE_GROUPS: readonly StageGroup[] = ['amicable', 'formal_notice', 'litigation'];
const STATUSES = ['draft', 'pending_approval', 'published', 'archived'] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Saisie d'une règle (PricingRuleInput) traduite par l'interface : montants entiers, null = absent. */
export interface PricingRuleInput {
  object: string;
  mode: string;
  fixedAmount: number | null;
  rateBps: number | null;
  tiers: readonly { upTo: number | null; rateBps: number | null; fixedAmount: number | null }[];
  stageRates: readonly { stageGroup: string; rateBps: number }[];
  minimum: number | null;
  maximum: number | null;
  offer: string;
  communeKey: string | null;
  creditor: { type: string; id: string } | null;
  validFrom: string | null;
  validUntil: string | null;
  label: string;
  previousVersionId: string | null;
}

function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw RecoveryErrors.invalid(field, `Valeur attendue : ${allowed.join(', ')}.`);
  }
  return value as T;
}

function optionalAmount(field: string, value: number | null): number | null {
  if (value === null) return null;
  if (!isWholeAmount(value)) throw RecoveryErrors.invalid(field, 'Montant entier positif ou nul attendu.');
  return value;
}

function parseDate(field: string, value: string | null, fallback: Date | null): Date | null {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw RecoveryErrors.invalid(field, 'Date ISO 8601 attendue.');
  return date;
}

/**
 * Mode d'une saisie. Les incohérences de fond (tranches, taux hors bornes, mode interdit pour l'objet)
 * restent permises dans un brouillon : elles sont refusées à la publication (`ruleProblems`).
 */
function parseMode(input: PricingRuleInput): PricingMode {
  const kind = oneOf('mode', input.mode, MODES);
  switch (kind) {
    case 'fixed':
      return { kind, fixedAmount: optionalAmount('fixedAmount', input.fixedAmount) ?? 0 };
    case 'percentage':
      return { kind, rateBps: input.rateBps ?? 0 };
    case 'tiered':
      return {
        kind,
        tiers: input.tiers.map((tier): PricingTier => ({
          upTo: tier.upTo,
          rateBps: tier.rateBps,
          fixedAmount: tier.fixedAmount,
        })),
      };
    case 'by_stage': {
      const rates = Object.fromEntries(
        input.stageRates.map((rate, index) => [
          oneOf(`stageRates[${index}].stageGroup`, rate.stageGroup, STAGE_GROUPS),
          rate.rateBps,
        ]),
      ) as Partial<Record<StageGroup, number>>;
      const missing = STAGE_GROUPS.filter((group) => rates[group] === undefined);
      if (missing.length > 0) {
        throw RecoveryErrors.invalid('stageRates', `Taux manquant pour : ${missing.join(', ')}.`);
      }
      return { kind, stageRates: rates as Record<StageGroup, number> };
    }
  }
}

/** Règle du domaine construite depuis une saisie (création ou modification d'un brouillon). */
function draftFrom(
  input: PricingRuleInput,
  base: { id: string; createdBy: string; now: Date },
): { rule: PricingRule; label: string; creditorType: 'user' | 'organization' | null } {
  const label = input.label.trim();
  if (label.length < 1 || label.length > 120) {
    throw RecoveryErrors.invalid('label', 'Libellé de 1 à 120 caractères.');
  }
  const object = oneOf('object', input.object, OBJECTS);
  const offer = oneOf('target.offer', input.offer || 'any', OFFERS);
  let creditorType: 'user' | 'organization' | null = null;
  if (input.creditor) {
    creditorType = oneOf('target.creditor.type', input.creditor.type, ['user', 'organization'] as const);
    if (!UUID.test(input.creditor.id))
      throw RecoveryErrors.invalid('target.creditor.id', 'Identifiant invalide.');
  }
  const communeKey = input.communeKey?.trim() || null;
  if (communeKey !== null && communeKey.length > 64) {
    throw RecoveryErrors.invalid('target.communeKey', 'Clé de commune de 64 caractères au plus.');
  }
  const validFrom = parseDate('validFrom', input.validFrom, base.now)!;
  const validUntil = parseDate('validUntil', input.validUntil, null);
  if (validUntil && validUntil <= validFrom) {
    throw RecoveryErrors.invalid('validUntil', 'La fin de validité suit le début.');
  }
  if (input.previousVersionId !== null && !UUID.test(input.previousVersionId)) {
    throw RecoveryErrors.invalid('previousVersionId', 'Identifiant invalide.');
  }
  return {
    label,
    creditorType,
    rule: {
      id: base.id,
      object,
      mode: parseMode(input),
      bounds: {
        minimum: optionalAmount('minimum', input.minimum),
        maximum: optionalAmount('maximum', input.maximum),
      },
      target: { offer, communeKey, creditorId: input.creditor?.id ?? null },
      validFrom,
      validUntil,
      status: 'draft',
      version: 0,
      createdBy: base.createdBy,
      approvedBy: null,
      previousVersionId: input.previousVersionId,
    },
  };
}

/** Empreinte d'une saisie : un rejeu de la même clé doit porter exactement la même saisie. */
function fingerprint(stored: StoredPricingRule): string {
  const { rule } = stored;
  return JSON.stringify([
    rule.object,
    rule.mode,
    rule.bounds,
    rule.target,
    rule.validUntil?.toISOString() ?? null,
    stored.label,
    rule.previousVersionId,
  ]);
}

async function requireRule(rules: PricingRuleStore, id: string): Promise<StoredPricingRule> {
  if (!UUID.test(id)) throw RecoveryErrors.pricingRuleNotFound();
  const found = await rules.find(id);
  if (!found) throw RecoveryErrors.pricingRuleNotFound();
  return found;
}

function requirePage(page: { limit?: number; cursor?: string } | undefined): {
  limit: number;
  cursor: string | null;
} {
  const limit = page?.limit && page.limit > 0 ? page.limit : 20;
  if (limit > 100) throw RecoveryErrors.invalid('page.limit', '100 au plus.');
  return { limit, cursor: page?.cursor || null };
}

export class ListPricingRulesUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: {
    object: string;
    statuses: readonly string[];
    offer: string;
    creditorId: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: StoredPricingRule[]; nextCursor: string | null }> {
    requireStaff(PRICING_READERS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    const filter: PricingRuleFilter = {};
    if (input.object) filter.object = oneOf('object', input.object, OBJECTS);
    if (input.statuses.length > 0) {
      filter.statuses = input.statuses.map((status, i) => oneOf(`statuses[${i}]`, status, STATUSES));
    }
    if (input.offer) filter.offer = oneOf('offer', input.offer, OFFERS);
    if (input.creditorId) {
      if (!UUID.test(input.creditorId)) throw RecoveryErrors.invalid('creditorId', 'Identifiant invalide.');
      filter.creditorId = input.creditorId;
    }
    return this.deps.rules.list(filter, requirePage(input.page));
  }
}

export class GetPricingRuleUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: { ruleId: string }): Promise<StoredPricingRule> {
    requireStaff(PRICING_READERS, BACKOFFICE_MFA_SECONDS, this.deps.clock.now().getTime());
    return requireRule(this.deps.rules, input.ruleId);
  }
}

/**
 * Brouillon de règle (CreatePricingRule, ADR-062). Idempotent par (auteur, clé) : le rejeu de la même
 * saisie rend la même règle, une autre saisie avec la même clé est refusée. Une nouvelle version d'une
 * règle publiée la désigne par `previousVersionId` (même objet).
 */
export class CreatePricingRuleUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: { idempotencyKey: string; input: PricingRuleInput }): Promise<StoredPricingRule> {
    const now = this.deps.clock.now();
    const staff = requireStaff(RECOVERY_ADMINS, BACKOFFICE_MFA_SECONDS, now.getTime());
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw RecoveryErrors.invalid(
        'idempotencyKey',
        'Clé de 8 à 100 caractères (lettres, chiffres, _ et -).',
      );
    }
    const built = draftFrom(input.input, { id: this.deps.ids.next(), createdBy: staff.userId, now });
    const stored: StoredPricingRule = {
      rule: built.rule,
      label: built.label,
      creditorType: built.creditorType,
      publishedAt: null,
      archivedAt: null,
      archiveReason: null,
      createdAt: now,
    };
    const existing = await this.deps.rules.findByIdempotencyKey(staff.userId, input.idempotencyKey);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(stored)) throw RecoveryErrors.keyReused();
      return existing;
    }
    if (built.rule.previousVersionId) {
      const previous = await requireRule(this.deps.rules, built.rule.previousVersionId);
      if (previous.rule.object !== built.rule.object || previous.rule.status !== 'published') {
        throw RecoveryErrors.invalid(
          'previousVersionId',
          'Une nouvelle version remplace une règle publiée du même objet.',
        );
      }
    }
    await this.deps.rules.insert(stored, input.idempotencyKey);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'pricing_rule.created',
      entityType: 'pricing_rule',
      entityId: stored.rule.id,
      details: { object: stored.rule.object, mode: stored.rule.mode.kind },
    });
    return stored;
  }
}

/** Modification d'un brouillon (UpdatePricingRule) ; une règle publiée ne change plus. */
export class UpdatePricingRuleUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: { ruleId: string; input: PricingRuleInput }): Promise<StoredPricingRule> {
    const now = this.deps.clock.now();
    const staff = requireStaff(RECOVERY_ADMINS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const current = await requireRule(this.deps.rules, input.ruleId);
    if (current.rule.status !== 'draft') {
      unwrap({ ok: false, code: 'RECOVERY_INVALID_TRANSITION', reason: 'Seul un brouillon se modifie.' });
    }
    const built = draftFrom(input.input, { id: current.rule.id, createdBy: current.rule.createdBy, now });
    const updated: StoredPricingRule = {
      ...current,
      rule: built.rule,
      label: built.label,
      creditorType: built.creditorType,
    };
    await this.deps.rules.update(updated);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'pricing_rule.updated',
      entityType: 'pricing_rule',
      entityId: updated.rule.id,
    });
    return updated;
  }
}

/**
 * Une règle ne s'applique jamais avant sa mise en vigueur : un début de validité passé (celui de la
 * création du brouillon, par défaut) est ramené à l'instant de la publication ou de la validation.
 */
function startingNoEarlierThan(rule: PricingRule, now: Date): PricingRule {
  return rule.validFrom < now ? { ...rule, validFrom: now } : rule;
}

/** Règles du même objet utiles à la mise en vigueur (hors archivées). */
async function siblings(rules: PricingRuleStore, rule: PricingRule): Promise<PricingRule[]> {
  return (await rules.listByObject(rule.object)).map((stored) => stored.rule);
}

/**
 * Publication (PublishPricingRule) : règle complète, une seule en vigueur par objet et par cible. Un
 * tarif négocié pour un créancier attend la validation d'une seconde personne (R-TA-04). Action
 * sensible : double authentification de moins de 10 minutes.
 */
export class PublishPricingRuleUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: { ruleId: string }): Promise<StoredPricingRule> {
    const now = this.deps.clock.now();
    const staff = requireStaff(RECOVERY_ADMINS, CRITICAL_MFA_SECONDS, now.getTime());
    const current = await requireRule(this.deps.rules, input.ruleId);
    const rule = startingNoEarlierThan(current.rule, now);
    const publication = unwrap(publishRule(rule, await siblings(this.deps.rules, rule), now));
    const published: StoredPricingRule = {
      ...current,
      rule: publication.rule,
      publishedAt: publication.rule.status === 'published' ? now : null,
    };
    await this.deps.rules.publish(published, publication.superseded, now);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: publication.rule.status === 'published' ? 'pricing_rule.published' : 'pricing_rule.submitted',
      entityType: 'pricing_rule',
      entityId: published.rule.id,
      details: { version: published.rule.version, superseded: publication.superseded.map((s) => s.ruleId) },
    });
    return published;
  }
}

/** Validation d'un tarif négocié par une autre personne que son auteur (ApprovePricingRule, R-TA-04). */
export class ApprovePricingRuleUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: { ruleId: string }): Promise<StoredPricingRule> {
    const now = this.deps.clock.now();
    const staff = requireStaff(RECOVERY_ADMINS, CRITICAL_MFA_SECONDS, now.getTime());
    const current = await requireRule(this.deps.rules, input.ruleId);
    const rule = startingNoEarlierThan(current.rule, now);
    const publication = unwrap(approveRule(rule, staff.userId, await siblings(this.deps.rules, rule), now));
    const published: StoredPricingRule = { ...current, rule: publication.rule, publishedAt: now };
    await this.deps.rules.publish(published, publication.superseded, now);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'pricing_rule.approved',
      entityType: 'pricing_rule',
      entityId: published.rule.id,
      details: { version: published.rule.version, createdBy: current.rule.createdBy },
    });
    return published;
  }
}

/** Archivage d'une règle publiée ou en attente (ArchivePricingRule) : motif obligatoire. */
export class ArchivePricingRuleUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: { ruleId: string; reason: string }): Promise<StoredPricingRule> {
    const now = this.deps.clock.now();
    const staff = requireStaff(RECOVERY_ADMINS, CRITICAL_MFA_SECONDS, now.getTime());
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3 || reason.length > 500) {
      throw RecoveryErrors.invalid('reason', 'Motif de 3 à 500 caractères.');
    }
    const current = await requireRule(this.deps.rules, input.ruleId);
    const archived: StoredPricingRule = {
      ...current,
      rule: unwrap(archiveRule(current.rule)),
      archivedAt: now,
      archiveReason: reason,
    };
    await this.deps.rules.update(archived);
    await this.deps.audit.record({
      actorId: staff.userId,
      action: 'pricing_rule.archived',
      entityType: 'pricing_rule',
      entityId: archived.rule.id,
      details: { reason },
    });
    return archived;
  }
}

/** Ligne de calcul rendue par le simulateur et l'estimation. */
export interface PricingLine {
  label: string;
  base: number;
  rateBps: number | null;
  amount: number;
}

export interface PricingResult extends PricedAmount {
  rule: PricingRule;
  lines: PricingLine[];
}

const STAGE_GROUP_LABELS: Record<StageGroup, string> = {
  amicable: 'à l’amiable',
  formal_notice: 'après mise en demeure',
  litigation: 'au contentieux',
};

/** Montant d'une règle sur une base, avec le détail ligne par ligne (R-TA-01). */
export function priceWithRule(rule: PricingRule, base: number, group: StageGroup): PricingResult {
  if (rule.object === 'case_fee') {
    const priced = caseFee(rule, base);
    return {
      ...priced,
      rule,
      lines: [{ label: 'Frais de dossier', base, rateBps: null, amount: priced.amount }],
    };
  }
  if (rule.object === 'study_fee') {
    const amount = studyFee(rule, base);
    return {
      amount,
      boundApplied: null,
      rule,
      lines: [{ label: 'Forfait d’étude', base, rateBps: null, amount }],
    };
  }
  const result = commission(rule, {
    base,
    collectedBefore: 0,
    commissionBefore: 0,
    stageGroup: group,
    closesCase: true,
  });
  const rateBps =
    rule.mode.kind === 'percentage'
      ? rule.mode.rateBps
      : rule.mode.kind === 'by_stage'
        ? rule.mode.stageRates[group]
        : null;
  return {
    amount: result.commission,
    boundApplied: result.boundApplied,
    rule,
    lines: [
      { label: `Commission ${STAGE_GROUP_LABELS[group]}`, base, rateBps, amount: result.commission },
      { label: 'Reversé au créancier', base, rateBps: null, amount: result.net },
    ],
  };
}

function stageFrom(value: string): StageGroup {
  if (!value) return 'amicable';
  const stage = oneOf('stage', value, [...STAGE_ORDER, ...STAGE_GROUPS] as readonly string[]);
  return (STAGE_GROUPS as readonly string[]).includes(stage)
    ? (stage as StageGroup)
    : stageGroup(stage as CaseStage);
}

/**
 * Simulateur du back-office (SimulatePricing, R-TA-01) : une règle désignée (brouillon compris), ou la
 * règle publiée applicable à la cible. La commission est simulée sur un dossier soldé par cet
 * encaissement, à l'étape demandée (amiable par défaut).
 */
export class SimulatePricingUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: {
    ruleId: string;
    object: string;
    offer: string;
    communeKey: string | null;
    creditorId: string | null;
    baseAmount: number;
    stage: string;
  }): Promise<PricingResult> {
    const now = this.deps.clock.now();
    requireStaff(PRICING_READERS, BACKOFFICE_MFA_SECONDS, now.getTime());
    if (!isWholeAmount(input.baseAmount) || input.baseAmount < 1) {
      throw RecoveryErrors.invalid('baseAmount', 'Montant entier positif attendu.');
    }
    const group = stageFrom(input.stage);
    if (input.ruleId) {
      return priceWithRule((await requireRule(this.deps.rules, input.ruleId)).rule, input.baseAmount, group);
    }
    const object = oneOf('object', input.object, OBJECTS);
    const offer = oneOf('target.offer', input.offer, ['b2b', 'b2c', 'rent'] as const);
    const rules = (await this.deps.rules.listByObject(object)).map((stored) => stored.rule);
    const rule = resolveRule(
      rules,
      object,
      { offer, communeKey: input.communeKey, creditorId: input.creditorId },
      now,
    );
    if (!rule) throw RecoveryErrors.noApplicableRule(object);
    return priceWithRule(rule, input.baseAmount, group);
  }
}

/** Description lisible d'une commission (« 10 % à l'amiable, 15 % après mise en demeure… »). */
export function describeCommission(rule: PricingRule): string {
  const percent = (bps: number) => `${new Intl.NumberFormat('fr-FR').format(bps / 100)} %`;
  let text: string;
  switch (rule.mode.kind) {
    case 'fixed':
      text = `${formatXof(rule.mode.fixedAmount)} par encaissement`;
      break;
    case 'percentage':
      text = `${percent(rule.mode.rateBps)} des sommes recouvrées`;
      break;
    case 'by_stage': {
      const rates = rule.mode.stageRates;
      text = STAGE_GROUPS.map((group) => `${percent(rates[group])} ${STAGE_GROUP_LABELS[group]}`).join(', ');
      break;
    }
    case 'tiered': {
      let from = 0;
      text = rule.mode.tiers
        .map((tier) => {
          const rate = percent(tier.rateBps ?? 0);
          const part =
            tier.upTo === null
              ? `${rate} au-delà de ${formatXof(from)}`
              : `${rate} jusqu'à ${formatXof(tier.upTo)}`;
          from = tier.upTo ?? from;
          return part;
        })
        .join(', ');
      break;
    }
  }
  const bounds: string[] = [];
  if (rule.bounds.minimum !== null) bounds.push(`minimum ${formatXof(rule.bounds.minimum)} par dossier`);
  if (rule.bounds.maximum !== null) bounds.push(`maximum ${formatXof(rule.bounds.maximum)} par encaissement`);
  return bounds.length > 0 ? `${text} ; ${bounds.join(', ')}` : text;
}

export interface CaseFeesEstimate {
  caseFee: number;
  minimumAmountDue: number;
  feeRule: PricingRule;
  commissionRule: PricingRule;
  commissionSummary: string;
  stageRates: { stageGroup: StageGroup; rateBps: number }[];
}

/**
 * Frais de dossier et commission applicables avant l'envoi (EstimateCaseFees, R-TA-03) : règles
 * publiées pour l'offre, la commune et le créancier connecté (tarif négocié prioritaire, R-TA-04).
 */
export class EstimateCaseFeesUseCase {
  constructor(private readonly deps: PricingDeps) {}

  async execute(input: {
    kind: string;
    amountDue: number;
    communeKey: string | null;
  }): Promise<CaseFeesEstimate> {
    const creditor = currentCreditor();
    const now = this.deps.clock.now();
    const offer = oneOf('kind', input.kind, ['b2b', 'b2c', 'rent'] as const);
    if (!isWholeAmount(input.amountDue) || input.amountDue < 1) {
      throw RecoveryErrors.invalid('amountDue', 'Montant entier positif attendu.');
    }
    const { settings } = await loadSettings(this.deps.settings);
    if (input.amountDue < settings.minimumCaseAmount) {
      throw RecoveryErrors.amountBelowMinimum(settings.minimumCaseAmount);
    }
    const query = { offer, communeKey: input.communeKey?.trim() || null, creditorId: creditor.holder.id };
    const resolve = async (object: PricingObject) => {
      const rules = (await this.deps.rules.listByObject(object)).map((stored) => stored.rule);
      const rule = resolveRule(rules, object, query, now);
      if (!rule) throw RecoveryErrors.noApplicableRule(object);
      return rule;
    };
    const feeRule = await resolve('case_fee');
    const commissionRule = await resolve('recovery_commission');
    return {
      caseFee: caseFee(feeRule, input.amountDue).amount,
      minimumAmountDue: settings.minimumCaseAmount,
      feeRule,
      commissionRule,
      commissionSummary: describeCommission(commissionRule),
      stageRates:
        commissionRule.mode.kind === 'by_stage'
          ? STAGE_GROUPS.map((group) => ({
              stageGroup: group,
              rateBps: (commissionRule.mode as { stageRates: Record<StageGroup, number> }).stageRates[group],
            }))
          : [],
    };
  }
}
