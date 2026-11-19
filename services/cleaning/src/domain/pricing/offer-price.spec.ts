import { type OfferPriceInput, priceOffer } from './offer-price';
import { labels, solTariff, villa, vitresTariff } from './testing';
import { type ParameterValues, type Tariff } from './types';

const sol = (values: ParameterValues, patch: Partial<OfferPriceInput> = {}) =>
  priceOffer({
    name: 'Sol',
    tariff: solTariff(),
    values,
    labels,
    communeCoefficientBps: 10_000,
    frequencyKey: null,
    packItems: [],
    ...patch,
  });
const sumOf = (lines: { amount: number }[]) => lines.reduce((total, line) => total + line.amount, 0);

describe('prix d’une offre : exemple de la partie 5', () => {
  it('Sol, villa de 120 m², chaque semaine : 29 600 × 0,9 = 26 640, détail ligne par ligne', () => {
    const result = sol(villa, { frequencyKey: 'weekly' });
    expect(result).toMatchObject({
      status: 'priced',
      price: 26_640,
      minimumApplied: false,
      onQuoteReason: null,
    });
    expect(result.lines).toEqual([
      {
        kind: 'bracket',
        label: 'Sol, tranche 51 à 150 m²',
        parameterCode: 'superficie',
        quantity: 120,
        unitAmount: 180,
        coefficientBps: null,
        amount: 21_600,
      },
      {
        kind: 'supplement',
        label: 'Sol, supplément cour',
        parameterCode: 'cour',
        quantity: null,
        unitAmount: 5000,
        coefficientBps: null,
        amount: 5000,
      },
      {
        kind: 'supplement',
        label: 'Sol, chambres au-delà de 3',
        parameterCode: 'chambres',
        quantity: 2,
        unitAmount: 1500,
        coefficientBps: null,
        amount: 3000,
      },
      {
        kind: 'frequency',
        label: 'Sol, remise récurrente',
        parameterCode: null,
        quantity: null,
        unitAmount: null,
        coefficientBps: 9000,
        amount: -2960,
      },
    ]);
  });

  it('Vitres, 12 fenêtres, chaque semaine : 6 000 × 0,9 = 5 400', () => {
    const result = priceOffer({
      name: 'Vitres',
      tariff: vitresTariff(),
      values: villa,
      labels,
      communeCoefficientBps: 10_000,
      frequencyKey: 'weekly',
      packItems: [],
    });
    expect(result.price).toBe(5400);
    expect(result.lines.map((line) => [line.label, line.amount])).toEqual([
      ['Vitres, tranche 1 à 20 fenêtres', 6000],
      ['Vitres, remise récurrente', -600],
    ]);
  });
});

describe('tarif de la tranche (R-PX-01)', () => {
  it('forfait de la tranche, sans quantité', () => {
    const result = sol({ superficie: 30 });
    expect(result.price).toBe(10_000);
    expect(result.lines[0]).toMatchObject({
      kind: 'bracket',
      quantity: null,
      unitAmount: 10_000,
      amount: 10_000,
    });
    expect(result.lines[0]!.label).toBe('Sol, tranche 0 à 50 m²');
  });

  it('bornes incluses : 50 au forfait, 51 au prix par unité', () => {
    expect(sol({ superficie: 50 }).lines[0]!.amount).toBe(10_000);
    expect(sol({ superficie: 51 }).lines[0]!.amount).toBe(9180);
    expect(sol({ superficie: 400 }).lines[0]!.amount).toBe(60_000);
  });

  it('valeur 0 dans la première tranche', () => {
    expect(sol({ superficie: 0 }).price).toBe(10_000);
  });

  it('groupe les milliers du libellé', () => {
    const tariff = solTariff({ brackets: [{ from: 0, to: 12_000, mode: 'per_unit', amount: 1 }] });
    expect(sol({ superficie: 1500 }, { tariff }).lines[0]!.label).toBe('Sol, tranche 0 à 12 000 m²');
  });
});

