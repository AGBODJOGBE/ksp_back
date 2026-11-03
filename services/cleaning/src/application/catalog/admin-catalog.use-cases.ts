import { type OptionSelection, type Answers } from '../../domain/answers';
import {
  DEFAULT_TEAM_SIZE,
  definitionProblems,
  type FieldType,
  type FormField,
  isCode,
  legacyUnit,
  normalizeCommune,
  type ServiceDefinition,
  type ServiceDraft,
} from '../../domain/catalog';
import { BASIS_POINTS } from '../../domain/money';
import { type CleaningSettings, mergeSettings, settingsProblems } from '../../domain/settings';
import { calculatePrice, type PriceCalculation } from '../../domain/simulator';
import { isCovered } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { type StoredSettings } from '../ports';
import { ADMINISTRATION, requireStaff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { requiredText, requirePositiveInt } from '../shared/validation';
import { resolveNewFormat } from './pricing-input';

/** UC-CL-11 : catalogue complet (prestations actives et inactives, définition en vigueur, réglages). */
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

export interface FieldInput {
  code: string;
  label: string;
  type: string;
  required: boolean;
  helpText?: string | null;
  active: boolean;
  unitLabel?: string | null;
  min?: number | null;
  max?: number | null;
  pricePerUnit?: number | null;
  choices?: {
    code: string;
    label: string;
    supplement: number | null;
    coefficientBp?: number | null;
    active: boolean;
  }[];
  supplementIfYes?: number | null;
  coefficientBpIfYes?: number | null;
}

/** Définition complète saisie au back-office, au nouveau format (ADR-033). */
export interface ServiceDefinitionInput {
  name: string;
  description: string;
  active: boolean;
  fields: FieldInput[];
  options: {
    code: string;
    label: string;
    description?: string | null;
    active: boolean;
    flatPrice: number | null;
    fields: FieldInput[];
  }[];
  pricing: {
    minimumPrice: number | null;
    communeCoefficients: { commune: string; coefficientBp: number }[];
    defaultCoefficientBp: number;
    frequencies: { code: string; label: string; coefficientBp: number; active: boolean }[];
    teamSize: {
      fieldCode: string | null;
      unitsPerAgent: number;
      minAgents: number;
      maxAgents: number;
    } | null;
    checklist: { code: string; label: string }[];
  };
}

const text = (value: string | null | undefined) => {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
};

/** Champ saisi → champ du domaine ; les propriétés propres à un autre type sont ignorées. */
function toField(input: FieldInput): FormField {
  const type = input.type as FieldType;
  return {
    code: input.code,
    label: input.label.trim(),
    type,
    required: input.required,
    helpText: text(input.helpText),
    active: input.active,
    unitLabel: type === 'number' ? text(input.unitLabel) : null,
    min: type === 'number' ? (input.min ?? null) : null,
    max: type === 'number' ? (input.max ?? null) : null,
    pricePerUnit: type === 'number' ? (input.pricePerUnit ?? null) : null,
    choices:
      type === 'choice'
        ? (input.choices ?? []).map((choice) => ({
            code: choice.code,
            label: choice.label.trim(),
            supplement: choice.supplement ?? null,
            coefficientBp: choice.coefficientBp || null,
            active: choice.active,
          }))
        : [],
    supplementIfYes: type === 'boolean' ? (input.supplementIfYes ?? null) : null,
    coefficientBpIfYes: type === 'boolean' ? input.coefficientBpIfYes || null : null,
  };
}

/** Définition saisie → brouillon du domaine. Ancien corps (sans champ) refusé : `fields` obligatoire. */
export function toDraft(input: ServiceDefinitionInput, prefix = ''): ServiceDraft {
  if (!input.fields.length) throw CleaningErrors.answerRefused(`${prefix}fields`, 'required');
  const draft: ServiceDraft = {
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    active: input.active,
    fields: input.fields.map(toField),
    options: input.options.map((option) => ({
      code: option.code,
      label: option.label.trim(),
      description: text(option.description),
      active: option.active,
      flatPrice: option.flatPrice ?? null,
      fields: option.fields.map(toField),
    })),
    pricing: {
      minimumPrice: input.pricing.minimumPrice,
      communeCoefficients: Object.fromEntries(
        input.pricing.communeCoefficients.map((entry) => [
          normalizeCommune(entry.commune),
          entry.coefficientBp,
        ]),
      ),
      defaultCoefficientBp: input.pricing.defaultCoefficientBp || BASIS_POINTS,
      frequencies: input.pricing.frequencies.map((frequency) => ({
        ...frequency,
        label: frequency.label.trim(),
      })),
      teamSize: input.pricing.teamSize
        ? { ...input.pricing.teamSize, fieldCode: input.pricing.teamSize.fieldCode || null }
        : DEFAULT_TEAM_SIZE,
      checklist: input.pricing.checklist.map((item) => ({ ...item, label: item.label.trim() })),
    },
  };
  const problems = definitionProblems(draft);
  if (problems.length) {
    throw CleaningErrors.invalid(`${prefix}${problems[0]}`, 'La définition de la prestation est invalide.');
  }
  return draft;
}

/**
 * UC-CL-11 : créer ou remplacer une prestation complète (champs, options, grille). Chaque
 * enregistrement crée une nouvelle version datée, avec son auteur ; les demandes et les devis
 * déjà enregistrés gardent leur version et leur prix.
 */
export class SaveServiceUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(code: string, input: ServiceDefinitionInput): Promise<ServiceDefinition> {
    const staff = requireStaff(ADMINISTRATION);
    if (!isCode(code)) throw CleaningErrors.invalid('code');
    const draft = toDraft(input);
    const now = this.deps.clock.now();
    return this.deps.catalog.saveService(
      { code, unit: legacyUnit(draft), ...draft },
      {
        events: [],
        audit: [
          {
            actorId: staff.userId,
            action: 'service.saved',
            entityType: 'service',
            entityId: code,
            at: now,
            details: {
              active: draft.active,
              minimumPrice: draft.pricing.minimumPrice,
              fields: draft.fields.length,
              options: draft.options.length,
            },
          },
        ],
      },
    );
  }
}

