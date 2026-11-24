import { runWithContext } from '@ksp/platform';
import { DuplicateKeyError, type IdempotencyRecord } from '../ports';
import { requireStaff } from './access';
import { requestHash, runIdempotent } from './idempotency';
import { pageOf, parsePage, parseSort } from './paging';

const AT = new Date('2026-11-20T10:00:00Z');

function memoryStore() {
  const records = new Map<string, IdempotencyRecord>();
  const keyOf = (ref: { actorId: string; operation: string; key: string }) =>
    `${ref.actorId}|${ref.operation}|${ref.key}`;
  return {
    records,
    store: {
      find: async (ref: { actorId: string; operation: string; key: string }) =>
        records.get(keyOf(ref)) ?? null,
    },
    save: (record: IdempotencyRecord) => records.set(keyOf(record), record),
  };
}

describe('idempotence (règle d’or n° 3)', () => {
  const base = { actorId: 'a1', operation: 'catalog.skill.create', key: 'cle-0001', at: AT };

  it('premier appel : action et clé enregistrée ; rejeu : réponse gardée, sans nouvel effet', async () => {
    const memory = memoryStore();
    let runs = 0;
    const call = (body: unknown) =>
      runIdempotent({
        ...base,
        store: memory.store,
        body,
        run: async (stub) => {
          runs += 1;
          memory.save(stub({ id: 'cree-1' }));
          return 'cree-1';
        },
        replay: async (response) => `rejoue-${String(response.id)}`,
      });
    await expect(call({ code: 'vidange', name: 'Vidange' })).resolves.toBe('cree-1');
    await expect(call({ name: 'Vidange', code: 'vidange' })).resolves.toBe('rejoue-cree-1');
    expect(runs).toBe(1);
    await expect(call({ code: 'jardin' })).rejects.toMatchObject({ code: 'CLEANING_IDEMPOTENCY_KEY_REUSED' });
  });

  it('clé invalide refusée', async () => {
    await expect(
      runIdempotent({
        ...base,
        key: 'court',
        store: memoryStore().store,
        body: {},
        run: async () => 'x',
        replay: async () => 'y',
      }),
    ).rejects.toMatchObject({ code: 'CLEANING_VALIDATION_FAILED', details: { field: 'idempotencyKey' } });
  });

  it('appel simultané : la clé déjà prise à l’écriture rejoue la réponse du premier', async () => {
    const memory = memoryStore();
    const body = { code: 'vidange' };
    const result = await runIdempotent({
      ...base,
      store: memory.store,
      body,
      run: async () => {
        memory.save({ ...base, requestHash: requestHash(body), response: { id: 'autre' } });
        throw new DuplicateKeyError('idempotency');
      },
      replay: async (response) => String(response.id),
    });
    expect(result).toBe('autre');
  });

  it('autre unicité violée : rendue telle quelle ; clé disparue : écriture concurrente', async () => {
    const memory = memoryStore();
    const run = (error: Error) =>
      runIdempotent({
        ...base,
        store: memory.store,
        body: {},
        run: async () => Promise.reject(error),
        replay: async () => 'y',
      });
    await expect(run(new DuplicateKeyError('code'))).rejects.toMatchObject({ key: 'code' });
    await expect(run(new DuplicateKeyError('idempotency'))).rejects.toMatchObject({
      code: 'CLEANING_CONCURRENT_UPDATE',
    });
  });
});

describe('pages du catalogue', () => {
  it('20 par défaut, 100 au plus ; curseur opaque du rang suivant', () => {
    const items = Array.from({ length: 45 }, (_, index) => index);
    const first = pageOf(items, parsePage({}));
    expect(first).toMatchObject({ total: 45, items: items.slice(0, 20) });
    const second = pageOf(items, parsePage({ limit: 20, cursor: first.nextCursor as string }));
    expect(second.items[0]).toBe(20);
    const last = pageOf(items, parsePage({ limit: 20, cursor: second.nextCursor as string }));
    expect(last).toMatchObject({ items: items.slice(40), nextCursor: null });
  });

  it('refuse une limite hors bornes, un curseur illisible, un tri inconnu', () => {
    expect(() => parsePage({ limit: 101 })).toThrow(
      expect.objectContaining({ details: { field: 'limit', reason: 'out_of_range' } }),
    );
    expect(() => parsePage({ cursor: 'zzz' })).toThrow(
      expect.objectContaining({ details: { field: 'cursor', reason: 'invalid_type' } }),
    );
    expect(parseSort(undefined, ['order', 'name'])).toBe('order');
    expect(parseSort('name', ['order', 'name'])).toBe('name');
    expect(() => parseSort('price', ['order'])).toThrow(
      expect.objectContaining({ details: { field: 'sort', reason: 'invalid_type' } }),
    );
  });
});

describe('accès du back-office', () => {
  const user = { userId: 'u1', sessionId: 's1', activeContext: 'personal', roles: [], mfa: true };
  const now = Date.parse('2026-11-20T10:00:00Z');

  it('compte connecté et double authentification de moins de 12 h', () => {
    const fresh = { ...user, authTime: now / 1000 - 3600 };
    expect(runWithContext({ correlationId: 'c', user: fresh }, () => requireStaff(now))).toBe('u1');
    const old = { ...user, authTime: now / 1000 - 13 * 3600 };
    expect(() => runWithContext({ correlationId: 'c', user: old }, () => requireStaff(now))).toThrow(
      expect.objectContaining({ code: 'AUTH_MFA_REQUIRED' }),
    );
    expect(() => runWithContext({ correlationId: 'c' }, () => requireStaff(now))).toThrow(
      expect.objectContaining({ code: 'AUTH_REQUIRED' }),
    );
  });
});
