import { type CleaningBinding, CleaningCodec, type MessageCodec } from './cleaning-codec';

/** Tables écrites à la main, de la même forme que celles de cleaning-bindings.ts. */
const MESSAGES: Record<string, MessageCodec> = {
  Body: {
    name: {},
    toArea: {},
    values: { codec: { map: 'parameterValue' } },
    memberIds: { codec: { wrap: 'items', list: 'value' } },
    brackets: { codec: { list: { message: 'Bracket' } } },
  },
  Bracket: { fromArea: {}, toArea: {} },
  Page: {
    data: { from: 'items', codec: { list: { message: 'Item' } } },
    nextCursor: { emptyAsNull: true },
    total: {},
  },
  Item: {
    id: {},
    value: { codec: 'parameterValue', absent: 'null' },
    erasedAt: { absent: 'null' },
    price: { absent: 'omit' },
    tags: {},
  },
};

const codec = new CleaningCodec(MESSAGES);

describe('CleaningCodec', () => {
  const binding: CleaningBinding = {
    service: 'TeamService',
    method: 'updateTeam',
    params: { id: 'teamId' },
    idempotencyKey: true,
    body: { message: 'Body' },
    response: { codec: { message: 'Page' } },
  };

  it('requête : chemin, requête, clé d’idempotence et corps dans un seul message', () => {
    expect(
      codec.request(binding, {
        params: { id: 't-1' },
        query: { limit: 5, cursor: undefined },
        body: {
          name: 'Équipe A',
          // Null REST : champ gRPC absent (borne ouverte).
          toArea: null,
          values: { surface: 120, standing: 'haut', pets: false },
          memberIds: [],
          brackets: [{ fromArea: 0, toArea: null }],
        },
        idempotencyKey: 'cle-00000001',
        read: false,
      }),
    ).toEqual({
      teamId: 't-1',
      limit: 5,
      idempotencyKey: 'cle-00000001',
      name: 'Équipe A',
      values: { surface: { number: 120 }, standing: { choice: 'haut' }, pets: { flag: false } },
      // Liste vide envoyée : message présent, distinct d'un champ absent (inchangé).
      memberIds: { items: [] },
      brackets: [{ fromArea: 0 }],
    });
  });

  it('réponse : liste « data », curseur vide → null, champs absents → null ou omis', () => {
    const message = {
      items: [
        {
          id: 'i-1',
          value: { number: 0, value: 'number' },
          tags: ['a'],
          _erasedAt: 'erasedAt',
          erasedAt: 'x',
        },
        { id: 'i-2', value: null, tags: [] },
      ],
      nextCursor: '',
      total: 2,
    };
    expect(codec.response(binding, message)).toEqual({
      data: [
        { id: 'i-1', value: 0, erasedAt: 'x', tags: ['a'] },
        { id: 'i-2', value: null, erasedAt: null, tags: [] },
      ],
      nextCursor: null,
      total: 2,
    });
  });

  it('réponse d’un seul champ du message ; sans corps (204) : undefined', () => {
    const single: CleaningBinding = { ...binding, response: { field: 'item', codec: { message: 'Item' } } };
    expect(
      codec.response(single, { item: { id: 'i-1', value: { choice: 'haut', value: 'choice' }, tags: [] } }),
    ).toEqual({ id: 'i-1', value: 'haut', erasedAt: null, tags: [] });
    expect(codec.response({ ...binding, response: null }, {})).toBeUndefined();
  });
});
