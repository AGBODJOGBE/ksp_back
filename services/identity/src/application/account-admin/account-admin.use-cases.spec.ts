import { AppError, type RequestContext, runWithContext } from '@ksp/platform';
import { InMemoryAccountAdmin } from '../testing/account-admin-fakes';
import { InMemoryRoles } from '../testing/mfa-fakes';
import {
  AccountDetails,
  ChangeAccountStatusUseCase,
  GetAccountUseCase,
  GrantAccountRoleUseCase,
  ListAssignableRolesUseCase,
  ResetAccountMfaUseCase,
  RevokeAccountRoleUseCase,
  SearchAccountsUseCase,
} from './account-admin.use-cases';

const DIRECTOR = '0192f1c4-0000-7000-8000-00000000ad01';
const DEPUTY = '0192f1c4-0000-7000-8000-00000000ad02';
const CLEANING_HEAD = '0192f1c4-0000-7000-8000-00000000ad03';
const AGENT = '0192f1c4-0000-7000-8000-00000000a001';
const CUSTOMER = '0192f1c4-0000-7000-8000-00000000c001';
const UNKNOWN = '0192f1c4-0000-7000-8000-00000000ffff';

const REASON = 'Arrivée dans l’équipe du Nettoyage';

function setup() {
  let seq = 0;
  const now = new Date('2026-11-07T10:00:00Z');
  const ids = { next: () => `0192f1c4-0000-7000-8000-${String(++seq).padStart(12, '0')}` };
  const clock = { now: () => now };
  const roles = new InMemoryRoles();
  const accounts = new InMemoryAccountAdmin(roles);
  accounts.add({ id: DIRECTOR, firstName: 'Afi', lastName: 'Kpodar', phoneE164: '+2290197000001' });
  accounts.add({ id: DEPUTY, firstName: 'Sena', lastName: 'Houngbo', phoneE164: '+2290197000002' });
  accounts.add({ id: CLEANING_HEAD, firstName: 'Rachid', lastName: 'Bello', phoneE164: '+2290197000003' });
  accounts.add({ id: AGENT, firstName: 'Awa', lastName: 'Dossou', phoneE164: '+2290197000045' });
  accounts.add({ id: CUSTOMER, firstName: 'Koffi', lastName: 'Agbo', phoneE164: '+2290197000099' });
  roles.assign(DIRECTOR, 'super_admin', '0192f1c4-0000-7000-8000-0000000a0001');
  roles.assign(DEPUTY, 'super_admin', '0192f1c4-0000-7000-8000-0000000a0002');
  roles.assign(CLEANING_HEAD, 'cleaning_admin', '0192f1c4-0000-7000-8000-0000000a0003');
  roles.assign(AGENT, 'cleaning_agent', '0192f1c4-0000-7000-8000-0000000a0004');
  accounts.mfa.set(AGENT, { configuredAt: new Date('2026-10-02T08:00:00Z'), unusedCodes: 8 });
  const details = new AccountDetails(accounts);
  return {
    roles,
    accounts,
    search: new SearchAccountsUseCase(accounts),
    get: new GetAccountUseCase(details),
    catalog: new ListAssignableRolesUseCase(accounts),
    grant: new GrantAccountRoleUseCase(details, roles, ids, clock),
    revoke: new RevokeAccountRoleUseCase(details, accounts, roles, ids, clock),
    status: new ChangeAccountStatusUseCase(details, accounts, ids, clock),
    resetMfa: new ResetAccountMfaUseCase(details, accounts, ids, clock),
  };
}

/** Appel d'un membre du back-office (jeton : rôles, double authentification faite maintenant). */
function as<T>(
  userId: string,
  roleCodes: string[],
  fn: () => Promise<T>,
  options: { mfa: boolean; mfaAgeSeconds?: number } = { mfa: true },
): Promise<T> {
  const context: RequestContext = {
    correlationId: 'c',
    user: {
      userId,
      sessionId: 's',
      activeContext: 'personal',
      roles: roleCodes.map((role) => ({ role, scopeType: 'global' })),
      mfa: options.mfa,
      authTime: Math.floor(Date.now() / 1000) - (options.mfaAgeSeconds ?? 0),
    },
  };
  return runWithContext(context, fn);
}
const asDirector = <T>(fn: () => Promise<T>) => as(DIRECTOR, ['customer', 'super_admin'], fn);
const asCleaningHead = <T>(fn: () => Promise<T>) => as(CLEANING_HEAD, ['customer', 'cleaning_admin'], fn);

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof AppError)) throw new Error(`AppError attendue, reçu ${String(error)}`);
  return error;
}

