import { AppError } from '@ksp/platform';
import { lastAdminObstacles, scheduledDeletionDate } from '../../domain/user/account-deletion';
import { type ActiveContexts } from '../context/active-contexts';
import { GetMeUseCase, UpdateMeUseCase } from '../account/account.use-cases';
import { type PendingEmails } from '../email/pending-email';
import { InMemoryChallenges, InMemoryIdentityStore } from '../testing/fakes';
import { FakeObligationChecker, InMemoryAccountDeletions } from '../testing/deletion-fakes';
import { InMemoryRoles } from '../testing/mfa-fakes';
import { type StoredSession } from '../session/session-store.ports';
import { type Account } from '../session/session.ports';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import {
  AnonymizeDueAccountsUseCase,
  CancelDeletionUseCase,
  RequestDeletionUseCase,
} from './account-deletion.use-cases';

const USER = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001';
const OTHER = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002';
const OLD_SESSION = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0101';
const NEW_SESSION = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0102';
const DAY = 86_400_000;

function account(id: string, change: Partial<Account> = {}): Account {
  return {
    id,
    status: 'active',
    firstName: 'Koffi',
    lastName: 'Adjovi',
    phoneE164: id === USER ? '+2290197000045' : '+2290197000046',
    email: 'koffi@exemple.com',
    emailVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...change,
  };
}

