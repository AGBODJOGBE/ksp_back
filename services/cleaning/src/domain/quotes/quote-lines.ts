import { type SessionPricing } from '../pricing/session-price';
import { type ParameterValue, type ParameterValues } from '../pricing/types';
import { DomainRuleError } from '../requests/errors';
import { type PricedLine } from './quote';

/** Libellé de la ligne négative d'un pack à remise (R-DV-07). */
export const PACK_DISCOUNT_LABEL = 'Remise pack';

/**
 * R-DV-07, RV-22 : lignes du devis préremplies depuis le calcul retenu du domaine du prix. Une ligne
 * par offre, à son prix pour une séance (minimum, fréquence et commune compris), puis une ligne
 * « Remise pack » négative pour chaque pack à remise : leur somme égale le prix d'une séance. Une
 * offre « sur devis » n'a pas de prix : CLEANING_PRICE_NOT_SET (details.offerIds).
 */
export function quoteLinesFrom(pricing: SessionPricing): PricedLine[] {
  const missing = pricing.offers.filter((offer) => offer.price === null).map((offer) => offer.offerId);
  if (missing.length > 0) throw new DomainRuleError('CLEANING_PRICE_NOT_SET', { offerIds: missing });
  const lines: PricedLine[] = [];
  for (const offer of pricing.offers) {
    const amount = offer.price as number;
    lines.push({
      offerId: offer.offerId,
      cleaningTypeId: offer.cleaningTypeId,
      name: offer.name,
      quantity: 1,
      unit: null,
      unitPrice: amount,
      amount,
      kind: 'offer',
    });
    if (offer.packDiscount > 0) {
      lines.push({
        offerId: offer.offerId,
        cleaningTypeId: offer.cleaningTypeId,
        name: PACK_DISCOUNT_LABEL,
        quantity: 1,
        unit: null,
        unitPrice: -offer.packDiscount,
        amount: -offer.packDiscount,
        kind: 'pack_discount',
      });
    }
  }
  return lines;
}

/**
 * R-CS-02 : effet de chaque paramètre changé sur le prix d'une séance. Interprétation : l'écart est
 * mesuré seul, en partant du déclaré et en ne changeant que ce paramètre (« Superficie : + 5 400 FCFA
 * par séance ») ; les effets ne s'additionnent donc pas forcément au prix retenu (minimum, paliers).
 * `priceOf` rend le prix d'une séance pour des valeurs, ou null s'il n'est pas calculable : aucun
 * effet n'est alors affiché pour ce paramètre.
 */
export function parameterPriceEffects(
  declared: ParameterValues,
  retained: ParameterValues,
  priceOf: (values: Record<string, ParameterValue>) => number | null,
): Record<string, number> {
  const base = priceOf({ ...declared });
  if (base === null) return {};
  const effects: Record<string, number> = {};
  for (const code of Object.keys(retained)) {
    if (declared[code] === retained[code]) continue;
    const changed = priceOf({ ...declared, [code]: retained[code] as ParameterValue });
    if (changed !== null) effects[code] = changed - base;
  }
  return effects;
}