describe('SearchAccountsUseCase', () => {
  it('super_admin : sans recherche, les comptes qui ont un rôle ; numéro complet affiché', async () => {
    const { search } = setup();
    const page = await asDirector(() => search.execute({ query: '', limit: 0, cursor: '' }));
    expect(page.items.map((item) => item.id).sort()).toEqual([AGENT, CLEANING_HEAD, DEPUTY, DIRECTOR].sort());
    const agent = page.items.find((item) => item.id === AGENT)!;
    expect(agent).toMatchObject({
      phoneE164: '+2290197000045',
      phoneMasked: '+229********45',
      roleCodes: ['cleaning_agent'],
    });
  });

  it('super_admin : par nom (chaque mot) ou par numéro, clients compris', async () => {
    const { search } = setup();
    const byName = await asDirector(() => search.execute({ query: 'koffi AG', limit: 0, cursor: '' }));
    expect(byName.items.map((item) => item.id)).toEqual([CUSTOMER]);
    const byPhone = await asDirector(() => search.execute({ query: '+2290197000099', limit: 0, cursor: '' }));
    expect(byPhone.items.map((item) => item.id)).toEqual([CUSTOMER]);
  });

  it('pages : les plus récents d’abord, curseur de la page suivante', async () => {
    const { search } = setup();
    const first = await asDirector(() => search.execute({ query: '', limit: 2, cursor: '' }));
    expect(first.items.map((item) => item.id)).toEqual([CLEANING_HEAD, DEPUTY]);
    expect(first.nextCursor).toBe(DEPUTY);
    const second = await asDirector(() => search.execute({ query: '', limit: 2, cursor: first.nextCursor! }));
    expect(second.items.map((item) => item.id)).toEqual([DIRECTOR, AGENT]);
    expect(second.nextCursor).toBeNull();
  });

  it('administrateur du Nettoyage : son équipe seulement, numéro masqué ; un numéro complet retrouve tout compte', async () => {
    const { search } = setup();
    const team = await asCleaningHead(() => search.execute({ query: '', limit: 0, cursor: '' }));
    expect(team.items.map((item) => item.id).sort()).toEqual([AGENT, CLEANING_HEAD].sort());
    expect(team.items.every((item) => item.phoneE164 === null && item.phoneMasked)).toBe(true);
    const byName = await asCleaningHead(() => search.execute({ query: 'Koffi', limit: 0, cursor: '' }));
    expect(byName.items).toEqual([]);
    const byPhone = await asCleaningHead(() =>
      search.execute({ query: '+2290197000099', limit: 0, cursor: '' }),
    );
    expect(byPhone.items.map((item) => item.id)).toEqual([CUSTOMER]);
  });

  it('refuse une recherche trop courte, un compte sans rôle d’administration, une session sans double authentification', async () => {
    const { search } = setup();
    const short = await failure(asDirector(() => search.execute({ query: 'k', limit: 0, cursor: '' })));
    expect(short).toMatchObject({ code: 'IDENTITY_ACCOUNT_ADMIN_INVALID', details: { field: 'query' } });
    const support = await failure(
      as(DEPUTY, ['support_agent'], () => search.execute({ query: '', limit: 0, cursor: '' })),
    );
    expect(support.code).toBe('AUTH_FORBIDDEN');
    const noMfa = await failure(
      as(DIRECTOR, ['super_admin'], () => search.execute({ query: '', limit: 0, cursor: '' }), {
        mfa: false,
      }),
    );
    expect(noMfa.code).toBe('AUTH_MFA_REQUIRED');
  });

  it('écritures : double authentification de moins de 10 minutes ; lecture : celle de la session', async () => {
    const { get, grant, revoke, status, resetMfa } = setup();
    const stale = { mfa: true, mfaAgeSeconds: 11 * 60 };
    const director = <T>(fn: () => Promise<T>) => as(DIRECTOR, ['super_admin'], fn, stale);
    await expect(director(() => get.execute(AGENT))).resolves.toMatchObject({ account: { id: AGENT } });
    const writes = [
      () => grant.execute({ userId: CUSTOMER, roleCode: 'cleaning_agent', reason: REASON }),
      () =>
        revoke.execute({
          userId: AGENT,
          assignmentId: '0192f1c4-0000-7000-8000-0000000a0004',
          reason: REASON,
        }),
      () => status.execute({ userId: AGENT, action: 'suspend', reason: REASON }),
      () => resetMfa.execute({ userId: AGENT, reason: REASON }),
    ];
    for (const write of writes) {
      expect((await failure(director(write))).code).toBe('AUTH_MFA_REQUIRED');
    }
  });
});