function setup() {
  let now = new Date('2026-11-05T10:00:00Z');
  const clock = { now: () => now };
  const store = new InMemoryIdentityStore(new InMemoryChallenges());
  store.accounts.push(account(USER), account(OTHER));
  store.sessions.push({
    id: OLD_SESSION,
    userId: USER,
    clientKind: 'web',
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 30 * DAY),
    refreshTokenHash: 'h-1',
  });
  const deletions = new InMemoryAccountDeletions(store);
  const obligations = new FakeObligationChecker();
  const roles = new InMemoryRoles();
  const issued: { roles: unknown; sessionId: string; activeContext: string }[] = [];
  const accessTokens = {
    issue: async (subject: { roles: unknown; sessionId: string; activeContext: string }) => {
      issued.push(subject);
      return {
        token: 'jwt-complet',
        tokenId: 'j',
        expiresAt: new Date(now.getTime() + 900_000),
        activeContext: { type: 'individual' as const, organizationId: null, organizationName: null },
      };
    },
  } as unknown as AccessTokenIssuer;
  const sessions = {
    findSession: async (id: string): Promise<StoredSession | null> => {
      const session = store.sessions.find((candidate) => candidate.id === id);
      if (!session) return null;
      return {
        id: session.id,
        userId: session.userId,
        clientKind: session.clientKind,
        createdAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt ?? null,
        account: store.accounts.find((candidate) => candidate.id === session.userId)!,
      };
    },
  };
  const request = new RequestDeletionUseCase(store, deletions, roles, obligations, clock, { delayDays: 30 });
  const cancel = new CancelDeletionUseCase(sessions, store, deletions, accessTokens, clock);
  const anonymize = new AnonymizeDueAccountsUseCase(deletions, obligations, clock, {
    recheckMinutes: 60,
    batchSize: 50,
  });
  /** Nouvelle connexion pendant le délai : session restreinte, ouverte après la demande. */
  const reconnect = () =>
    store.sessions.push({
      id: NEW_SESSION,
      userId: USER,
      clientKind: 'mobile',
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY),
      refreshTokenHash: 'h-2',
    });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const user = () => store.accounts.find((candidate) => candidate.id === USER)!;
  return {
    store,
    deletions,
    obligations,
    roles,
    issued,
    request,
    cancel,
    anonymize,
    reconnect,
    advance,
    user,
    now: () => now,
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('Suppression du compte : règles (domaine)', () => {
  it('date prévue = demande + délai en jours', () => {
    expect(scheduledDeletionDate(new Date('2026-11-05T10:00:00Z'), 30)).toEqual(
      new Date('2026-12-05T10:00:00Z'),
    );
  });

  it('le seul administrateur d’une organisation reçoit une raison lisible', () => {
    expect(lastAdminObstacles([{ id: 'o-1', legalName: 'SARL Bénin Propre' }])).toEqual([
      {
        service: 'identity',
        kind: 'last_org_admin',
        reference: 'SARL Bénin Propre',
        description: expect.stringContaining('SARL Bénin Propre'),
      },
    ]);
  });
});

describe('RequestDeletionUseCase (UC-ID-11)', () => {
  it('gèle le compte 30 jours, ferme toutes ses sessions et publie la demande', async () => {
    const { request, deletions, store, user } = setup();
    const deletion = await request.execute(USER);
    expect(deletion).toEqual({
      requestedAt: new Date('2026-11-05T10:00:00Z'),
      scheduledFor: new Date('2026-12-05T10:00:00Z'),
      postponedBy: [],
    });
    expect(user().status).toBe('deletion_pending');
    expect(store.sessions.every((session) => session.revokedAt)).toBe(true);
    expect(deletions.events).toEqual([
      {
        type: 'identity.user.deletion_requested',
        payload: {
          userId: USER,
          requestedAt: '2026-11-05T10:00:00.000Z',
          scheduledFor: '2026-12-05T10:00:00.000Z',
        },
      },
    ]);
  });

  it('une obligation en cours refuse la demande, avec la liste des raisons', async () => {
    const { request, obligations, user } = setup();
    obligations.next = {
      status: 'blocked',
      obstacles: [
        {
          service: 'billing',
          kind: 'unpaid_invoice',
          reference: 'FAC-2026-000042',
          description: 'Une facture est en attente de paiement.',
        },
        {
          service: 'cleaning',
          kind: 'open_cleaning_mission',
          reference: 'm-1',
          description: 'Une prestation de nettoyage est en cours ou à venir.',
        },
      ],
    };
    const error = await expectAppError(request.execute(USER), 'IDENTITY_DELETION_BLOCKED');
    expect(error.kind).toBe('FAILED_PRECONDITION');
    expect(error.details['obligations']).toHaveLength(2);
    expect(user().status).toBe('active');
  });

  it('un service injoignable refuse la demande : réessayer plus tard', async () => {
    const { request, obligations, user } = setup();
    obligations.next = { status: 'unavailable', services: ['payment'] };
    const error = await expectAppError(request.execute(USER), 'IDENTITY_DELETION_CHECK_UNAVAILABLE');
    expect(error.kind).toBe('UNAVAILABLE');
    expect(error.details).toEqual({ services: ['payment'] });
    expect(user().status).toBe('active');
  });

  it('le seul administrateur d’une organisation non refusée est refusé', async () => {
    const { request, deletions, obligations } = setup();
    deletions.administrations.push({
      organization: { id: 'o-1', legalName: 'SARL Bénin Propre' },
      admins: [USER],
    });
    const error = await expectAppError(request.execute(USER), 'IDENTITY_DELETION_LAST_ORG_ADMIN');
    expect(error.details).toEqual({ organizations: [{ id: 'o-1', legalName: 'SARL Bénin Propre' }] });
    expect(obligations.calls).toEqual([]);
  });

  it('un autre administrateur actif, ou une organisation refusée, ne bloque pas', async () => {
    const { request, deletions, user } = setup();
    deletions.administrations.push(
      { organization: { id: 'o-1', legalName: 'SARL Bénin Propre' }, admins: [USER, OTHER] },
      { organization: { id: 'o-2', legalName: 'SARL Refusée' }, admins: [USER], rejected: true },
    );
    await request.execute(USER);
    expect(user().status).toBe('deletion_pending');
  });

  it('un autre administrateur lui-même en cours de suppression ne compte pas', async () => {
    const { request, deletions, store } = setup();
    deletions.administrations.push({
      organization: { id: 'o-1', legalName: 'SARL Bénin Propre' },
      admins: [USER, OTHER],
    });
    store.accounts.find((candidate) => candidate.id === OTHER)!.status = 'deletion_pending';
    await expectAppError(request.execute(USER), 'IDENTITY_DELETION_LAST_ORG_ADMIN');
  });

  it('un compte interne (rôle du back-office) passe par un administrateur KSP', async () => {
    const { request, roles } = setup();
    roles.assign(USER, 'super_admin');
    await expectAppError(request.execute(USER), 'IDENTITY_DELETION_INTERNAL_ACCOUNT');
  });

  it('un compte suspendu ou supprimé ne peut pas demander la suppression', async () => {
    const { request, user } = setup();
    user().status = 'suspended';
    await expectAppError(request.execute(USER), 'IDENTITY_ACCOUNT_SUSPENDED');
    user().status = 'deleted';
    await expectAppError(request.execute(USER), 'IDENTITY_USER_NOT_FOUND');
  });

  it('idempotent : une seconde demande rend la même échéance, sans nouveau contrôle ni événement', async () => {
    const { request, deletions, obligations, advance } = setup();
    const first = await request.execute(USER);
    advance(DAY);
    expect(await request.execute(USER)).toEqual(first);
    expect(obligations.calls).toHaveLength(1);
    expect(deletions.events).toHaveLength(1);
  });
});

describe('Session restreinte d’un compte en cours de suppression', () => {
  const pendingEmails = { of: async () => null } as unknown as PendingEmails;
  const contexts = {
    of: async () => ({ type: 'individual' as const, organizationId: null, organizationName: null }),
  } as unknown as ActiveContexts;

  it('le profil se lit, avec la suppression prévue', async () => {
    const { request, store } = setup();
    await request.execute(USER);
    const profile = await new GetMeUseCase(store, pendingEmails, contexts).execute(USER, 'personal');
    expect(profile.account.status).toBe('deletion_pending');
    expect(profile.deletion).toEqual({
      requestedAt: new Date('2026-11-05T10:00:00Z'),
      scheduledFor: new Date('2026-12-05T10:00:00Z'),
      postponedBy: [],
    });
  });

  it('le profil ne se modifie plus', async () => {
    const { request, store } = setup();
    await request.execute(USER);
    await expectAppError(
      new UpdateMeUseCase(store, pendingEmails, contexts).execute({
        userId: USER,
        activeContext: 'personal',
        firstName: 'Kofi',
      }),
      'IDENTITY_ACCOUNT_DELETION_PENDING',
    );
  });
});

describe('CancelDeletionUseCase (UC-ID-11)', () => {
  it('depuis une nouvelle connexion : compte réactivé et jeton complet pour la même session', async () => {
    const { request, cancel, reconnect, deletions, issued, user } = setup();
    await request.execute(USER);
    reconnect();
    const result = await cancel.execute({ userId: USER, sessionId: NEW_SESSION });
    expect(user().status).toBe('active');
    expect(user().deletion).toBeNull();
    expect(result).toMatchObject({ accessToken: 'jwt-complet', account: { id: USER, status: 'active' } });
    expect(issued).toEqual([
      expect.objectContaining({
        sessionId: NEW_SESSION,
        activeContext: 'personal',
        roles: [{ role: 'customer', scopeType: 'personal' }],
      }),
    ]);
    expect(deletions.events.map((event) => event.type)).toEqual([
      'identity.user.deletion_requested',
      'identity.user.deletion_cancelled',
    ]);
  });

  it('une session d’avant la demande (fermée) ne peut pas annuler', async () => {
    const { request, cancel, user } = setup();
    await request.execute(USER);
    await expectAppError(
      cancel.execute({ userId: USER, sessionId: OLD_SESSION }),
      'IDENTITY_SESSION_REVOKED',
    );
    await expectAppError(
      cancel.execute({ userId: USER, sessionId: 'pas-un-uuid' }),
      'IDENTITY_SESSION_REVOKED',
    );
    expect(user().status).toBe('deletion_pending');
  });

  it('la session d’un autre compte ne peut pas annuler', async () => {
    const { request, cancel, reconnect } = setup();
    await request.execute(USER);
    reconnect();
    await expectAppError(
      cancel.execute({ userId: OTHER, sessionId: NEW_SESSION }),
      'IDENTITY_SESSION_REVOKED',
    );
  });

  it('idempotent : sur un compte actif, rend simplement un nouveau jeton', async () => {
    const { cancel, deletions } = setup();
    const result = await cancel.execute({ userId: USER, sessionId: OLD_SESSION });
    expect(result.account.status).toBe('active');
    expect(deletions.events).toEqual([]);
  });
});

describe('AnonymizeDueAccountsUseCase (UC-ID-11, tâche planifiée)', () => {
  it('à l’échéance : anonymise, libère le numéro et publie identity.user.deleted', async () => {
    const { request, anonymize, advance, deletions, user, obligations } = setup();
    await request.execute(USER);
    advance(30 * DAY);
    const run = await anonymize.execute();
    expect(run).toEqual({ anonymized: [USER], postponed: [], unchecked: [] });
    expect(obligations.calls).toEqual([USER, USER]);
    expect(user()).toMatchObject({
      status: 'deleted',
      firstName: null,
      lastName: null,
      email: null,
      phoneE164: null,
    });
    expect(deletions.anonymizedPhones).toEqual(['+2290197000045']);
    expect(deletions.events.at(-1)).toEqual({ type: 'identity.user.deleted', payload: { userId: USER } });
  });

  it('avant l’échéance : rien n’est touché', async () => {
    const { request, anonymize, advance, user } = setup();
    await request.execute(USER);
    advance(30 * DAY - 1000);
    expect(await anonymize.execute()).toEqual({ anonymized: [], postponed: [], unchecked: [] });
    expect(user().status).toBe('deletion_pending');
  });

  it('une obligation apparue pendant le délai reporte l’anonymisation, et la signale', async () => {
    const { request, anonymize, advance, user, obligations, deletions } = setup();
    await request.execute(USER);
    advance(30 * DAY);
    const obstacle = {
      service: 'cleaning',
      kind: 'open_cleaning_mission',
      reference: 'm-9',
      description: 'Une prestation de nettoyage est en cours ou à venir.',
    };
    obligations.next = { status: 'blocked', obstacles: [obstacle] };
    expect(await anonymize.execute()).toEqual({
      anonymized: [],
      postponed: [{ userId: USER, obstacles: [obstacle] }],
      unchecked: [],
    });
    expect(user().status).toBe('deletion_pending');
    expect(user().deletion?.postponedBy).toEqual([obstacle]);

    // Pas de nouveau contrôle avant le délai de contrôle ; ensuite, l'obligation levée : anonymisé.
    expect((await anonymize.execute()).postponed).toEqual([]);
    obligations.next = { status: 'clear' };
    advance(61 * 60_000);
    expect((await anonymize.execute()).anonymized).toEqual([USER]);
    expect(deletions.events.at(-1)?.type).toBe('identity.user.deleted');
  });

  it('un service injoignable reporte aussi l’anonymisation', async () => {
    const { request, anonymize, advance, user, obligations } = setup();
    await request.execute(USER);
    advance(30 * DAY);
    obligations.next = { status: 'unavailable', services: ['billing'] };
    expect(await anonymize.execute()).toEqual({
      anonymized: [],
      postponed: [],
      unchecked: [{ userId: USER, services: ['billing'] }],
    });
    expect(user().status).toBe('deletion_pending');
  });

  it('devenu seul administrateur pendant le délai : anonymisation reportée', async () => {
    const { request, anonymize, advance, deletions, store } = setup();
    deletions.administrations.push({
      organization: { id: 'o-1', legalName: 'SARL Bénin Propre' },
      admins: [USER, OTHER],
    });
    await request.execute(USER);
    store.accounts.find((candidate) => candidate.id === OTHER)!.status = 'suspended';
    deletions.administrations[0]!.admins = [USER];
    advance(30 * DAY);
    const run = await anonymize.execute();
    expect(run.postponed[0]?.obstacles[0]).toMatchObject({ kind: 'last_org_admin' });
  });

  it('idempotente : un second passage ne refait rien, une annulation de dernière minute l’emporte', async () => {
    const { request, anonymize, advance, deletions, store } = setup();
    await request.execute(USER);
    store.accounts.find((candidate) => candidate.id === OTHER)!.status = 'active';
    advance(30 * DAY);
    await anonymize.execute();
    const events = deletions.events.length;
    expect(await anonymize.execute()).toEqual({ anonymized: [], postponed: [], unchecked: [] });
    expect(deletions.events).toHaveLength(events);
    expect(await deletions.anonymize(USER, new Date())).toBe(false);

    // Autre compte : annulé avant le passage, il n'est jamais anonymisé.
    const second = setup();
    await second.request.execute(USER);
    second.advance(30 * DAY);
    second.reconnect();
    await second.cancel.execute({ userId: USER, sessionId: NEW_SESSION });
    expect(await second.anonymize.execute()).toEqual({ anonymized: [], postponed: [], unchecked: [] });
    expect(second.user().status).toBe('active');
  });

  it('traite les comptes par lots', async () => {
    const { store, deletions, obligations, advance, now } = setup();
    for (const index of [1, 2, 3]) {
      store.accounts.push(
        account(`0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d100${index}`, {
          status: 'deletion_pending',
          deletion: { requestedAt: now(), scheduledFor: now(), postponedBy: [] },
        }),
      );
    }
    const batch = new AnonymizeDueAccountsUseCase(
      deletions,
      obligations,
      { now },
      {
        recheckMinutes: 60,
        batchSize: 2,
      },
    );
    advance(1000);
    expect((await batch.execute()).anonymized).toHaveLength(2);
    expect((await batch.execute()).anonymized).toHaveLength(1);
  });
});
