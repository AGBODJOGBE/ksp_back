import { isProfileIncomplete, normalizeLanguage, normalizeName } from './profile';

describe('normalizeName', () => {
  it.each([
    ['Koffi', 'Koffi'],
    ['  Jean-Baptiste  ', 'Jean-Baptiste'],
    ["N'Diaye", "N'Diaye"],
    ['N’Diaye', 'N’Diaye'],
    ['Adjovi   Hounkpè', 'Adjovi Hounkpè'],
    ['Koffi A.', 'Koffi A.'],
    ['Zoé', 'Zoé'],
  ])('accepte %p', (value, expected) => {
    expect(normalizeName(value)).toBe(expected);
  });

  it.each(['', '   ', 'Koffi2', 'K@ffi', '-Koffi', "'Koffi", 'a'.repeat(101), '<script>'])(
    'refuse %p',
    (value) => {
      expect(normalizeName(value)).toBeNull();
    },
  );
});

describe('normalizeLanguage', () => {
  it('accepte un code de deux lettres, en minuscules', () => {
    expect(normalizeLanguage('fr')).toBe('fr');
    expect(normalizeLanguage(' EN ')).toBe('en');
  });

  it.each(['fra', 'f', 'fr-FR', '12'])('refuse %p', (value) => {
    expect(normalizeLanguage(value)).toBeNull();
  });
});

describe('isProfileIncomplete', () => {
  it('le profil est incomplet tant que le prénom ou le nom manque', () => {
    expect(isProfileIncomplete({ firstName: null, lastName: null })).toBe(true);
    expect(isProfileIncomplete({ firstName: 'Koffi', lastName: null })).toBe(true);
    expect(isProfileIncomplete({ firstName: 'Koffi', lastName: 'Adjovi' })).toBe(false);
  });
});
