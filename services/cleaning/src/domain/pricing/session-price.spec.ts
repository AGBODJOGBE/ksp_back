import { type SessionOffer, type SessionPricingInput, priceSession } from './session-price';
import { labels, solTariff, villa, vitresTariff } from './testing';

const solOffer: SessionOffer = {
  offerId: 'offre-sol',
  cleaningTypeId: 'sol',
  name: 'Sol',
  tariff: solTariff(),
  tariffStatus: 'published',
  teamRule: [
    { fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 },
    { fromArea: 101, toArea: null, agents: 3, durationMinutes: 240 },
  ],
  referenceDurationMinutes: 120,
  packItems: [],
};
const vitresOffer: SessionOffer = {
  offerId: 'offre-vitres',
  cleaningTypeId: 'vitres',
  name: 'Vitres',
  tariff: vitresTariff(),
  tariffStatus: 'published',
  teamRule: [],
  referenceDurationMinutes: 60,
  packItems: [],
};
const cotonou = { key: 'cotonou', coefficientBps: 10_000, served: true };

const session = (patch: Partial<SessionPricingInput> = {}) =>
  priceSession({
    offers: [solOffer, vitresOffer],
    values: villa,
    labels,
    areaParameterCode: 'superficie',
    commune: cotonou,
    frequencyKey: 'weekly',
    sessionsCount: 12,
    ...patch,
  });

describe('exemple de la partie 5, au franc près', () => {
  it('villa de 120 m² à Cotonou, sol et vitres, chaque semaine pendant 12 séances : 384 480 FCFA', () => {
    const result = session();
    expect(result.offers.map((offer) => [offer.cleaningTypeId, offer.price])).toEqual([
      ['sol', 26_640],
      ['vitres', 5400],
    ]);
    expect(result).toMatchObject({
      status: 'priced',
      complete: true,
      sessionPrice: 32_040,
      frequencyDiscount: 3560,
      sessionsCount: 12,
      programTotal: 384_480,
      range: { low: 28_500, high: 37_000 },
      programRange: { low: 342_000, high: 444_000 },
      pricedSubtotal: 32_040,
      packDiscount: 0,
      discountLines: [],
      communeKey: 'cotonou',
      communeCoefficientBps: 10_000,
      covered: true,
      communeApplied: true,
      notices: [],
      usesDrafts: false,
    });
  });

  it('sous-total d’une séance avant la remise de fréquence : 35 600', () => {
    const result = session();
    const beforeFrequency = result.offers
      .flatMap((offer) => offer.lines)
      .filter((line) => line.kind !== 'frequency')
      .reduce((total, line) => total + line.amount, 0);
    expect(beforeFrequency).toBe(35_600);
  });

  it('propose l’équipe et la durée : maximum des agents, somme des durées (R-CA-13)', () => {
    expect(session()).toMatchObject({ teamSize: 3, durationMinutes: 240 + 60 });
    expect(session({ values: { ...villa, superficie: 100 } })).toMatchObject({
      teamSize: 2,
      durationMinutes: 180 + 60,
    });
  });
});

describe('commune (R-PX-05)', () => {
  it('applique le coefficient d’une commune desservie à chaque offre, avant son minimum', () => {
    const result = session({
      commune: { key: 'porto-novo', coefficientBps: 11_000, served: true },
      frequencyKey: null,
    });
    expect(result.offers.map((offer) => offer.price)).toEqual([32_560, 6600]);
    expect(result).toMatchObject({ covered: true, communeApplied: true, communeCoefficientBps: 11_000 });
  });

  it('commune inconnue : coefficient neutre, sans erreur, signalée', () => {
    const result = session({ commune: null, frequencyKey: null });
    expect(result).toMatchObject({
      sessionPrice: 35_600,
      communeKey: null,
      communeCoefficientBps: 10_000,
      covered: false,
      communeApplied: false,
      notices: ['no_commune'],
    });
  });

  it('commune hors zone ou zone désactivée : coefficient neutre, signalée', () => {
    const result = session({
      commune: { key: 'parakou', coefficientBps: 15_000, served: false },
      frequencyKey: null,
    });
    expect(result).toMatchObject({
      sessionPrice: 35_600,
      communeKey: 'parakou',
      communeCoefficientBps: 10_000,
      covered: false,
      communeApplied: false,
      notices: ['commune_not_covered'],
    });
  });
});

