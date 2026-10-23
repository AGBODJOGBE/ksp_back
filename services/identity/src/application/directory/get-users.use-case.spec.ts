import { type Account } from '../session/session.ports';
import { GetUsersUseCase, MAX_USER_IDS, type UserDirectory } from './get-users.use-case';

const ID_1 = '0192f1c4-0000-7000-8000-000000000001';
const ID_2 = '0192f1c4-0000-7000-8000-000000000002';
const ID_DELETED = '0192f1c4-0000-7000-8000-000000000003';

const account = (id: string, overrides: Partial<Account> = {}): Account => ({
  id,
  status: 'active',
  firstName: 'Koffi',
  lastName: 'Adjovi',
  phoneE164: '+2290197000045',
  email: 'koffi@example.com',
  preferredLanguage: 'fr',
  createdAt: new Date('2026-10-19T12:00:00Z'),
  ...overrides,
});

function useCase() {
  const lookups: string[][] = [];
  const directory: UserDirectory = {
    findByIds: async (ids) => {
      lookups.push([...ids]);
      return [account(ID_1), account(ID_2), account(ID_DELETED, { status: 'deleted' })].filter((candidate) =>
        ids.includes(candidate.id),
      );
    },
  };
  return { lookups, users: new GetUsersUseCase(directory) };
}

describe('GetUsersUseCase', () => {
  it('rend les comptes avec leurs coordonnées à notification', async () => {
    const { users } = useCase();
    const found = await users.many('notification', [ID_1, ID_2]);
    expect(found.map((candidate) => candidate.id).sort()).toEqual([ID_1, ID_2]);
    expect(found[0].phoneE164).toBe('+2290197000045');
    expect(found[0].email).toBe('koffi@example.com');
  });

  it('omet les identifiants inconnus et les comptes supprimés', async () => {
    const { users } = useCase();
    const found = await users.many('notification', [
      ID_1,
      ID_DELETED,
      '0192f1c4-0000-7000-8000-0000000000ff',
    ]);
    expect(found.map((candidate) => candidate.id)).toEqual([ID_1]);
  });

  it('dédoublonne et normalise les identifiants avant la lecture', async () => {
    const { users, lookups } = useCase();
    await users.many('notification', [ID_1, ` ${ID_1.toUpperCase()} `]);
    expect(lookups).toEqual([[ID_1]]);
  });

  it('refuse un service non autorisé, sans lire la base', async () => {
    const { users, lookups } = useCase();
    await expect(users.many('cleaning', [ID_1])).rejects.toMatchObject({ code: 'IDENTITY_CALLER_FORBIDDEN' });
    await expect(users.many('constructor', [ID_1])).rejects.toMatchObject({
      code: 'IDENTITY_CALLER_FORBIDDEN',
    });
    expect(lookups).toEqual([]);
  });

  it('accepte un appel sans jeton de service vérifié (développement)', async () => {
    const { users } = useCase();
    await expect(users.one(null, ID_1)).resolves.toMatchObject({ id: ID_1 });
  });

  it('refuse un identifiant mal formé et un appel trop volumineux', async () => {
    const { users } = useCase();
    await expect(users.many('notification', ['pas-un-uuid'])).rejects.toMatchObject({
      code: 'IDENTITY_USER_ID_INVALID',
    });
    const tooMany = Array.from({ length: MAX_USER_IDS + 1 }, () => ID_1);
    await expect(users.many('notification', tooMany)).rejects.toMatchObject({
      code: 'IDENTITY_TOO_MANY_USER_IDS',
    });
  });

  it('GetUser : un compte inconnu ou supprimé est introuvable', async () => {
    const { users } = useCase();
    await expect(users.one('notification', ID_DELETED)).rejects.toMatchObject({
      code: 'IDENTITY_USER_NOT_FOUND',
    });
    await expect(users.one('notification', '0192f1c4-0000-7000-8000-0000000000ff')).rejects.toMatchObject({
      code: 'IDENTITY_USER_NOT_FOUND',
    });
  });

  it('rend une liste vide sans lire la base quand aucun identifiant n’est demandé', async () => {
    const { users, lookups } = useCase();
    await expect(users.many('notification', [])).resolves.toEqual([]);
    expect(lookups).toEqual([]);
  });
});