describe('GetAccountUseCase et ListAssignableRolesUseCase', () => {
  it('fiche : rôles avec leur périmètre, double authentification, actions permises', async () => {
    const { get } = setup();
    const detail = await asDirector(() => get.execute(AGENT));
    expect(detail.account).toMatchObject({ id: AGENT, status: 'active', phoneE164: '+2290197000045' });
    expect(detail.mfa).toEqual({
      configuredAt: new Date('2026-10-02T08:00:00Z'),
      recoveryCodesRemaining: 8,
      resettable: true,
    });
    expect(detail.roles).toHaveLength(1);
    expect(detail.roles[0]).toMatchObject({ scopeType: 'domain', scopeId: 'cleaning', revocable: true });
    expect(detail.actions).toEqual({ grantRole: true, suspend: true, reactivate: false, resetMfa: true });

    const self = await asDirector(() => get.execute(DIRECTOR));
    expect(self.actions).toEqual({ grantRole: true, suspend: false, reactivate: false, resetMfa: false });
  });

  it('administrateur du Nettoyage : son équipe seulement, aucune action sur le compte', async () => {
    const { get, grant } = setup();
    const agent = await asCleaningHead(() => get.execute(AGENT));
    expect(agent.account.phoneE164).toBeNull();
    expect(agent.roles[0]!.revocable).toBe(true);
    expect(agent.actions).toEqual({ grantRole: true, suspend: false, reactivate: false, resetMfa: false });
    // Hors de son métier (ADR-050) : introuvable, comme un compte inconnu.
    for (const id of [DIRECTOR, CUSTOMER]) {
      expect((await failure(asCleaningHead(() => get.execute(id)))).code).toBe('IDENTITY_USER_NOT_FOUND');
    }
    // Un client retrouvé par son numéro complet rejoint l'équipe par l'attribution d'un rôle.
    await asCleaningHead(() =>
      grant.execute({ userId: CUSTOMER, roleCode: 'cleaning_agent', reason: REASON }),
    );
    await expect(asCleaningHead(() => get.execute(CUSTOMER))).resolves.toMatchObject({
      account: { id: CUSTOMER },
    });
  });

  it('compte inconnu, mal formé ou supprimé : introuvable', async () => {
    const { get, accounts } = setup();
    accounts.add({ id: UNKNOWN, status: 'deleted' });
    for (const id of [UNKNOWN, 'abc', '0192f1c4-0000-7000-8000-00000000eeee']) {
      expect((await failure(asDirector(() => get.execute(id)))).code).toBe('IDENTITY_USER_NOT_FOUND');
    }
  });

  it('catalogue : attribuables selon le périmètre', async () => {
    const { catalog } = setup();
    const all = await asDirector(() => catalog.execute());
    expect(all.every((role) => role.grantable)).toBe(true);
    const cleaning = await asCleaningHead(() => catalog.execute());
    expect(cleaning.filter((role) => role.grantable).map((role) => role.code)).toEqual([
      'cleaning_agent',
      'cleaning_supervisor',
    ]);
  });
});

describe('GrantAccountRoleUseCase', () => {
  it('attribue le rôle avec sa portée, publie identity.role.granted, garde le motif et la trace', async () => {
    const { grant, roles } = setup();
    const detail = await asDirector(() =>
      grant.execute({ userId: CUSTOMER, roleCode: 'cleaning_supervisor', reason: `  ${REASON} ` }),
    );
    expect(roles.granted).toEqual([
      expect.objectContaining({
        userId: CUSTOMER,
        roleCode: 'cleaning_supervisor',
        scopeType: 'domain',
        scopeId: 'cleaning',
        created: true,
      }),
    ]);
    expect(detail.account.roleCodes).toEqual(['cleaning_supervisor']);
    expect(detail.roles[0]).toMatchObject({
      grantedBy: DIRECTOR,
      grantedByName: 'Afi Kpodar',
      grantReason: REASON,
    });
    expect(detail.history).toEqual([
      expect.objectContaining({
        action: 'user.role_granted',
        actorId: DIRECTOR,
        roleCode: 'cleaning_supervisor',
      }),
    ]);
  });

  it('une attribution identique déjà active ne crée rien', async () => {
    const { grant, roles } = setup();
    await asDirector(() => grant.execute({ userId: AGENT, roleCode: 'cleaning_agent', reason: REASON }));
    expect(roles.granted).toEqual([]);
    expect(roles.audit).toEqual([]);
  });

  it("l'administrateur du Nettoyage attribue les rôles de son métier, jamais le sien ni ceux d'un autre", async () => {
    const { grant } = setup();
    await asCleaningHead(() =>
      grant.execute({ userId: CUSTOMER, roleCode: 'cleaning_agent', reason: REASON }),
    );
    for (const roleCode of ['cleaning_admin', 'recovery_agent', 'super_admin']) {
      const error = await failure(
        asCleaningHead(() => grant.execute({ userId: CUSTOMER, roleCode, reason: REASON })),
      );
      expect(error.code).toBe('IDENTITY_ROLE_FORBIDDEN');
    }
  });

  it('motif obligatoire ; rôle inconnu ; compte non actif', async () => {
    const { grant, accounts } = setup();
    const noReason = await failure(
      asDirector(() => grant.execute({ userId: CUSTOMER, roleCode: 'cleaning_agent' })),
    );
    expect(noReason).toMatchObject({ code: 'IDENTITY_ACCOUNT_ADMIN_INVALID', details: { field: 'reason' } });
    const unknown = await failure(
      asDirector(() => grant.execute({ userId: CUSTOMER, roleCode: 'pilot', reason: REASON })),
    );
    expect(unknown.code).toBe('IDENTITY_ROLE_NOT_FOUND');
    accounts.accounts.get(CUSTOMER)!.status = 'suspended';
    const suspended = await failure(
      asDirector(() => grant.execute({ userId: CUSTOMER, roleCode: 'cleaning_agent', reason: REASON })),
    );
    expect(suspended).toMatchObject({
      code: 'IDENTITY_ACCOUNT_NOT_ACTIVE',
      details: { status: 'suspended' },
    });
  });
});