describe('prix partiel et « sur devis » (R-PX-08)', () => {
  it('une offre sur devis : ni prix de séance, ni total, ni remise, ni fourchette ; « à partir de »', () => {
    const result = session({ values: { ...villa, fenetres: 25 } });
    expect(result).toMatchObject({
      status: 'partially_priced',
      complete: false,
      sessionPrice: null,
      programTotal: null,
      frequencyDiscount: null,
      range: null,
      programRange: null,
      pricedSubtotal: 26_640,
      notices: ['partially_priced'],
    });
    expect(result.offers[1]).toMatchObject({
      status: 'on_quote',
      onQuoteReason: 'above_last_bracket',
      price: null,
    });
  });

  it('rien de chiffré : on_quote, sans somme', () => {
    const result = session({ offers: [{ ...solOffer, tariff: null, tariffStatus: null }] });
    expect(result).toMatchObject({
      status: 'on_quote',
      pricedSubtotal: null,
      sessionPrice: null,
      notices: ['on_quote'],
    });
    expect(result.offers[0]).toMatchObject({
      tariffVersion: null,
      tariffStatus: null,
      onQuoteReason: 'no_published_tariff',
    });
  });

  it('aucune offre : on_quote', () => {
    expect(session({ offers: [] })).toMatchObject({
      status: 'on_quote',
      teamSize: null,
      durationMinutes: null,
    });
  });

  it('les mentions se cumulent', () => {
    expect(session({ commune: null, values: { ...villa, fenetres: 25 } }).notices).toEqual([
      'no_commune',
      'partially_priced',
    ]);
  });
});

describe('programme (partie 5)', () => {
  it('programme ponctuel sans nombre de séances : pas de total', () => {
    const result = session({ frequencyKey: null, sessionsCount: null });
    expect(result).toMatchObject({
      sessionPrice: 35_600,
      programTotal: null,
      programRange: null,
      frequencyDiscount: 0,
    });
  });

  it('une seule séance : total = prix d’une séance', () => {
    expect(session({ sessionsCount: 1 })).toMatchObject({ programTotal: 32_040 });
  });
});

describe('pack à remise dans une séance (R-CA-04, R-DV-07)', () => {
  const pack: SessionOffer = {
    offerId: 'offre-complet',
    cleaningTypeId: 'complet',
    name: 'Nettoyage complet',
    tariff: solTariff({
      version: 4,
      baseParameterCode: null,
      brackets: [],
      supplements: [],
      frequencyCoefficients: [],
      packDiscountBps: 1000,
      minimum: 0,
    }),
    tariffStatus: 'draft',
    teamRule: [{ fromArea: 0, toArea: null, agents: 4, durationMinutes: 360 }],
    referenceDurationMinutes: 300,
    packItems: [
      { name: 'Sol', tariff: solTariff() },
      { name: 'Vitres', tariff: vitresTariff() },
    ],
  };

  it('prix d’une séance = Σ prix des offres − remise pack, avec une ligne « Remise pack » négative', () => {
    const result = session({ offers: [pack] });
    expect(result).toMatchObject({
      sessionPrice: 28_836,
      packDiscount: 3204,
      pricedSubtotal: 28_836,
      programTotal: 28_836 * 12,
      frequencyDiscount: 3560,
      usesDrafts: true,
      teamSize: 4,
      durationMinutes: 360,
    });
    expect(result.offers[0]).toMatchObject({
      price: 32_040,
      packDiscount: 3204,
      tariffVersion: 4,
      tariffStatus: 'draft',
    });
    expect(result.discountLines).toEqual([
      {
        kind: 'pack_discount',
        label: 'Nettoyage complet, remise pack',
        parameterCode: null,
        quantity: null,
        unitAmount: null,
        coefficientBps: 1000,
        amount: -3204,
      },
    ]);
    const lines =
      result.offers[0]!.price! + result.discountLines.reduce((total, line) => total + line.amount, 0);
    expect(lines).toBe(result.sessionPrice);
  });

  it('pack chiffré à côté d’une offre sur devis : « à partir de » remise déduite', () => {
    const autre = {
      ...vitresOffer,
      offerId: 'offre-jardin',
      cleaningTypeId: 'jardin',
      tariff: null,
      tariffStatus: null,
    };
    expect(session({ offers: [pack, autre] })).toMatchObject({
      status: 'partially_priced',
      pricedSubtotal: 28_836,
    });
  });
});
