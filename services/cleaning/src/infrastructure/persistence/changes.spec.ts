import { cursorFilter, pageArgs, toPage } from './changes';

describe('pages par curseur', () => {
  const rows = ['0192f1c4-0003', '0192f1c4-0002', '0192f1c4-0001'].map((id) => ({ id }));

  it('lit une ligne de plus que la page, les plus récentes d’abord', () => {
    expect(pageArgs({ limit: 2, cursor: null })).toEqual({ take: 3, orderBy: { id: 'desc' } });
    expect(cursorFilter({ cursor: null })).toEqual({});
    expect(cursorFilter({ cursor: '0192f1c4-0002' })).toEqual({ id: { lt: '0192f1c4-0002' } });
  });

  it('curseur suivant : dernière ligne rendue, null en fin de liste', () => {
    expect(toPage(rows, 2)).toEqual({ items: rows.slice(0, 2), nextCursor: '0192f1c4-0002' });
    expect(toPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
  });
});
