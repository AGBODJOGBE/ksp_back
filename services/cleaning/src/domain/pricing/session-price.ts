import { BASIS_POINTS, type PriceRange, priceRange } from './money';
import { type OfferPrice, type ParameterLabels, type PricingLine, priceOffer } from './offer-price';
import { proposeTeam } from './team';
import { type FrequencyKey, type ParameterValues, type Tariff, type TeamRuleBracket } from './types';

/**
 * Prix d'une séance et d'un programme (partie 5, R-PX-05, R-PX-07, R-PX-08, R-CA-13) :
 *
 *   prix_séance = Σ prix_offre − remise pack
 *   prix_programme = prix_séance × nombre de séances
 *
 * Le même calcul sert au simulateur, au constat, à la version retenue et au devis.
 */
export interface SessionOffer {
  offerId: string;
  cleaningTypeId: string;
  name: string;
  tariff: Tariff | null;
  /** Version utilisée : publiée, ou brouillon au simulateur de test (R-CA-08) ; null sans tarif. */
  tariffStatus: 'published' | 'draft' | null;
  teamRule: readonly TeamRuleBracket[];
  referenceDurationMinutes: number;
  /** Pack à remise : tarifs en vigueur des offres de ses types, dans le même lieu. */
  packItems: readonly { name: string; tariff: Tariff | null }[];
}

/** Commune du lieu ; `served` : zone active (R-ZN-01, R-PX-05). */
export interface CommuneInput {
  key: string;
  coefficientBps: number;
  served: boolean;
}

export interface SessionPricingInput {
  offers: readonly SessionOffer[];
  values: ParameterValues;
  labels: ParameterLabels;
  /** Paramètre « superficie » du lieu (R-CA-14), pour l'équipe ; null pour un lieu « Autre ». */
  areaParameterCode: string | null;
  /** Null : commune inconnue (visiteur) ou position hors contour. */
  commune: CommuneInput | null;
  frequencyKey: FrequencyKey | null;
  /** Nombre de séances du programme ; null sans programme. */
  sessionsCount: number | null;
}

export interface PricedOffer extends OfferPrice {
  offerId: string;
  cleaningTypeId: string;
  name: string;
  tariffVersion: number | null;
  tariffStatus: 'published' | 'draft' | null;
}

export type PricingStatus = 'priced' | 'partially_priced' | 'on_quote';
export type PricingNotice = 'no_commune' | 'commune_not_covered' | 'partially_priced' | 'on_quote';

export interface SessionPricing {
  communeKey: string | null;
  communeCoefficientBps: number;
  covered: boolean;
  communeApplied: boolean;
  offers: PricedOffer[];
  status: PricingStatus;
  complete: boolean;
  /** Remises des packs chiffrés. */
  packDiscount: number;
  /** Lignes « Remise pack » négatives, une par pack chiffré (R-DV-07). */
  discountLines: PricingLine[];
  /** Null dès qu'une offre est « sur devis » (R-PX-08). */
  sessionPrice: number | null;
  range: PriceRange | null;
  frequencyDiscount: number | null;
  sessionsCount: number | null;
  programTotal: number | null;
  programRange: PriceRange | null;
  /** Somme des offres chiffrées, remises des packs déduites ; null si rien n'est chiffré. */
  pricedSubtotal: number | null;
  teamSize: number | null;
  durationMinutes: number | null;
  notices: PricingNotice[];
  usesDrafts: boolean;
}

export function priceSession(input: SessionPricingInput): SessionPricing {
  const covered = input.commune !== null && input.commune.served;
  const communeCoefficientBps = covered ? (input.commune as CommuneInput).coefficientBps : BASIS_POINTS;
  const offers = input.offers.map((offer): PricedOffer => {
    const shared = {
      values: input.values,
      labels: input.labels,
      communeCoefficientBps,
      frequencyKey: input.frequencyKey,
    };
    const price = priceOffer({
      ...shared,
      name: offer.name,
      tariff: offer.tariff,
      packItems: offer.packItems.map((item) => ({ ...shared, ...item, packItems: [] })),
    });
    return {
      ...price,
      offerId: offer.offerId,
      cleaningTypeId: offer.cleaningTypeId,
      name: offer.name,
      tariffVersion: offer.tariff?.version ?? null,
      tariffStatus: offer.tariff === null ? null : offer.tariffStatus,
    };
  });

  const priced = offers.filter((offer) => offer.status === 'priced');
  const status: PricingStatus =
    priced.length === 0 ? 'on_quote' : priced.length === offers.length ? 'priced' : 'partially_priced';
  const complete = status === 'priced';
  const packDiscount = priced.reduce((total, offer) => total + offer.packDiscount, 0);
  const pricedSubtotal = priced.length
    ? priced.reduce((total, offer) => total + (offer.price as number), 0) - packDiscount
    : null;
  const sessionPrice = complete ? pricedSubtotal : null;
  const range = sessionPrice === null ? null : priceRange(sessionPrice);
  const count = input.sessionsCount;
  const area = input.areaParameterCode === null ? undefined : input.values[input.areaParameterCode];
  const team = proposeTeam(input.offers, typeof area === 'number' ? area : null);

  return {
    communeKey: input.commune?.key ?? null,
    communeCoefficientBps,
    covered,
    communeApplied: covered,
    offers,
    status,
    complete,
    packDiscount,
    discountLines: priced.filter((offer) => offer.packDiscount > 0).map(packDiscountLine(input.offers)),
    sessionPrice,
    range,
    frequencyDiscount: complete ? frequencyDiscountOf(offers) : null,
    sessionsCount: count,
    programTotal: sessionPrice === null || count === null ? null : sessionPrice * count,
    programRange:
      range === null || count === null ? null : { low: range.low * count, high: range.high * count },
    pricedSubtotal,
    teamSize: team?.teamSize ?? null,
    durationMinutes: team?.durationMinutes ?? null,
    notices: noticesOf(input.commune, status),
    usesDrafts: offers.some((offer) => offer.tariffStatus === 'draft'),
  };
}

const packDiscountLine =
  (offers: readonly SessionOffer[]) =>
  (offer: PricedOffer): PricingLine => ({
    kind: 'pack_discount',
    label: `${offer.name}, remise pack`,
    parameterCode: null,
    quantity: null,
    unitAmount: null,
    coefficientBps:
      offers.find((candidate) => candidate.offerId === offer.offerId)?.tariff?.packDiscountBps ?? null,
    amount: -offer.packDiscount,
  });

/**
 * Effet de la remise de fréquence sur une séance (information, R-PX-06) : somme, changée de signe,
 * des lignes « remise récurrente » de toutes les offres, avant leur éventuel minimum
 * (interprétation : la remise affichée ne retranche pas ce que le minimum a repris).
 */
function frequencyDiscountOf(offers: readonly PricedOffer[]): number {
  return offers
    .flatMap((offer) => offer.lines)
    .filter((line) => line.kind === 'frequency')
    .reduce((total, line) => total - line.amount, 0);
}

function noticesOf(commune: CommuneInput | null, status: PricingStatus): PricingNotice[] {
  const notices: PricingNotice[] = [];
  if (commune === null) notices.push('no_commune');
  else if (!commune.served) notices.push('commune_not_covered');
  if (status !== 'priced') notices.push(status);
  return notices;
}
