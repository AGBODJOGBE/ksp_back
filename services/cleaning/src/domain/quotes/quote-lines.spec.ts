/**
 * Lignes du devis tirées du calcul du prix (R-DV-07, RV-22) et effet de chaque écart sur le prix
 * (R-CS-02).
 *
 * Matrice règle → test :
 * - R-DV-07 une ligne par offre au prix calculé, somme = prix d'une séance → « lignes préremplies »
 * - R-DV-07 ligne « Remise pack » négative                                  → « lignes préremplies »
 * - CLEANING_PRICE_NOT_SET offre « sur devis » sans prix fixé               → « lignes préremplies »
 * - R-CS-02 effet d'un paramètre sur le prix d'une séance                   → « effet des écarts »
 */
import { type SessionOffer, priceSession, type SessionPricing } from '../pricing/session-price';
import { labels, solTariff, villa, vitresTariff } from '../pricing/testing';
import { DomainRuleError } from '../requests/errors';
import { parameterPriceEffects, quoteLinesFrom } from './quote-lines';

const offer = (patch: Partial<SessionOffer>): SessionOffer => ({
  offerId: 'offre-sol',
  cleaningTypeId: 'sol',
  name: 'Sol',
  tariff: solTariff(),
  tariffStatus: 'published',
  teamRule: [],
  referenceDurationMinutes: 120,
  packItems: [],
  ...patch,
});

const price = (offers: SessionOffer[], values: Record<string, number | string | boolean> = villa) =>
  priceSession({
    offers,
    values,
    labels,
    areaParameterCode: 'superficie',
    commune: { key: 'cotonou', coefficientBps: 10_000, served: true },
    frequencyKey: 'weekly',
    sessionsCount: 12,
  });

describe('lignes préremplies (R-DV-07)', () => {
  it('une ligne par offre au prix calculé : la somme égale le prix d’une séance', () => {
    const pricing = price([
      offer({}),
      offer({ offerId: 'offre-vitres', cleaningTypeId: 'vitres', name: 'Vitres', tariff: vitresTariff() }),
    ]);
    const lines = quoteLinesFrom(pricing);
    expect(lines).toEqual([
      {
        offerId: 'offre-sol',
        cleaningTypeId: 'sol',
        name: 'Sol',
        quantity: 1,
        unit: null,
        unitPrice: 26_640,
        amount: 26_640,
        kind: 'offer',
      },
      {
        offerId: 'offre-vitres',
        cleaningTypeId: 'vitres',
        name: 'Vitres',
        quantity: 1,
        unit: null,
        unitPrice: 5_400,
        amount: 5_400,
        kind: 'offer',
      },
    ]);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(pricing.sessionPrice);
  });

  it('pack à remise : ligne « Remise pack » négative après l’offre', () => {
    const pricing: SessionPricing = {
      ...price([offer({})]),
      packDiscount: 2_000,
      sessionPrice: 24_640,
    };
    pricing.offers = pricing.offers.map((item) => ({ ...item, packDiscount: 2_000 }));
    const lines = quoteLinesFrom(pricing);
    expect(lines.map((line) => [line.kind, line.name, line.amount])).toEqual([
      ['offer', 'Sol', 26_640],
      ['pack_discount', 'Remise pack', -2_000],
    ]);
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(24_640);
  });

  it('offre « sur devis » : CLEANING_PRICE_NOT_SET avec les offres concernées', () => {
    const pricing = price([offer({ tariff: null, tariffStatus: null })]);
    let error: unknown;
    try {
      quoteLinesFrom(pricing);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(DomainRuleError);
    expect(error).toMatchObject({ code: 'CLEANING_PRICE_NOT_SET', details: { offerIds: ['offre-sol'] } });
  });
});

describe('effet des écarts sur le prix (R-CS-02)', () => {
  it('chaque paramètre changé, seul, sur la base du déclaré', () => {
    const priceOf = (values: Record<string, number | string | boolean>) =>
      Number(values.superficie) * 100 + (values.cour === true ? 1_000 : 0);
    const effects = parameterPriceEffects(
      { superficie: 120, cour: false, chambres: 5 },
      { superficie: 150, cour: true, chambres: 5 },
      priceOf,
    );
    expect(effects).toEqual({ superficie: 3_000, cour: 1_000 });
  });

  it('un prix non calculable ne donne aucun effet', () => {
    const effects = parameterPriceEffects({ superficie: 120 }, { superficie: 150 }, (values) =>
      values.superficie === 150 ? null : 12_000,
    );
    expect(effects).toEqual({});
  });
});
