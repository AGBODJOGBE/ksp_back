/**
 * Types du catalogue utiles au calcul du prix (partie 4, 15.1). Montants en francs CFA entiers,
 * coefficients en points de base (10 000 = × 1). Les identifiants restent des chaînes opaques.
 */

export type ParameterKind = 'number' | 'choice' | 'boolean';

export interface ParameterChoice {
  code: string;
  active: boolean;
}

/** Paramètre demandé par un lieu (R-CA-01) ou par une offre (R-CA-02). */
export interface ParameterDefinition {
  code: string;
  kind: ParameterKind;
  /** Bornes entières incluses (nombre seulement) ; null : 0 et 1 000 000. */
  min: number | null;
  max: number | null;
  /** Valeurs possibles (choix seulement). */
  choices: ParameterChoice[];
  required: boolean;
  active: boolean;
}

/** Valeur déclarée, constatée ou retenue : entier, code de choix ou oui/non. */
export type ParameterValue = number | string | boolean;
export type ParameterValues = Readonly<Record<string, ParameterValue>>;

export type BracketMode = 'flat' | 'per_unit';

/** Tranche du paramètre de base, bornes entières incluses. */
export interface TariffBracket {
  from: number;
  to: number;
  mode: BracketMode;
  /** Forfait ou prix par unité. */
  amount: number;
}

export type SupplementMode = 'fixed' | 'per_unit' | 'coefficient';

export interface TariffSupplement {
  parameterCode: string;
  /** Paramètre « choix » : valeur concernée ; null sinon. */
  choiceCode: string | null;
  mode: SupplementMode;
  /** Montant fixe ou par unité ; null pour un coefficient. */
  amount: number | null;
  /** Coefficient ; null pour un montant. */
  coefficientBps: number | null;
  /** Par unité : unités incluses avant le supplément (« chaque chambre au-delà de 3 » : 3). */
  includedUnits: number;
}

/** Clé de fréquence (R-PX-06) : weekly, every_N_weeks (N de 2 à 12) ou monthly. */
export type FrequencyKey = string;

export interface FrequencyCoefficient {
  key: FrequencyKey;
  coefficientBps: number;
}

export type TariffStatus = 'draft' | 'published' | 'archived';

/**
 * Version de tarif d'une offre (R-CA-07). Soit des tranches sur un paramètre de base, soit, pour
 * un pack, une remise sur la somme de ses types (R-CA-04).
 */
export interface Tariff {
  version: number;
  status: TariffStatus;
  baseParameterCode: string | null;
  brackets: TariffBracket[];
  supplements: TariffSupplement[];
  minimum: number;
  frequencyCoefficients: FrequencyCoefficient[];
  /** Pack à remise : points de base (1000 = 10 %), plafond 9000 ; null : prix par tranches. */
  packDiscountBps: number | null;
}

/** Tranche de la règle d'équipe (R-CA-13) ; `toArea` null : sans limite. */
export interface TeamRuleBracket {
  fromArea: number;
  toArea: number | null;
  agents: number;
  durationMinutes: number;
}
