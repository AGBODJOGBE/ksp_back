import { BASIS_POINTS, isWholeAmount } from './money';

/**
 * Catalogue des prestations et grille tarifaire (UC-CL-11). La grille est un réglage modifiable
 * au back-office : tant que l'équipe Nettoyage ne l'a pas remplie, les prix sont absents (null).
 */
export const SERVICE_UNITS = ['square_meter', 'room', 'septic_tank', 'cubic_meter'] as const;
export type ServiceUnit = (typeof SERVICE_UNITS)[number];

export const PREMISES_TYPES = ['apartment', 'house', 'office', 'shop', 'warehouse', 'other'] as const;
export type PremisesType = (typeof PREMISES_TYPES)[number];

export interface PricedOption {
  code: string;
  label: string;
  /** null tant que l'option n'a pas de prix. */
  price: number | null;
}

/** Une personne pour `unitsPerAgent` unités, entre un minimum et un maximum. */
export interface TeamSizeRule {
  unitsPerAgent: number;
  minAgents: number;
  maxAgents: number;
}

export interface ChecklistTemplateItem {
  code: string;
  label: string;
}

/** Version datée de la grille d'une prestation : chaque modification en crée une nouvelle. */
export interface PricingRule {
  version: number;
  unitPrice: number | null;
  minimumPrice: number | null;
  options: PricedOption[];
  /** Coefficient par commune (clé normalisée), en points de base. */
  communeCoefficients: Record<string, number>;
  defaultCoefficientBp: number;
  teamSize: TeamSizeRule;
  checklist: ChecklistTemplateItem[];
  updatedBy: string;
  updatedAt: Date;
}

export interface ServiceDefinition {
  code: string;
  name: string;
  description: string;
  unit: ServiceUnit;
  active: boolean;
  pricing: PricingRule;
}

export const DEFAULT_TEAM_SIZE: TeamSizeRule = { unitsPerAgent: 100, minAgents: 1, maxAgents: 10 };

/** Liste de contrôle d'un passage quand la prestation n'en définit pas. */
export const DEFAULT_CHECKLIST: ChecklistTemplateItem[] = [
  { code: 'arrival', label: 'Arrivée sur place et accueil du client' },
  { code: 'cleaning_done', label: 'Prestation réalisée selon le devis' },
  { code: 'site_left_clean', label: 'Matériel rangé, déchets évacués' },
  { code: 'customer_review', label: 'Tour final avec le client' },
];

const CODE = /^[a-z][a-z0-9_]{1,49}$/;

export function isCode(value: string): boolean {
  return CODE.test(value);
}

/** Clé d'une commune : minuscules, sans accents, tirets à la place des espaces. */
export function normalizeCommune(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export function communeCoefficient(rule: PricingRule, commune: string): number {
  return rule.communeCoefficients[normalizeCommune(commune)] ?? rule.defaultCoefficientBp;
}

/**
 * Taille d'équipe recommandée : fonction de la quantité (surface, pièces…), ou de la demande
 * du client quand il la précise, toujours dans les bornes de la règle.
 */
export function recommendedTeamSize(rule: TeamSizeRule, quantity: number, requested = 0): number {
  const wanted = requested > 0 ? requested : Math.ceil(quantity / Math.max(1, rule.unitsPerAgent));
  return Math.min(rule.maxAgents, Math.max(rule.minAgents, wanted));
}

/** Contrôle d'une grille avant enregistrement : liste des champs en défaut, vide si elle est valide. */
export function pricingProblems(rule: Omit<PricingRule, 'version' | 'updatedBy' | 'updatedAt'>): string[] {
  const problems: string[] = [];
  const amount = (value: number | null, field: string) => {
    if (value !== null && !isWholeAmount(value)) problems.push(field);
  };
  amount(rule.unitPrice, 'unitPrice');
  amount(rule.minimumPrice, 'minimumPrice');
  const codes = new Set<string>();
  rule.options.forEach((option, index) => {
    if (!isCode(option.code) || codes.has(option.code)) problems.push(`options[${index}].code`);
    codes.add(option.code);
    if (!option.label.trim()) problems.push(`options[${index}].label`);
    amount(option.price, `options[${index}].price`);
  });
  const coefficient = (bp: number) => Number.isInteger(bp) && bp >= 1 && bp <= 10 * BASIS_POINTS;
  if (!coefficient(rule.defaultCoefficientBp)) problems.push('defaultCoefficientBp');
  for (const [commune, bp] of Object.entries(rule.communeCoefficients)) {
    if (!commune || !coefficient(bp)) problems.push(`communeCoefficients.${commune}`);
  }
  const { unitsPerAgent, minAgents, maxAgents } = rule.teamSize;
  if (
    ![unitsPerAgent, minAgents, maxAgents].every((n) => Number.isInteger(n) && n >= 1) ||
    minAgents > maxAgents
  ) {
    problems.push('teamSize');
  }
  const items = new Set<string>();
  rule.checklist.forEach((item, index) => {
    if (!isCode(item.code) || items.has(item.code) || !item.label.trim())
      problems.push(`checklist[${index}]`);
    items.add(item.code);
  });
  return problems;
}