describe('« sur devis » (R-PX-03, R-PX-08)', () => {
  it('offre sans tarif publié', () => {
    expect(sol(villa, { tariff: null })).toEqual({
      status: 'on_quote',
      price: null,
      minimumApplied: false,
      lines: [],
      onQuoteReason: 'no_published_tariff',
      packDiscount: 0,
    });
  });

  it('au-delà de la dernière tranche, dès la première unité', () => {
    expect(sol({ superficie: 401 })).toMatchObject({
      status: 'on_quote',
      onQuoteReason: 'above_last_bracket',
    });
  });

  it('sous la première tranche', () => {
    const result = priceOffer({
      name: 'Vitres',
      tariff: vitresTariff(),
      values: { fenetres: 0 },
      labels,
      communeCoefficientBps: 10_000,
      frequencyKey: null,
      packItems: [],
    });
    expect(result).toMatchObject({ status: 'on_quote', onQuoteReason: 'below_first_bracket' });
  });

  it('valeur de base manquante ou d’une autre nature', () => {
    expect(sol({ chambres: 5 })).toMatchObject({ status: 'on_quote', onQuoteReason: 'base_value_missing' });
    expect(sol({ superficie: 'grand' })).toMatchObject({ onQuoteReason: 'base_value_missing' });
  });

  it('refuse de chiffrer un tarif dont les tranches laissent un trou', () => {
    const tariff = solTariff({
      brackets: [
        { from: 0, to: 50, mode: 'flat', amount: 1 },
        { from: 60, to: 80, mode: 'flat', amount: 1 },
      ],
    });
    expect(() => sol({ superficie: 55 }, { tariff })).toThrow('brackets_gap');
  });
});

describe('suppléments (partie 4)', () => {
  it('chaque chambre au-delà de 3 : 3 n’ajoute rien, 4 en ajoute une', () => {
    expect(sol({ superficie: 30, chambres: 3 }).lines).toHaveLength(1);
    expect(sol({ superficie: 30, chambres: 4 }).lines[1]).toMatchObject({ quantity: 1, amount: 1500 });
  });

  it('par unité sans unités incluses : toutes comptent, et 0 n’ajoute aucune ligne', () => {
    const tariff = solTariff({
      supplements: [
        {
          parameterCode: 'chambres',
          choiceCode: null,
          mode: 'per_unit',
          amount: 1000,
          coefficientBps: null,
          includedUnits: 0,
        },
      ],
    });
    expect(sol({ superficie: 30, chambres: 2 }, { tariff }).lines[1]).toMatchObject({
      label: 'Sol, chambres',
      quantity: 2,
      amount: 2000,
    });
    expect(sol({ superficie: 30, chambres: 0 }, { tariff }).lines).toHaveLength(1);
  });

  it('un « non » ou un oui/non absent n’a jamais d’effet', () => {
    expect(sol({ superficie: 30, cour: false, arriere_cour: false }).lines).toHaveLength(1);
    expect(sol({ superficie: 30 }).lines).toHaveLength(1);
  });

  it('montant fixe d’un nombre : seulement pour une valeur strictement positive', () => {
    const tariff = solTariff({
      supplements: [
        {
          parameterCode: 'chambres',
          choiceCode: null,
          mode: 'fixed',
          amount: 2500,
          coefficientBps: null,
          includedUnits: 0,
        },
      ],
    });
    expect(sol({ superficie: 30, chambres: 0 }, { tariff }).lines).toHaveLength(1);
    expect(sol({ superficie: 30, chambres: 1 }, { tariff }).price).toBe(12_500);
  });

  it('montant fixe d’une valeur de choix : seulement pour cette valeur', () => {
    const tariff = solTariff({
      supplements: [
        {
          parameterCode: 'salete',
          choiceCode: 'apres_travaux',
          mode: 'fixed',
          amount: 4000,
          coefficientBps: null,
          includedUnits: 0,
        },
      ],
    });
    expect(sol({ superficie: 30, salete: 'normal' }, { tariff }).price).toBe(10_000);
    const result = sol({ superficie: 30, salete: 'apres_travaux' }, { tariff });
    expect(result.price).toBe(14_000);
    expect(result.lines[1]!.label).toBe('Sol, supplément niveau de saleté : après travaux');
  });

  it('coefficient d’un oui', () => {
    const tariff = solTariff({
      supplements: [
        {
          parameterCode: 'cour',
          choiceCode: null,
          mode: 'coefficient',
          amount: null,
          coefficientBps: 11_000,
          includedUnits: 0,
        },
      ],
    });
    const result = sol({ superficie: 100, cour: true }, { tariff });
    expect(result.price).toBe(19_800);
    expect(result.lines[1]).toMatchObject({
      kind: 'coefficient',
      label: 'Sol, cour',
      coefficientBps: 11_000,
      amount: 1800,
    });
  });

  it('libellés de repli : code du paramètre et de la valeur sans libellé connu', () => {
    const result = sol({ superficie: 30, salete: 'apres_travaux' }, { labels: {} });
    expect(result.lines.map((line) => line.label)).toEqual([
      'Sol, tranche 0 à 50',
      'Sol, salete : apres_travaux',
    ]);
  });
});