describe('RevokeAccountRoleUseCase', () => {
  const AGENT_ROLE = '0192f1c4-0000-7000-8000-0000000a0004';
  const DIRECTOR_ROLE = '0192f1c4-0000-7000-8000-0000000a0001';
  const DEPUTY_ROLE = '0192f1c4-0000-7000-8000-0000000a0002';

  it('retire le rôle avec le motif, publie identity.role.revoked, garde l’historique', async () => {
    const { revoke, roles } = setup();
    const detail = await asCleaningHead(() =>
      revoke.execute({ userId: AGENT, assignmentId: AGENT_ROLE, reason: 'Départ de l’équipe' }),
    );
    expect(roles.revoked).toEqual([
      expect.objectContaining({
        assignmentId: AGENT_ROLE,
        userId: AGENT,
        actorId: CLEANING_HEAD,
        reason: 'Départ de l’équipe',
        roleCode: 'cleaning_agent',
      }),
    ]);
    expect(detail.account.roleCodes).toEqual([]);
    expect(detail.roles[0]).toMatchObject({
      revokedBy: CLEANING_HEAD,
      revokedByName: 'Rachid Bello',
      revokeReason: 'Départ de l’équipe',
      revocable: false,
    });
    expect(detail.actions.grantRole).toBe(true);

    const again = await failure(
      asCleaningHead(() => revoke.execute({ userId: AGENT, assignmentId: AGENT_ROLE, reason: 'x' })),
    );
    expect(again.code).toBe('IDENTITY_ROLE_ALREADY_REVOKED');
  });

  it('attribution inconnue ou d’un autre compte : introuvable ; rôle hors périmètre : refusé', async () => {
    const { revoke } = setup();
    const other = await failure(
      asDirector(() => revoke.execute({ userId: CUSTOMER, assignmentId: AGENT_ROLE, reason: REASON })),
    );
    expect(other.code).toBe('IDENTITY_ROLE_ASSIGNMENT_NOT_FOUND');
    const outside = await failure(
      asCleaningHead(() => revoke.execute({ userId: DIRECTOR, assignmentId: DIRECTOR_ROLE, reason: REASON })),
    );
    expect(outside.code).toBe('IDENTITY_ROLE_FORBIDDEN');
  });

  it('jamais sans super administrateur actif : le dernier ne se retire pas, même à soi-même', async () => {
    const { revoke, roles } = setup();
    // Un autre super administrateur actif reste : retrait possible, y compris le sien.
    await asDirector(() => revoke.execute({ userId: DIRECTOR, assignmentId: DIRECTOR_ROLE, reason: REASON }));
    const last = await failure(
      as(DEPUTY, ['super_admin'], () =>
        revoke.execute({ userId: DEPUTY, assignmentId: DEPUTY_ROLE, reason: REASON }),
      ),
    );
    expect(last.code).toBe('IDENTITY_LAST_SUPER_ADMIN');
    expect(roles.revoked).toHaveLength(1);
  });
});

