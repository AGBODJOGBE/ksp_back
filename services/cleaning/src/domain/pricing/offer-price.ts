import { frequencyCoefficientFor } from './frequency';
import { BASIS_POINTS, percentOfBps, scaleByCoefficients } from './money';
import { MAX_PACK_DISCOUNT_BPS } from './tariff-validation';
import {
  type FrequencyKey,
  type ParameterValue,
  type ParameterValues,
  type Tariff,
  type TariffBracket,
  type TariffSupplement,
} from './types';

/**
 * Prix d'une offre pour une séance (partie 5, R-PX-01 à R-PX-06, reprise RV-20) :
 *
 *   prix = max(minimum, arrondi((tranche(base) + Σ suppléments) × Π coefficients de l'offre
 *              × coefficient de fréquence × coefficient de commune))
 *
 * Calcul exact, un seul arrondi au franc par sous-total. Chaque coefficient donne une ligne dont le
 * montant est la différence entre deux sous-totaux arrondis : la somme des lignes égale le prix.
 * Pack à remise (R-CA-04) : prix = somme des prix de ses types ; la remise, arrondie au franc,
 * plafonnée à 90 % et jamais sous le minimum du pack, est rendue à part (`packDiscount`).
 */
export type PricingLineKind =
  'bracket' | 'supplement' | 'coefficient' | 'frequency' | 'minimum' | 'pack_discount' | 'commune';

export interface PricingLine {
  kind: PricingLineKind;
  label: string;
  parameterCode: string | null;
  quantity: number | null;
  unitAmount: number | null;
  coefficientBps: number | null;
  amount: number;
}

export type OnQuoteReason =
  'no_published_tariff' | 'above_last_bracket' | 'below_first_bracket' | 'base_value_missing';

export interface OfferPrice {
  status: 'priced' | 'on_quote';
  /** Prix de l'offre pour une séance ; null « sur devis ». */
  price: number | null;
  minimumApplied: boolean;
  lines: PricingLine[];
  onQuoteReason: OnQuoteReason | null;
  /** Pack à remise : remise appliquée à la séance ; 0 sinon. */
  packDiscount: number;
}

/** Libellés figés du formulaire, pour le détail lisible. */
export type ParameterLabels = Readonly<
  Record<string, { label: string; unit: string | null; choices?: Readonly<Record<string, string>> }>
>;

export interface OfferPriceInput {
  /** Nom du type de nettoyage (« Sol »). */
  name: string;
  /** Version de tarif utilisée ; null : aucune n'est publiée. */
  tariff: Tariff | null;
  values: ParameterValues;
  labels: ParameterLabels;
  /** Coefficient de commune, 10 000 quand il est neutre (R-PX-05). */
  communeCoefficientBps: number;
  frequencyKey: FrequencyKey | null;
  /** Pack à remise : offres de ses types, dans le même lieu ; vide sinon. */
  packItems: readonly OfferPriceInput[];
}

/** Tarif incohérent rencontré au calcul : il aurait dû être refusé à l'enregistrement (R-CA-11). */
export class TariffInvariantError extends Error {
  constructor(reason: string) {
    super(`Tarif incohérent : ${reason}`);
    this.name = 'TariffInvariantError';
  }
}

const NBSP = ' ';
const formatInteger = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

const onQuote = (reason: OnQuoteReason): OfferPrice => ({
  status: 'on_quote',
  price: null,
  minimumApplied: false,
  lines: [],
  onQuoteReason: reason,
  packDiscount: 0,
});

const line = (
  kind: PricingLineKind,
  label: string,
  patch: Partial<PricingLine> & { amount: number },
): PricingLine => ({
  kind,
  label,
  parameterCode: null,
  quantity: null,
  unitAmount: null,
  coefficientBps: null,
  ...patch,
});

export function priceOffer(input: OfferPriceInput): OfferPrice {
  const { tariff } = input;
  if (tariff === null) return onQuote('no_published_tariff');
  if (tariff.packDiscountBps !== null) return pricePack(input, tariff, tariff.packDiscountBps);
  return priceBrackets(input, tariff);
}

function priceBrackets(input: OfferPriceInput, tariff: Tariff): OfferPrice {
  const base = tariff.baseParameterCode === null ? undefined : input.values[tariff.baseParameterCode];
  if (typeof base !== 'number') return onQuote('base_value_missing');
  const found = bracketFor(tariff.brackets, base);
  if (typeof found === 'string') return onQuote(found);

  const baseCode = tariff.baseParameterCode as string;
  const unit = input.labels[baseCode]?.unit;
  const lines: PricingLine[] = [
    line(
      'bracket',
      `${input.name}, tranche ${formatInteger(found.from)} à ${formatInteger(found.to)}${unit ? ` ${unit}` : ''}`,
      {
        parameterCode: baseCode,
        quantity: found.mode === 'per_unit' ? base : null,
        unitAmount: found.amount,
        amount: found.mode === 'per_unit' ? found.amount * base : found.amount,
      },
    ),
  ];
  const coefficients: PricingLine[] = [];
  for (const supplement of tariff.supplements) {
    const value = input.values[supplement.parameterCode];
    const quantity = supplementQuantity(supplement, value);
    if (quantity === 0) continue;
    const label = supplementLabel(input, supplement);
    if (supplement.mode === 'coefficient') {
      coefficients.push(
        line('coefficient', label, {
          parameterCode: supplement.parameterCode,
          coefficientBps: supplement.coefficientBps,
          amount: 0,
        }),
      );
      continue;
    }
    const amount = supplement.amount as number;
    lines.push(
      line('supplement', label, {
        parameterCode: supplement.parameterCode,
        quantity: supplement.mode === 'per_unit' ? quantity : null,
        unitAmount: amount,
        amount: amount * quantity,
      }),
    );
  }
  const frequency = frequencyCoefficientFor(tariff.frequencyCoefficients, input.frequencyKey);
  if (frequency !== null) {
    coefficients.push(
      line('frequency', `${input.name}, remise récurrente`, { coefficientBps: frequency, amount: 0 }),
    );
  }
  if (communeLineShown(input.communeCoefficientBps)) {
    coefficients.push(
      line('commune', `${input.name}, coefficient de commune`, {
        coefficientBps: input.communeCoefficientBps,
        amount: 0,
      }),
    );
  }

  const subtotal = lines.reduce((total, current) => total + current.amount, 0);
  const applied: number[] = [];
  let previous = subtotal;
  for (const coefficient of coefficients) {
    applied.push(coefficient.coefficientBps as number);
    const next = scaleByCoefficients(subtotal, applied);
    lines.push({ ...coefficient, amount: next - previous });
    previous = next;
  }
  return withMinimum(input.name, tariff.minimum, previous, lines, 0);
}

