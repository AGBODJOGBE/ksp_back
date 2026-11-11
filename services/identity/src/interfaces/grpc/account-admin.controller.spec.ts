import { identityV1 } from '@ksp/contracts';
import { type RequestContext, runWithContext } from '@ksp/platform';
import { FindAccountByPhoneUseCase } from '../../application/account-admin/find-account-by-phone.use-case';
import {
  AccountDetails,
  ChangeAccountStatusUseCase,
  GetAccountUseCase,
  GrantAccountRoleUseCase,
  ListAssignableRolesUseCase,
  ResetAccountMfaUseCase,
  RevokeAccountRoleUseCase,
  SearchAccountsUseCase,
} from '../../application/account-admin/account-admin.use-cases';
import { InMemoryAccountAdmin } from '../../application/testing/account-admin-fakes';
import { InMemoryRoles } from '../../application/testing/mfa-fakes';
import { AccountAdminGrpcController } from './account-admin.controller';

const ID = '0192f1c4-0000-7000-8000-000000000001';
const ADMIN = '0192f1c4-0000-7000-8000-0000000000aa';
const ASSIGNMENT = '0192f1c4-0000-7000-8000-0000000000b1';

const as = <T>(role: string, fn: () => Promise<T>): Promise<T> => {
  const context: RequestContext = {
    correlationId: 'c',
    user: {
      userId: ADMIN,
      sessionId: 's',
      activeContext: 'personal',
      roles: [{ role, scopeType: 'global' }],
      mfa: true,
      authTime: Math.floor(Date.now() / 1000),
    },
  };
  return runWithContext(context, fn);
};

function controller() {
  const roles = new InMemoryRoles();
  const accounts = new InMemoryAccountAdmin(roles);
  accounts.add({ id: ADMIN, firstName: 'Afi', lastName: 'Kpodar', phoneE164: '+2290197000001' });
  accounts.add({ id: ID, firstName: 'Awa', lastName: null, phoneE164: '+2290197000045' });
  roles.assign(ADMIN, 'super_admin', '0192f1c4-0000-7000-8000-0000000000b0');
  roles.assign(ID, 'cleaning_agent', ASSIGNMENT);
  const details = new AccountDetails(accounts);
  const ids = { next: () => '0192f1c4-0000-7000-8000-0000000000c1' };
  const clock = { now: () => new Date('2026-11-07T10:00:00Z') };
  return new AccountAdminGrpcController(
    new FindAccountByPhoneUseCase({
      findByPhone: async () => ({
        id: ID,
        status: 'active',
        firstName: 'Awa',
        lastName: null,
        phoneE164: '+2290197000045',
        email: null,
        emailVerifiedAt: null,
        preferredLanguage: 'fr',
        createdAt: new Date('2026-10-19T12:00:00Z'),
      }),
    }),
    new SearchAccountsUseCase(accounts),
    new GetAccountUseCase(details),
    new ListAssignableRolesUseCase(accounts),
    new GrantAccountRoleUseCase(details, roles, ids, clock),
    new RevokeAccountRoleUseCase(details, accounts, roles, ids, clock),
    new ChangeAccountStatusUseCase(details, accounts, ids, clock),
    new ResetAccountMfaUseCase(details, accounts, ids, clock, 3600),
  );
}

describe('AccountAdminGrpcController', () => {
  it('FindAccountByPhone : compte au format du contrat, nom vide si le profil est incomplet', async () => {
    await expect(
      as('cleaning_admin', () => controller().findAccountByPhone({ phoneE164: '+2290197000045' })),
    ).resolves.toEqual({
      account: {
        userId: ID,
        status: identityV1.UserStatus.USER_STATUS_ACTIVE,
        firstName: 'Awa',
        lastName: '',
        phoneMasked: '+229********45',
      },
    });
  });

  it('SearchAccounts : valeurs absentes en chaînes vides, curseur vide en dernière page', async () => {
    const res = await as('cleaning_admin', () =>
      controller().searchAccounts({ query: '', limit: 0, cursor: '' }),
    );
    expect(res).toEqual({
      accounts: [
        {
          userId: ID,
          status: identityV1.UserStatus.USER_STATUS_ACTIVE,
          firstName: 'Awa',
          lastName: '',
          phoneE164: '',
          phoneMasked: '+229********45',
          createdAt: '2026-10-01T08:00:00.000Z',
          suspendedAt: '',
          suspensionReason: '',
          roleCodes: ['cleaning_agent'],
        },
      ],
      nextCursor: '',
    });
  });

  it('GetAccount et SuspendAccount : fiche complète au format du contrat', async () => {
    const grpc = controller();
    const { detail } = await as('super_admin', () => grpc.getAccount({ userId: ID }));
    expect(detail!.roles).toEqual([
      {
        id: ASSIGNMENT,
        roleCode: 'cleaning_agent',
        roleDescription: 'Agent de terrain du nettoyage',
        service: 'cleaning',
        scopeType: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
        scopeId: 'cleaning',
        grantedAt: '2026-10-01T08:00:00.000Z',
        grantedBy: '',
        grantedByName: '',
        grantReason: '',
        revokedAt: '',
        revokedBy: '',
        revokedByName: '',
        revokeReason: '',
        revocable: true,
      },
    ]);
    expect(detail!.mfa).toEqual({ configured: false, configuredAt: '', recoveryCodesRemaining: 0 });
    expect(detail!.actions).toEqual({ grantRole: true, suspend: true, reactivate: false, resetMfa: false });

    const suspended = await as('super_admin', () => grpc.suspendAccount({ userId: ID, reason: 'Fraude' }));
    expect(suspended.detail!.account).toMatchObject({
      status: identityV1.UserStatus.USER_STATUS_SUSPENDED,
      phoneE164: '+2290197000045',
      suspendedAt: '2026-11-07T10:00:00.000Z',
      suspensionReason: 'Fraude',
    });
    expect(suspended.detail!.history[0]).toEqual({
      id: '0192f1c4-0000-7000-8000-0000000000c1',
      action: 'user.suspended',
      at: '2026-11-07T10:00:00.000Z',
      actorId: ADMIN,
      actorName: '',
      roleCode: '',
      reason: 'Fraude',
    });
  });

  it('ListAssignableRoles : portée en énumération, attribuables selon le périmètre', async () => {
    const res = await as('cleaning_admin', () => controller().listAssignableRoles());
    expect(res.roles.find((role) => role.code === 'cleaning_agent')).toEqual({
      code: 'cleaning_agent',
      service: 'cleaning',
      scopeType: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
      description: 'Agent de terrain du nettoyage',
      backofficeAccess: true,
      grantable: true,
    });
    expect(res.roles.find((role) => role.code === 'super_admin')?.grantable).toBe(false);
  });
});
