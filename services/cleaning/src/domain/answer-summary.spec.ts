import { summarizeAnswers, summarizeLegacy, UNKNOWN_DEFINITION } from './answer-summary';
import { gardenService, homeCleaningService } from './testing';

describe('réponses lisibles d’une demande (ADR-037)', () => {
  it('libellés des champs et des choix, Oui/Non, unités, dans l’ordre du formulaire', () => {
    const summary = summarizeAnswers(homeCleaningService(), {
      // Ordre des réponses différent de celui du formulaire.
      answers: { pets: true, condition: 'very_dirty', rooms: 6, housing_type: 'villa' },
      optionSelections: [
        { code: 'appliances', answers: {} },
        { code: 'windows', answers: { window_count: 12 } },
      ],
      frequency: 'weekly',
    });
    expect(summary.fields).toEqual([
      {
        code: 'housing_type',
        label: 'Type de logement',
        type: 'choice',
        value: 'villa',
        display: 'Villa',
        unitLabel: null,
      },
      {
        code: 'rooms',
        label: 'Nombre de pièces',
        type: 'number',
        value: 6,
        display: '6 pièces',
        unitLabel: 'pièces',
      },
      {
        code: 'condition',
        label: 'État',
        type: 'choice',
        value: 'very_dirty',
        display: 'Très sale',
        unitLabel: null,
      },
      {
        code: 'pets',
        label: "Présence d'animaux",
        type: 'boolean',
        value: true,
        display: 'Oui',
        unitLabel: null,
      },
    ]);
    // Options dans l'ordre du formulaire (vitres avant électroménager).
    expect(summary.options.map((option) => [option.optionCode, option.label])).toEqual([
      ['windows', 'Vitres'],
      ['appliances', 'Électroménager'],
    ]);
    expect(summary.options[0]!.fields[0]).toMatchObject({ display: '12 fenêtres' });
    expect(summary.frequency).toEqual({ code: 'weekly', label: 'Chaque semaine' });
  });

  it('grands nombres groupés ; « non » affiché ; champ inconnu de la version gardé avec son code', () => {
    const summary = summarizeAnswers(gardenService(), {
      answers: { surface: 12_500, condition: 'maintained', legacy_flag: false },
      optionSelections: [],
      frequency: null,
    });
    expect(summary.fields.map((field) => field.display)).toEqual(['12 500 m²', 'Entretenu', 'Non']);
    expect(summary.fields[2]).toMatchObject({ code: 'legacy_flag', label: 'legacy_flag', type: 'boolean' });
    expect(summary.frequency).toBeNull();
  });

  it('prestation inconnue : les codes servent de libellés', () => {
    const summary = summarizeAnswers(UNKNOWN_DEFINITION, {
      answers: { surface: 120, condition: 'dirty' },
      optionSelections: [{ code: 'windows', answers: { window_count: 3 } }],
      frequency: 'once',
    });
    expect(summary.fields.map((field) => [field.label, field.display])).toEqual([
      ['surface', '120'],
      ['condition', 'dirty'],
    ]);
    expect(summary.options[0]).toMatchObject({ optionCode: 'windows', label: 'windows' });
    expect(summary.frequency).toEqual({ code: 'once', label: 'once' });
  });

  it('ancien format : type de locaux et quantité avec leurs libellés', () => {
    const summary = summarizeLegacy(homeCleaningService(), {
      premisesType: 'other',
      quantity: 2,
      options: ['windows', 'unknown_option'],
      frequency: 'monthly',
    });
    expect(summary.fields).toEqual([
      {
        code: 'premises_type',
        label: 'Type de locaux',
        type: 'choice',
        value: 'other',
        display: 'Autre',
        unitLabel: null,
      },
      {
        code: 'quantity',
        label: 'Quantité',
        type: 'number',
        value: 2,
        display: '2 pièces',
        unitLabel: 'pièces',
      },
    ]);
    expect(summary.options).toEqual([
      { optionCode: 'windows', label: 'Vitres', fields: [] },
      { optionCode: 'unknown_option', label: 'unknown_option', fields: [] },
    ]);
    expect(summary.frequency).toEqual({ code: 'monthly', label: 'Chaque mois' });

    const orphan = summarizeLegacy(null, {
      premisesType: 'warehouse',
      quantity: 1500,
      options: [],
      frequency: 'weekly',
    });
    expect(orphan.fields.map((field) => field.display)).toEqual(['Entrepôt', '1 500']);
    expect(orphan.frequency).toEqual({ code: 'weekly', label: 'Chaque semaine' });
  });
});
