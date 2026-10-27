import { Injectable } from '@nestjs/common';
import { type CleaningService, type PricingRule as PricingRow } from '../../../prisma/generated';
import {
  type Changes,
  type CatalogRepository,
  type NewPricing,
  type StoredSettings,
} from '../../application/ports';
import {
  type ChecklistTemplateItem,
  DEFAULT_TEAM_SIZE,
  type PricedOption,
  type ServiceDefinition,
  type ServiceUnit,
  type TeamSizeRule,
} from '../../domain/catalog';
import { BASIS_POINTS } from '../../domain/money';
import { type CleaningSettings, DEFAULT_SETTINGS } from '../../domain/settings';
import { type Zone } from '../../domain/zone';
import { UuidV7Generator } from '../system/system';
import { PrismaService } from '../prisma/prisma.service';
import { json, writeChanges } from './changes';

const ids = new UuidV7Generator();

/** Grille vide d'une prestation créée avant toute saisie de prix. */
const EMPTY_PRICING = {
  version: 0,
  unitPrice: null,
  minimumPrice: null,
  options: [],
  communeCoefficients: {},
  defaultCoefficientBp: BASIS_POINTS,
  teamSize: DEFAULT_TEAM_SIZE,
  checklist: [],
  updatedBy: '',
  updatedAt: new Date(0),
};

function toService(row: CleaningService & { pricing: PricingRow[] }): ServiceDefinition {
  const latest = row.pricing[0];
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    unit: row.unit as ServiceUnit,
    active: row.active,
    pricing: latest
      ? {
          version: latest.version,
          unitPrice: latest.unitPrice,
          minimumPrice: latest.minimumPrice,
          options: latest.options as unknown as PricedOption[],
          communeCoefficients: latest.communeCoefficients as Record<string, number>,
          defaultCoefficientBp: latest.defaultCoefficientBp,
          teamSize: latest.teamSize as unknown as TeamSizeRule,
          checklist: latest.checklist as unknown as ChecklistTemplateItem[],
          updatedBy: latest.createdBy,
          updatedAt: latest.createdAt,
        }
      : EMPTY_PRICING,
  };
}

/** Seule la version la plus récente de la grille est lue : c'est celle en vigueur. */
const WITH_CURRENT_PRICING = { pricing: { orderBy: { version: 'desc' as const }, take: 1 } };

@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listServices(): Promise<ServiceDefinition[]> {
    const rows = await this.prisma.cleaningService.findMany({
      include: WITH_CURRENT_PRICING,
      orderBy: { code: 'asc' },
    });
    return rows.map(toService);
  }

  async findService(code: string): Promise<ServiceDefinition | null> {
    const row = await this.prisma.cleaningService.findUnique({
      where: { code },
      include: WITH_CURRENT_PRICING,
    });
    return row ? toService(row) : null;
  }

  async saveService(
    service: Omit<ServiceDefinition, 'pricing'>,
    pricing: NewPricing,
    changes: Changes,
  ): Promise<ServiceDefinition> {
    const author = changes.audit[0]?.actorId ?? 'system';
    const at = changes.audit[0]?.at ?? new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.cleaningService.upsert({
        where: { code: service.code },
        create: { ...service },
        update: {
          name: service.name,
          description: service.description,
          unit: service.unit,
          active: service.active,
        },
      });
      const last = await tx.pricingRule.findFirst({
        where: { serviceCode: service.code },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.pricingRule.create({
        data: {
          id: ids.next(),
          serviceCode: service.code,
          version: (last?.version ?? 0) + 1,
          unitPrice: pricing.unitPrice,
          minimumPrice: pricing.minimumPrice,
          options: json(pricing.options),
          communeCoefficients: json(pricing.communeCoefficients),
          defaultCoefficientBp: pricing.defaultCoefficientBp,
          teamSize: json(pricing.teamSize),
          checklist: json(pricing.checklist),
          createdBy: author,
          createdAt: at,
        },
      });
      await writeChanges(tx, changes, () => ids.next());
    });
    return (await this.findService(service.code))!;
  }

  async getSettings(): Promise<StoredSettings> {
    const row = await this.prisma.cleaningSettings.findUnique({ where: { id: 1 } });
    if (!row) return { ...DEFAULT_SETTINGS, updatedBy: null, updatedAt: null };
    const { id: _id, ...settings } = row;
    return settings;
  }

  async saveSettings(settings: CleaningSettings, changes: Changes): Promise<StoredSettings> {
    const values = {
      ...settings,
      updatedBy: changes.audit[0]?.actorId ?? null,
      updatedAt: changes.audit[0]?.at ?? new Date(),
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.cleaningSettings.upsert({ where: { id: 1 }, create: { id: 1, ...values }, update: values });
      await writeChanges(tx, changes, () => ids.next());
    });
    return values;
  }

  async listZones(): Promise<Zone[]> {
    const rows = await this.prisma.serviceZone.findMany({ orderBy: { commune: 'asc' } });
    return rows.map((row) => ({
      code: row.code,
      commune: row.commune,
      active: row.active,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    }));
  }

  async saveZone(zone: Zone, changes: Changes): Promise<Zone> {
    const values = {
      commune: zone.commune,
      active: zone.active,
      updatedBy: zone.updatedBy,
      updatedAt: zone.updatedAt,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceZone.upsert({
        where: { code: zone.code },
        create: { code: zone.code, ...values },
        update: values,
      });
      await writeChanges(tx, changes, () => ids.next());
    });
    return zone;
  }
}
