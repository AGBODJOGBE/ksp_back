import { DuplicateKeyError } from '../../application/ports';
import { cursorFilter, pageArgs, toPage, translateUniqueViolation } from './changes';

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

describe('unicité violée', () => {
  const p2002 = (target: unknown) => ({ code: 'P2002', meta: { target } });

  it('clé d’idempotence, code cité, sinon écriture concurrente', () => {
    expect(translateUniqueViolation(p2002(['actor_id', 'operation', 'idempotency_key']))).toEqual(
      new DuplicateKeyError('idempotency'),
    );
    expect(translateUniqueViolation(p2002(['code']), ['code'])).toMatchObject({ key: 'code' });
    expect(translateUniqueViolation(p2002(['offer_id', 'version']), ['code'])).toMatchObject({
      key: 'concurrent',
    });
  });

  it('toute autre erreur est rendue telle quelle', () => {
    const other = new Error('panne');
    expect(translateUniqueViolation(other)).toBe(other);
    expect(translateUniqueViolation(null)).toBeNull();
  });
});
