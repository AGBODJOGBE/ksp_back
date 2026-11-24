import { AppError } from '@ksp/platform';
import { type Account, type UserStatusName } from '../session/session.ports';
import { InMemoryChallenges, InMemoryIdentityStore } from '../testing/fakes';
import {
  EnsureUserByPhoneUseCase,
  FindUserByPhoneUseCase,
  PHONE_ACCOUNT_CALLERS,
} from './phone-accounts.use-cases';

const ADMIN = '0192f1c4-0000-7000-8000-00000000ad01';
const NOW = new Date('2026-11-23T10:00:00Z');

function setup() {
  let seq = 0;
  const store = new InMemoryIdentityStore(new InMemoryChallenges());
  const ids = { next: () => `0192f1c4-0000-7000-8000-${String(++seq).padStart(12, '0')}` };
  const clock = { now: () => NOW };
  const account = (phoneE164: string, status: UserStatusName = 'active'): Account => {
    const created: Account = {
      id: ids.next(),
      status,
      firstName: 'Koffi',
      lastName: 'Adjovi',
      phoneE164,
      email: null,
      emailVerifiedAt: null,
      preferredLanguage: 'fr',
      createdAt: NOW,
    };
    store.accounts.push(created);
    return created;
  };
  return {
    store,
    account,
    find: new FindUserByPhoneUseCase(store),
    ensure: new EnsureUserByPhoneUseCase(store, store, ids, clock),
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw new Error(`AppError attendue, reçu ${String(error)}`);
  return error;
}

const NEW = { phone: '+229 01 97 00 00 45', firstName: ' Awa ', lastName: 'Dossou', requestedBy: ADMIN };

describe('appelants autorisés (liste fermée, sur le modèle de GrantRole)', () => {
  it('cleaning seul ; sans vérificateur (développement), l’appel passe', async () => {
    const { find, ensure, store } = setup();
    expect(PHONE_ACCOUNT_CALLERS).toEqual(['cleaning']);
    for (const caller of ['billing', 'notification', 'gateway']) {
      expect((await failure(find.execute(caller, { phone: NEW.phone }))).code).toBe(
        'IDENTITY_CALLER_FORBIDDEN',
      );
      expect((await failure(ensure.execute(caller, NEW))).code).toBe('IDENTITY_CALLER_FORBIDDEN');
    }
    expect(store.accounts).toEqual([]);
    expect(await find.execute(null, { phone: NEW.phone })).toEqual({ found: false });
  });
});

describe('FindUserByPhone : lire le compte d’un numéro, sans le créer', () => {
  it('rend l’identifiant et l’état du compte, numéro normalisé (ADR-063)', async () => {
    const { find, account, store } = setup();
    const existing = account('+2290197000045');
    // Les deux formes d'un numéro béninois désignent le même compte.
    for (const phone of ['+2290197000045', '+229 97 00 00 45', '00229 01 97-00-00-45']) {
      expect(await find.execute('cleaning', { phone })).toEqual({
        found: true,
        userId: existing.id,
        status: 'active',
      });
    }
    expect(store.accounts).toHaveLength(1);
  });

  it('numéro sans compte, ou compte supprimé : introuvable ; rien n’est créé', async () => {
    const { find, account, store } = setup();
    expect(await find.execute('cleaning', { phone: '+2290197000046' })).toEqual({ found: false });
    account('+2290197000047', 'deleted');
    expect(await find.execute('cleaning', { phone: '+2290197000047' })).toEqual({ found: false });
    expect(store.accounts).toHaveLength(1);
    expect(store.registered).toEqual([]);
  });

  it('compte suspendu ou en attente : rendu avec son état', async () => {
    const { find, account } = setup();
    const suspended = account('+2290197000048', 'suspended');
    expect(await find.execute('cleaning', { phone: '+2290197000048' })).toEqual({
      found: true,
      userId: suspended.id,
      status: 'suspended',
    });
  });

  it('numéro mal formé : IDENTITY_PHONE_INVALID', async () => {
    const { find } = setup();
    for (const phone of ['', '97000045', '+229abc']) {
      expect((await failure(find.execute('cleaning', { phone }))).code).toBe('IDENTITY_PHONE_INVALID');
    }
  });
});

describe('EnsureUserByPhone : trouver ou créer le compte d’un numéro', () => {
  it('crée le compte « en attente de vérification », avec le nom reçu, l’événement et la trace', async () => {
    const { ensure, store } = setup();
    const result = await ensure.execute('cleaning', NEW);
    expect(result).toMatchObject({ status: 'pending_verification', created: true });
    expect(store.accounts).toEqual([
      expect.objectContaining({
        id: result.userId,
        status: 'pending_verification',
        firstName: 'Awa',
        lastName: 'Dossou',
        phoneE164: '+2290197000045',
      }),
    ]);
    // Comme à la première vérification : identity.user.registered, sans téléphone.
    expect(store.registered).toEqual([result.userId]);
    // Trace : le service pour auteur, l'admin à l'origine, jamais le numéro.
    expect(store.audit).toEqual([
      {
        actorId: 'cleaning',
        action: 'user.registered_by_service',
        entityId: result.userId,
        at: NOW,
        details: { requestedBy: ADMIN },
      },
    ]);
    expect(JSON.stringify(store.audit)).not.toContain('97000045');
  });

  it('rend le compte existant sans le modifier, quel que soit le nom reçu', async () => {
    const { ensure, account, store } = setup();
    const existing = account('+2290197000045');
    expect(await ensure.execute('cleaning', NEW)).toEqual({
      userId: existing.id,
      status: 'active',
      created: false,
    });
    expect(store.accounts).toEqual([expect.objectContaining({ firstName: 'Koffi', lastName: 'Adjovi' })]);
    expect(store.registered).toEqual([]);
    expect(store.audit).toEqual([]);
  });

  it('rejoué : le même compte, toujours en attente, sans second événement', async () => {
    const { ensure, store } = setup();
    const first = await ensure.execute('cleaning', NEW);
    expect(await ensure.execute('cleaning', { ...NEW, phone: '+22997000045' })).toEqual({
      userId: first.userId,
      status: 'pending_verification',
      created: false,
    });
    expect(store.accounts).toHaveLength(1);
    expect(store.registered).toHaveLength(1);
  });

  it.each(['suspended', 'deletion_pending', 'deleted', 'locked'] as const)(
    'compte %s : erreur dédiée, rien n’est créé',
    async (status) => {
      const { ensure, account, store } = setup();
      account('+2290197000045', status);
      expect(await failure(ensure.execute('cleaning', NEW))).toMatchObject({
        kind: 'FAILED_PRECONDITION',
        code: 'IDENTITY_ACCOUNT_NOT_USABLE',
        details: { status },
      });
      expect(store.accounts).toHaveLength(1);
      expect(store.registered).toEqual([]);
    },
  );

  it('compte créé entre-temps par un autre appel : il est rendu, sans doublon', async () => {
    const { ensure, account, store } = setup();
    // Le numéro paraît libre à la lecture ; l'autre appel crée le compte juste avant l'écriture.
    const read = store.findByPhone.bind(store);
    let raced: Account | null = null;
    store.findByPhone = async (phone: string) => {
      const found = await read(phone);
      if (!found && !raced) raced = account('+2290197000045', 'pending_verification');
      return found;
    };
    const result = await ensure.execute('cleaning', NEW);
    expect(result).toEqual({ userId: raced!.id, status: 'pending_verification', created: false });
    expect(store.accounts).toHaveLength(1);
    expect(store.registered).toEqual([]);
  });

  it('numéro ou nom mal formé : refusé avant toute écriture', async () => {
    const { ensure, store } = setup();
    expect((await failure(ensure.execute('cleaning', { ...NEW, phone: '97000045' }))).code).toBe(
      'IDENTITY_PHONE_INVALID',
    );
    expect(await failure(ensure.execute('cleaning', { ...NEW, firstName: '  ' }))).toMatchObject({
      code: 'IDENTITY_NAME_INVALID',
      details: { field: 'firstName' },
    });
    expect(await failure(ensure.execute('cleaning', { ...NEW, lastName: 'Dossou 2' }))).toMatchObject({
      code: 'IDENTITY_NAME_INVALID',
      details: { field: 'lastName' },
    });
    expect(store.accounts).toEqual([]);
  });

  it('sans membre du personnel à l’origine (appel hors requête) : tracé sans lui', async () => {
    const { ensure, store } = setup();
    await ensure.execute('cleaning', { ...NEW, requestedBy: 'pas-un-uuid' });
    expect(store.audit[0]).toMatchObject({ actorId: 'cleaning', details: { requestedBy: null } });
  });
});
