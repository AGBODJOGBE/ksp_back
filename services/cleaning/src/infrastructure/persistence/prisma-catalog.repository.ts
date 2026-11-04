import { Injectable } from '@nestjs/common';
import { type CleaningService, type PricingRule as PricingRow } from '../../../prisma/generated';
import {
  type Changes,
  type CatalogRepository,
  type NewServiceVersion,
  type StoredSettings,
} from '../../application/ports';
import {
  type ChecklistTemplateItem,
  DEFAULT_TEAM_SIZE,
  type FormField,
  type LegacyUnit,
  type ServiceDefinition,
  type ServiceFrequency,
  type ServiceOption,
  type TeamSizeRule,
  teamSizeField,
} from '../../domain/catalog';
import { BASIS_POINTS } from '../../domain/money';
import { type CleaningSettings, DEFAULT_SETTINGS } from '../../domain/settings';
import { type Zone } from '../../domain/zone';
import { UuidV7Generator } from '../system/system';
import { PrismaService } from '../prisma/prisma.service';
import { json, writeChanges } from './changes';

const ids = new UuidV7Generator();

/** Grille vide d'une prestation créée avant toute saisie (aucune version). */
const EMPTY_PRICING = {
  version: 0,
  minimumPrice: null,
  communeCoefficients: {},
  defaultCoefficientBp: BASIS_POINTS,
  frequencies: [],
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
    unit: row.unit as LegacyUnit,
    active: row.active,
    fields: (latest?.fields ?? []) as unknown as FormField[],
    options: (latest?.optionDefinitions ?? []) as unknown as ServiceOption[],
    pricing: latest
      ? {
          version: latest.version,
          minimumPrice: latest.minimumPrice,
          communeCoefficients: latest.communeCoefficients as Record<string, number>,
          defaultCoefficientBp: latest.defaultCoefficientBp,
          frequencies: latest.frequencies as unknown as ServiceFrequency[],
          // Versions antérieures à l'ADR-033 : pas de champ désigné.
          teamSize: { fieldCode: null, ...(latest.teamSize as object) } as TeamSizeRule,
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

  async saveService(definition: NewServiceVersion, changes: Changes): Promise<ServiceDefinition> {
    const author = changes.audit[0]?.actorId ?? 'system';
    const at = changes.audit[0]?.at ?? new Date();
    const { code, name, description, unit, active, fields, options, pricing } = definition;
    await this.prisma.$transaction(async (tx) => {
      await tx.cleaningService.upsert({
        where: { code },
        create: { code, name, description, unit, active },
        update: { name, description, unit, active },
      });
      const last = await tx.pricingRule.findFirst({
        where: { serviceCode: code },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.pricingRule.create({
        data: {
          id: ids.next(),
          serviceCode: code,
          version: (last?.version ?? 0) + 1,
          // Anciennes colonnes, déduites pour les anciens lecteurs (ADR-033).
          unitPrice: teamSizeField(definition)?.pricePerUnit ?? null,
          options: json(
            options.map((option) => ({ code: option.code, label: option.label, price: option.flatPrice })),
          ),
          minimumPrice: pricing.minimumPrice,
          communeCoefficients: json(pricing.communeCoefficients),
          defaultCoefficientBp: pricing.defaultCoefficientBp,
          teamSize: json(pricing.teamSize),
          checklist: json(pricing.checklist),
          fields: json(fields),
          optionDefinitions: json(options),
          frequencies: json(pricing.frequencies),
          createdBy: author,
          createdAt: at,
        },
      });
      await writeChanges(tx, changes, () => ids.next());
    });
    return (await this.findService(code))!;
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