describe('coefficients et arrondi (R-PX-02, R-PX-05, R-PX-06)', () => {
  it('une ligne par coefficient, différence de deux sous-totaux arrondis, somme des lignes = prix', () => {
    const result = sol(
      { superficie: 77, cour: true, salete: 'apres_travaux' },
      { frequencyKey: 'weekly', communeCoefficientBps: 10_500 },
    );
    expect(result.lines.map((line) => [line.kind, line.amount])).toEqual([
      ['bracket', 13_860],
      ['supplement', 5000],
      ['coefficient', 5658],
      ['frequency', -2452],
      ['commune', 1104],
    ]);
    expect(result.price).toBe(23_170);
    expect(sumOf(result.lines)).toBe(result.price);
    expect(result.lines[4]).toMatchObject({ label: 'Sol, coefficient de commune', coefficientBps: 10_500 });
  });

  it('arrondit au franc le plus proche, moitié vers le haut, une seule fois par offre', () => {
    const tariff = solTariff({ brackets: [{ from: 0, to: 400, mode: 'flat', amount: 5 }], minimum: 0 });
    expect(sol({ superficie: 10 }, { tariff, communeCoefficientBps: 15_000 }).price).toBe(8);
    const twice = solTariff({
      brackets: [{ from: 0, to: 400, mode: 'flat', amount: 5 }],
      minimum: 0,
      frequencyCoefficients: [{ key: 'weekly', coefficientBps: 11_000 }],
    });
    const result = sol(
      { superficie: 10 },
      { tariff: twice, frequencyKey: 'weekly', communeCoefficientBps: 11_000 },
    );
    // 5 × 1,1 × 1,1 = 6,05 → 6 ; deux arrondis successifs donneraient 5,5 → 6 puis 6,6 → 7.
    expect(result.price).toBe(6);
    expect(result.lines.map((line) => line.amount)).toEqual([5, 1, 0]);
  });

  it('commune neutre : aucune ligne de commune', () => {
    expect(sol(villa).lines.some((line) => line.kind === 'commune')).toBe(false);
  });

  it('fréquence sans entrée correspondante ou programme ponctuel : aucune ligne de remise', () => {
    expect(sol(villa, { frequencyKey: 'every_2_weeks' }).price).toBe(29_600);
    expect(sol(villa).lines.some((line) => line.kind === 'frequency')).toBe(false);
  });
});

