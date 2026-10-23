import {
  DEFAULT_TEAM_SIZE,
  isCode,
  normalizeCommune,
  pricingProblems,
  SERVICE_UNITS,
  type ServiceDefinition,
} from '../../domain/catalog';
import { BASIS_POINTS } from '../../domain/money';
import { type CleaningSettings, settingsProblems } from '../../domain/settings';
import { type CleaningDeps } from '../deps';
import { type NewPricing, type StoredSettings } from '../ports';
import { ADMINISTRATION, requireStaff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { oneOf, optionalText, requiredText } from '../shared/validation';

/** UC-CL-11 : catalogue complet (prestations actives et inactives, grille en vigueur, réglages). */
export class GetCatalogUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<{ services: ServiceDefinition[]; settings: StoredSettings }> {
    requireStaff(ADMINISTRATION);
    const [services, settings] = await Promise.all([
      this.deps.catalog.listServices(),
      this.deps.catalog.getSettings(),
    ]);
    return { services, settings };
  }
}

export interface SaveServiceInput {
  code: string;
  name: string;
  description: string;
  unit: string;
  active: boolean;
  pricing: {
    unitPrice: number | null;
    minimumPrice: number | null;
    options: { code: string; label: string; price: number | null }[];
    communeCoefficients: { commune: string; coefficientBp: number }[];
    defaultCoefficientBp: number;
    teamSize: { unitsPerAgent: number; minAgents: number; maxAgents: number } | null;
    checklist: { code: string; label: string }[];
  };
}

/**
 * UC-CL-11 : créer ou modifier une prestation et sa grille. Chaque enregistrement crée une
 * nouvelle version datée, avec son auteur ; les devis déjà envoyés gardent leur prix.
 */
export class SaveServiceUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SaveServiceInput): Promise<ServiceDefinition> {
    const staff = requireStaff(ADMINISTRATION);
    if (!isCode(input.code)) throw CleaningErrors.invalid('code');
    const service = {
      code: input.code,
      name: requiredText('name', input.name, 100),
      description: optionalText('description', input.description, 1000) ?? '',
      unit: oneOf('unit', input.unit, SERVICE_UNITS),
      active: input.active,
    };
    const pricing: NewPricing = {
      unitPrice: input.pricing.unitPrice,
      minimumPrice: input.pricing.minimumPrice,
      options: input.pricing.options.map((option) => ({ ...option, label: option.label.trim() })),
      communeCoefficients: Object.fromEntries(
        input.pricing.communeCoefficients.map((entry) => [
          normalizeCommune(entry.commune),
          entry.coefficientBp,
        ]),
      ),
      defaultCoefficientBp: input.pricing.defaultCoefficientBp || BASIS_POINTS,
      teamSize: input.pricing.teamSize ?? DEFAULT_TEAM_SIZE,
      checklist: input.pricing.checklist.map((item) => ({ ...item, label: item.label.trim() })),
    };
    const problems = pricingProblems(pricing);
    if (problems.length) throw CleaningErrors.invalid(`pricing.${problems[0]}`);

    const now = this.deps.clock.now();
    return this.deps.catalog.saveService(service, pricing, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'service.saved',
          entityType: 'service',
          entityId: service.code,
          at: now,
          details: {
            unitPrice: pricing.unitPrice,
            minimumPrice: pricing.minimumPrice,
            active: service.active,
          },
        },
      ],
    });
  }
}

/** UC-CL-11 : réglages de la partie 4 (validité, délais, seuil de visite, acompte…). */
export class UpdateSettingsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(settings: CleaningSettings): Promise<StoredSettings> {
    const staff = requireStaff(ADMINISTRATION);
    const problems = settingsProblems(settings);
    if (problems.length) throw CleaningErrors.invalid(`settings.${problems[0]}`);
    return this.deps.catalog.saveSettings(settings, {
      events: [],
      audit: [
        {
          actorId: staff.userId,
          action: 'settings.updated',
          entityType: 'settings',
          entityId: 'cleaning',
          at: this.deps.clock.now(),
          details: { ...settings },
        },
      ],
    });
  }
}