/** Tranche contenant la valeur, ou la raison du « sur devis ». */
function bracketFor(brackets: readonly TariffBracket[], value: number): TariffBracket | OnQuoteReason {
  const first = brackets[0];
  const last = brackets[brackets.length - 1];
  if (!first || !last || value > last.to) return 'above_last_bracket';
  if (value < first.from) return 'below_first_bracket';
  const bracket = brackets.find((candidate) => value >= candidate.from && value <= candidate.to);
  if (!bracket) throw new TariffInvariantError('brackets_gap');
  return bracket;
}

/**
 * Nombre d'applications d'un supplément (0 : aucun effet). Par unité : unités au-delà des unités
 * incluses. Montant fixe ou coefficient : 1 pour un « oui », pour la valeur de choix visée, et,
 * interprétation prudente, pour un nombre strictement positif (0 n'ajoute aucune ligne).
 */
function supplementQuantity(supplement: TariffSupplement, value: ParameterValue | undefined): number {
  if (supplement.mode === 'per_unit') {
    return typeof value === 'number' ? Math.max(0, value - supplement.includedUnits) : 0;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value === supplement.choiceCode ? 1 : 0;
  return typeof value === 'number' && value > 0 ? 1 : 0;
}

function supplementLabel(input: OfferPriceInput, supplement: TariffSupplement): string {
  const parameter = input.labels[supplement.parameterCode];
  const name = parameter?.label ?? supplement.parameterCode;
  const choice =
    supplement.choiceCode === null
      ? ''
      : ` : ${parameter?.choices?.[supplement.choiceCode] ?? supplement.choiceCode}`;
  if (supplement.mode === 'coefficient') return `${input.name}, ${name}${choice}`;
  if (supplement.mode === 'fixed') return `${input.name}, supplément ${name}${choice}`;
  return supplement.includedUnits > 0
    ? `${input.name}, ${name} au-delà de ${formatInteger(supplement.includedUnits)}`
    : `${input.name}, ${name}`;
}

/**
 * Ligne de commune seulement si le coefficient n'est pas neutre : un coefficient de 1 n'a pas
 * d'effet à montrer (interprétation, comme la remise de fréquence sans entrée, R-PX-06).
 */
function communeLineShown(coefficientBps: number): boolean {
  return coefficientBps !== BASIS_POINTS;
}

/** Prix final = max(minimum, sous-total) ; l'écart forme une ligne « minimum ». */
function withMinimum(
  name: string,
  minimum: number,
  subtotal: number,
  lines: PricingLine[],
  packDiscount: number,
): OfferPrice {
  const minimumApplied = minimum > subtotal;
  if (minimumApplied)
    lines.push(line('minimum', `${name}, minimum de l’offre`, { amount: minimum - subtotal }));
  return {
    status: 'priced',
    price: Math.max(minimum, subtotal),
    minimumApplied,
    lines,
    onQuoteReason: null,
    packDiscount,
  };
}

/**
 * Pack à remise : prix_pack = max(minimum_pack, Σ prix des types − remise). Le prix de l'offre
 * reste la somme des types (relevée au minimum si elle est en dessous) et la remise est rendue à
 * part, pour la ligne « Remise pack » du devis (R-DV-07). La remise est arrondie au franc,
 * plafonnée à 90 % et réduite pour ne pas passer sous le minimum.
 */
function pricePack(input: OfferPriceInput, tariff: Tariff, discountBps: number): OfferPrice {
  const items = input.packItems.map(priceOffer);
  const blocked = items.find((item) => item.status === 'on_quote');
  if (blocked) return onQuote(blocked.onQuoteReason as OnQuoteReason);
  const total = items.reduce((sum, item) => sum + (item.price as number), 0);
  const wanted = percentOfBps(total, Math.min(discountBps, MAX_PACK_DISCOUNT_BPS));
  const discount = Math.min(wanted, Math.max(0, total - tariff.minimum));
  const result = withMinimum(
    input.name,
    tariff.minimum,
    total,
    items.flatMap((item) => item.lines),
    discount,
  );
  return { ...result, minimumApplied: result.minimumApplied || discount < wanted };
}