describe('minimum de l’offre, après tous les coefficients (R-PX-02, reprise RV-20)', () => {
  it('relève le prix au minimum avec une ligne « minimum »', () => {
    const result = sol({ superficie: 51 });
    expect(result).toMatchObject({ price: 10_000, minimumApplied: true });
    expect(result.lines.at(-1)).toEqual({
      kind: 'minimum',
      label: 'Sol, minimum de l’offre',
      parameterCode: null,
      quantity: null,
      unitAmount: null,
      coefficientBps: null,
      amount: 820,
    });
    expect(sumOf(result.lines)).toBe(10_000);
  });

  it('compare au minimum après la remise de fréquence', () => {
    // 60 × 180 = 10 800, au-dessus du minimum, puis × 0,9 = 9 720 : le minimum s’applique.
    const result = sol({ superficie: 60 }, { frequencyKey: 'weekly' });
    expect(result).toMatchObject({ price: 10_000, minimumApplied: true });
    expect(result.lines.map((line) => line.amount)).toEqual([10_800, -1080, 280]);
  });

  it('compare au minimum après le coefficient de commune', () => {
    // 51 × 180 = 9 180, sous le minimum, puis × 1,2 = 11 016 : le minimum ne s’applique pas.
    expect(sol({ superficie: 51 }, { communeCoefficientBps: 12_000 })).toMatchObject({
      price: 11_016,
      minimumApplied: false,
    });
  });

  it('prix égal au minimum : minimum non appliqué', () => {
    expect(sol({ superficie: 30 })).toMatchObject({ price: 10_000, minimumApplied: false });
  });
});

describe('pack à remise (R-CA-04, reprise RV-21)', () => {
  const pack = (packDiscountBps: number, minimum: number, items: Tariff[] = [solTariff(), vitresTariff()]) =>
    priceOffer({
      name: 'Nettoyage complet',
      tariff: solTariff({
        baseParameterCode: null,
        brackets: [],
        supplements: [],
        frequencyCoefficients: [],
        packDiscountBps,
        minimum,
      }),
      values: villa,
      labels,
      communeCoefficientBps: 10_000,
      frequencyKey: 'weekly',
      packItems: items.map((tariff, index) => ({
        name: index === 0 ? 'Sol' : 'Vitres',
        tariff,
        values: villa,
        labels,
        communeCoefficientBps: 10_000,
        frequencyKey: 'weekly',
        packItems: [],
      })),
    });

  it('prix des types (fréquence comprise), remise arrondie au franc, à part', () => {
    // 26 640 + 5 400 = 32 040 ; 10 % = 3 204.
    const result = pack(1000, 0);
    expect(result).toMatchObject({
      status: 'priced',
      price: 32_040,
      packDiscount: 3204,
      minimumApplied: false,
    });
    expect(result.lines.map((line) => line.label)).toEqual([
      'Sol, tranche 51 à 150 m²',
      'Sol, supplément cour',
      'Sol, chambres au-delà de 3',
      'Sol, remise récurrente',
      'Vitres, tranche 1 à 20 fenêtres',
      'Vitres, remise récurrente',
    ]);
  });

  it('arrondit la remise moitié vers le haut', () => {
    // 32 040 × 12,5 % = 4 005 ; 32 040 × 0,05 % = 16,02 → 16.
    expect(pack(1250, 0).packDiscount).toBe(4005);
    expect(pack(5, 0).packDiscount).toBe(16);
  });

  it('ne descend jamais sous le minimum du pack : remise réduite', () => {
    const result = pack(9000, 30_000);
    expect(result).toMatchObject({ price: 32_040, packDiscount: 2040, minimumApplied: true });
  });

  it('relève au minimum du pack quand la somme des types est en dessous, sans remise', () => {
    const result = pack(1000, 40_000);
    expect(result).toMatchObject({ price: 40_000, packDiscount: 0, minimumApplied: true });
    expect(result.lines.at(-1)).toMatchObject({
      kind: 'minimum',
      label: 'Nettoyage complet, minimum de l’offre',
      amount: 7960,
    });
  });

  it('plafonne la remise à 90 %', () => {
    expect(pack(9500, 0).packDiscount).toBe(28_836);
    expect(pack(9000, 0).packDiscount).toBe(28_836);
  });

  it('remise nulle', () => {
    expect(pack(0, 0)).toMatchObject({ price: 32_040, packDiscount: 0, minimumApplied: false });
  });

  it('« sur devis » si l’un de ses types l’est, avec sa raison', () => {
    expect(
      pack(1000, 0, [
        solTariff(),
        vitresTariff({ brackets: [{ from: 1, to: 10, mode: 'flat', amount: 1 }] }),
      ]),
    ).toMatchObject({
      status: 'on_quote',
      price: null,
      packDiscount: 0,
      onQuoteReason: 'above_last_bracket',
    });
  });
});
