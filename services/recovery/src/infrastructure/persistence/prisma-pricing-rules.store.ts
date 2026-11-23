import { Injectable } from '@nestjs/common';
import { type Prisma, type PricingRule as PricingRow } from '../../../prisma/generated';
import {
  type PricingRuleFilter,
  type PricingRuleStore,
  type StoredPricingRule,
} from '../../application/ports';
import { type StageGroup } from '../../domain/case';
import {
  type Offer,
  type PricingMode,
  type PricingObject,
  type PricingTier,
  type RuleStatus,
} from '../../domain/pricing';
import { PrismaService } from '../prisma/prisma.service';

/** Ligne de la table → règle du domaine et champs d'affichage. */
export function toStored(row: PricingRow): StoredPricingRule {
  return {
    rule: {
      id: row.id,
      object: row.object as PricingObject,
      mode: modeOf(row),
      bounds: { minimum: row.minimum, maximum: row.maximum },
      target: { offer: row.offer as Offer, communeKey: row.communeKey, creditorId: row.creditorId },
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      status: row.status as RuleStatus,
      version: row.version,
      createdBy: row.createdBy,
      approvedBy: row.approvedBy,
      previousVersionId: row.previousVersionId,
    },
    label: row.label,
    creditorType: row.creditorType,
    publishedAt: row.publishedAt,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
    createdAt: row.createdAt,
  };
}

function modeOf(row: PricingRow): PricingMode {
  switch (row.mode) {
    case 'percentage':
      return { kind: 'percentage', rateBps: row.rateBps ?? 0 };
    case 'tiered':
      return { kind: 'tiered', tiers: (row.tiers ?? []) as unknown as PricingTier[] };
    case 'by_stage':
      return { kind: 'by_stage', stageRates: row.stageRates as unknown as Record<StageGroup, number> };
    default:
      return { kind: 'fixed', fixedAmount: row.fixedAmount ?? 0 };
  }
}

/** Règle → colonnes (création ou mise à jour). */
function columnsOf(stored: StoredPricingRule) {
  const { rule } = stored;
  const mode = rule.mode;
  return {
    object: rule.object,
    mode: mode.kind,
    fixedAmount: mode.kind === 'fixed' ? mode.fixedAmount : null,
    rateBps: mode.kind === 'percentage' ? mode.rateBps : null,
    tiers: mode.kind === 'tiered' ? (mode.tiers as unknown as Prisma.InputJsonValue) : undefined,
    stageRates: mode.kind === 'by_stage' ? (mode.stageRates as unknown as Prisma.InputJsonValue) : undefined,
    minimum: rule.bounds.minimum,
    maximum: rule.bounds.maximum,
    offer: rule.target.offer,
    communeKey: rule.target.communeKey,
    creditorType: stored.creditorType,
    creditorId: rule.target.creditorId,
    validFrom: rule.validFrom,
    validUntil: rule.validUntil,
    status: rule.status,
    version: rule.version,
    label: stored.label,
    createdBy: rule.createdBy,
    approvedBy: rule.approvedBy,
    publishedAt: stored.publishedAt,
    archivedAt: stored.archivedAt,
    archiveReason: stored.archiveReason,
    previousVersionId: rule.previousVersionId,
  };
}

/**
 * Règles tarifaires (ADR-062). Liste par curseur (identifiant UUID v7, plus récent d'abord). La
 * publication et l'archivage des règles remplacées se font dans une seule transaction.
 */
@Injectable()
export class PrismaPricingRuleStore implements PricingRuleStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(id: string): Promise<StoredPricingRule | null> {
    const row = await this.prisma.pricingRule.findUnique({ where: { id } });
    return row ? toStored(row) : null;
  }

  async findByIdempotencyKey(createdBy: string, key: string): Promise<StoredPricingRule | null> {
    const row = await this.prisma.pricingRule.findUnique({
      where: { createdBy_idempotencyKey: { createdBy, idempotencyKey: key } },
    });
    return row ? toStored(row) : null;
  }

  async list(
    filter: PricingRuleFilter,
    page: { limit: number; cursor: string | null },
  ): Promise<{ items: StoredPricingRule[]; nextCursor: string | null }> {
    const rows = await this.prisma.pricingRule.findMany({
      where: {
        ...(filter.object ? { object: filter.object } : {}),
        ...(filter.statuses?.length ? { status: { in: [...filter.statuses] } } : {}),
        ...(filter.offer ? { offer: filter.offer } : {}),
        ...(filter.creditorId ? { creditorId: filter.creditorId } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(toStored);
    return { items, nextCursor: rows.length > page.limit ? items[items.length - 1]!.rule.id : null };
  }

  async listByObject(object: PricingObject): Promise<StoredPricingRule[]> {
    const rows = await this.prisma.pricingRule.findMany({
      where: { object, status: { not: 'archived' } },
      orderBy: { validFrom: 'asc' },
    });
    return rows.map(toStored);
  }

  async insert(stored: StoredPricingRule, idempotencyKey: string | null): Promise<void> {
    await this.prisma.pricingRule.create({
      data: { id: stored.rule.id, ...columnsOf(stored), idempotencyKey, createdAt: stored.createdAt },
    });
  }

  async update(stored: StoredPricingRule): Promise<void> {
    await this.prisma.pricingRule.update({ where: { id: stored.rule.id }, data: columnsOf(stored) });
  }

  async publish(
    stored: StoredPricingRule,
    superseded: readonly { ruleId: string; action: 'archive' | 'end_at'; validUntil?: Date }[],
    at: Date,
  ): Promise<void> {
    await this.prisma.$transaction([
      ...superseded.map((change) =>
        this.prisma.pricingRule.update({
          where: { id: change.ruleId },
          data:
            change.action === 'archive'
              ? { status: 'archived', archivedAt: at, archiveReason: `remplacée par ${stored.rule.id}` }
              : { validUntil: change.validUntil ?? at },
        }),
      ),
      this.prisma.pricingRule.update({ where: { id: stored.rule.id }, data: columnsOf(stored) }),
    ]);
  }
}