export interface PreviewServiceInput {
  serviceCode: string;
  /** Définition à essayer (non enregistrée) ; absente : version en vigueur. */
  definition?: ServiceDefinitionInput;
  answers: Answers;
  optionSelections: OptionSelection[];
  commune: string;
  frequency: string;
  requestedTeamSize: number;
}

export interface PreviewResult {
  serviceCode: string;
  calculation: PriceCalculation;
  covered: boolean;
}

/** UC-CL-11 : essayer une grille avant de l'enregistrer. Rien n'est enregistré. */
export class PreviewServiceUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: PreviewServiceInput): Promise<PreviewResult> {
    requireStaff(ADMINISTRATION);
    if (!isCode(input.serviceCode)) throw CleaningErrors.invalid('code');
    const commune = requiredText('commune', input.commune, 100);
    const requestedTeamSize = input.requestedTeamSize
      ? requirePositiveInt('requestedTeamSize', input.requestedTeamSize, 50)
      : 0;
    let service: ServiceDefinition;
    let version: number | null;
    if (input.definition) {
      const draft = toDraft(input.definition, 'definition.');
      service = {
        code: input.serviceCode,
        unit: legacyUnit(draft),
        ...draft,
        pricing: { ...draft.pricing, version: 0, updatedBy: '', updatedAt: this.deps.clock.now() },
      };
      version = null;
    } else {
      const current = await this.deps.catalog.findService(input.serviceCode);
      if (!current) throw CleaningErrors.serviceNotFound();
      service = current;
      version = current.pricing.version;
    }
    const { value } = resolveNewFormat(service, input);
    const calculation = calculatePrice(service, { ...value, commune, requestedTeamSize }, version);
    return {
      serviceCode: service.code,
      calculation,
      covered: isCovered(await this.deps.catalog.listZones(), commune),
    };
  }
}

/**
 * UC-CL-11 : réglages des parties 4 et 10 (validité, délais, acompte, seuils d'impayés). Un seuil
 * d'impayés à 0 garde la valeur en vigueur ; le seuil de visite, déprécié, est ignoré.
 */
export class UpdateSettingsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(update: CleaningSettings): Promise<StoredSettings> {
    const staff = requireStaff(ADMINISTRATION);
    const settings = mergeSettings(await this.deps.catalog.getSettings(), update);
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
