import { MAX_PACK_ITEMS, packCompositionProblems } from './pack';

const sol = { id: 'sol', isPack: false };
const vitres = { id: 'vitres', isPack: false };
const complet = { id: 'complet', isPack: true };

describe('composition d’un pack (R-CA-04)', () => {
  it('accepte un pack de types simples, et un type simple sans contenu', () => {
    expect(
      packCompositionProblems({ typeId: null, isPack: true, items: [sol, vitres], containedInPack: false }),
    ).toEqual([]);
    expect(
      packCompositionProblems({ typeId: 'sol', isPack: false, items: [], containedInPack: true }),
    ).toEqual([]);
  });

  it('refuse un pack qui contient un autre pack (not_applicable)', () => {
    expect(
      packCompositionProblems({
        typeId: 'menage',
        isPack: true,
        items: [sol, complet],
        containedInPack: false,
      }),
    ).toEqual([{ field: 'packItemIds[1]', reason: 'not_applicable' }]);
  });

  it('refuse qu’un type déjà contenu dans un pack devienne un pack', () => {
    expect(
      packCompositionProblems({ typeId: 'sol', isPack: true, items: [vitres], containedInPack: true }),
    ).toEqual([{ field: 'isPack', reason: 'not_applicable' }]);
  });

  it('refuse le pack lui-même, un doublon, un pack vide ou trop long', () => {
    expect(
      packCompositionProblems({ typeId: 'complet', isPack: true, items: [complet], containedInPack: false }),
    ).toEqual([{ field: 'packItemIds[0]', reason: 'not_applicable' }]);
    expect(
      packCompositionProblems({ typeId: null, isPack: true, items: [sol, sol], containedInPack: false }),
    ).toEqual([{ field: 'packItemIds[1]', reason: 'duplicate' }]);
    expect(
      packCompositionProblems({ typeId: null, isPack: true, items: [], containedInPack: false }),
    ).toEqual([{ field: 'packItemIds', reason: 'required' }]);
    const many = Array.from({ length: MAX_PACK_ITEMS + 1 }, (_, index) => ({
      id: `t${index}`,
      isPack: false,
    }));
    expect(
      packCompositionProblems({ typeId: null, isPack: true, items: many, containedInPack: false }),
    ).toEqual([{ field: 'packItemIds', reason: 'out_of_range' }]);
  });

  it('un type simple ne porte aucun type contenu', () => {
    expect(
      packCompositionProblems({ typeId: 'sol', isPack: false, items: [vitres], containedInPack: false }),
    ).toEqual([{ field: 'packItemIds', reason: 'not_applicable' }]);
  });
});