describe('ChangeAccountStatusUseCase', () => {
  it('suspend : sessions fermées, événement, trace ; puis réactive', async () => {
    const { status, accounts } = setup();
    const suspended = await asDirector(() =>
      status.execute({ userId: AGENT, action: 'suspend', reason: 'Téléphone volé' }),
    );
    expect(suspended.account).toMatchObject({ status: 'suspended', suspensionReason: 'Téléphone volé' });
    expect(suspended.actions).toMatchObject({ suspend: false, reactivate: true, grantRole: false });
    expect(accounts.revokedSessions).toEqual([{ userId: AGENT, reason: 'account_suspended' }]);
    expect(accounts.events[0]).toEqual({
      type: 'identity.user.suspended',
      payload: { userId: AGENT, reason: 'Téléphone volé', suspendedBy: DIRECTOR },
    });

    const active = await asDirector(() =>
      status.execute({ userId: AGENT, action: 'reactivate', reason: 'Téléphone retrouvé' }),
    );
    expect(active.account).toMatchObject({ status: 'active', suspendedAt: null });
    expect(active.history.map((entry) => entry.action)).toEqual(['user.reactivated', 'user.suspended']);
  });

  it('réservé à super_admin ; jamais son propre compte ; motif obligatoire', async () => {
    const { status } = setup();
    const head = await failure(
      asCleaningHead(() => status.execute({ userId: AGENT, action: 'suspend', reason: REASON })),
    );
    expect(head.code).toBe('AUTH_FORBIDDEN');
    const self = await failure(
      asDirector(() => status.execute({ userId: DIRECTOR, action: 'suspend', reason: REASON })),
    );
    expect(self.code).toBe('IDENTITY_SELF_ACTION_FORBIDDEN');
    const noReason = await failure(
      asDirector(() => status.execute({ userId: AGENT, action: 'suspend', reason: ' ' })),
    );
    expect(noReason.code).toBe('IDENTITY_ACCOUNT_ADMIN_INVALID');
  });

  it('transition impossible ou passée entre-temps : état réel dans les détails', async () => {
    const { status, accounts } = setup();
    const invalid = await failure(
      asDirector(() => status.execute({ userId: AGENT, action: 'reactivate', reason: REASON })),
    );
    expect(invalid).toMatchObject({
      code: 'IDENTITY_ACCOUNT_INVALID_TRANSITION',
      details: { from: 'active', action: 'reactivate' },
    });
    accounts.raceOnNextChange = true;
    const raced = await failure(
      asDirector(() => status.execute({ userId: AGENT, action: 'suspend', reason: REASON })),
    );
    expect(raced).toMatchObject({ details: { from: 'suspended', action: 'suspend' } });
  });

  it('ne suspend pas le dernier super administrateur actif', async () => {
    const { status, roles } = setup();
    // Jeton encore valable d'un directeur dont le rôle vient d'être retiré : DEPUTY reste seul.
    roles.assignments.find((a) => a.userId === DIRECTOR)!.revokedAt = new Date();
    const error = await failure(
      asDirector(() => status.execute({ userId: DEPUTY, action: 'suspend', reason: REASON })),
    );
    expect(error.code).toBe('IDENTITY_LAST_SUPER_ADMIN');
  });
});

describe('ResetAccountMfaUseCase', () => {
  it('efface la double authentification, ferme les sessions du back-office, trace le motif', async () => {
    const { resetMfa, accounts } = setup();
    const detail = await asDirector(() => resetMfa.execute({ userId: AGENT, reason: 'Téléphone perdu' }));
    expect(detail.mfa).toEqual({ configuredAt: null, recoveryCodesRemaining: 0, resettable: false });
    expect(detail.actions.resetMfa).toBe(false);
    expect(accounts.revokedSessions).toEqual([{ userId: AGENT, reason: 'mfa_reset' }]);
    expect(detail.history[0]).toMatchObject({ action: 'user.mfa_reset', reason: 'Téléphone perdu' });

    const again = await failure(
      asDirector(() => resetMfa.execute({ userId: AGENT, reason: 'Téléphone perdu' })),
    );
    expect(again.code).toBe('IDENTITY_MFA_NOT_ENROLLED');
  });

  it('jamais son propre compte ; réservé à super_admin', async () => {
    const { resetMfa, accounts } = setup();
    accounts.mfa.set(DIRECTOR, { configuredAt: new Date(), unusedCodes: 10 });
    const self = await failure(asDirector(() => resetMfa.execute({ userId: DIRECTOR, reason: REASON })));
    expect(self.code).toBe('IDENTITY_SELF_ACTION_FORBIDDEN');
    const head = await failure(asCleaningHead(() => resetMfa.execute({ userId: AGENT, reason: REASON })));
    expect(head.code).toBe('AUTH_FORBIDDEN');
  });
});
