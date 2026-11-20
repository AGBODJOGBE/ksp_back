import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import {
  GetOrganizationsUseCase,
  type OrganizationDirectory,
} from '../../application/directory/get-organizations.use-case';
import { GetUsersUseCase, type UserDirectory } from '../../application/directory/get-users.use-case';
import { GetCatalogUseCase, RegisterCatalogUseCase } from '../../application/rbac/catalog.use-cases';
import {
  CheckPermissionUseCase,
  GrantRoleUseCase,
  ListStaffByPermissionUseCase,
  RevokeRoleUseCase,
} from '../../application/rbac/service-roles.use-cases';
import { type StaffDirectory } from '../../application/rbac/rbac.ports';
import { type Account } from '../../application/session/session.ports';
import { InMemoryRoles } from '../../application/testing/mfa-fakes';
import { InMemoryRbac } from '../../application/testing/rbac-fakes';
import { type Organization } from '../../domain/organization/organization';
import { IdentityGrpcController } from './identity.controller';

const ID = '0192f1c4-0000-7000-8000-000000000001';

const account: Account = {
  id: ID,
  status: 'active',
  firstName: 'Koffi',
  lastName: null,
  phoneE164: '+2290197000045',
  email: null,
  emailVerifiedAt: null,
  preferredLanguage: 'fr',
  createdAt: new Date('2026-10-19T12:00:00Z'),
};

const directory: UserDirectory = {
  findByIds: async (ids) => (ids.includes(ID) ? [account] : []),
};

const ORG_ID = '0192f1c4-0000-7000-8000-00000000a001';

const organization: Organization = {
  id: ORG_ID,
  legalName: 'SARL Bénin Propre',
  address: 'Lot 12, Haie Vive, Cotonou',
  ifu: '3201912345678',
  rccm: null,
  billingEmail: 'compta@benin-propre.bj',
  status: 'suspended',
  createdBy: ID,
  createdAt: new Date('2026-10-27T09:00:00Z'),
  reviewedBy: null,
  reviewedAt: null,
  rejectionReason: null,
  suspendedAt: new Date('2026-10-28T09:00:00Z'),
  suspensionReason: 'Usurpation signalée',
};

const organizations: OrganizationDirectory = {
  findByIds: async (ids) => (ids.includes(ORG_ID) ? [{ ...organization, adminUserIds: [ID] }] : []),
};

const rbac = new InMemoryRbac();
const roles = new InMemoryRoles();
const staff: StaffDirectory = {
  staffWith: async () => [ID],
  accountStatus: async (userId) => (userId === ID ? 'active' : null),
  assignment: async () => null,
};
const ids = { next: () => '0192f1c4-0000-7000-8000-0000000000c1' };
const clock = { now: () => new Date('2026-11-20T10:00:00Z') };
const controller = new IdentityGrpcController(
  new GetUsersUseCase(directory),
  new GetOrganizationsUseCase(organizations),
  new RegisterCatalogUseCase(rbac, ids, clock),
  new GetCatalogUseCase(rbac),
  new GrantRoleUseCase(roles, staff, ids, clock),
  new RevokeRoleUseCase(roles, staff, ids, clock),
  new ListStaffByPermissionUseCase(staff),
  new CheckPermissionUseCase(roles, staff),
);

const asCaller = <T>(callerService: string, fn: () => Promise<T>) =>
  runWithContext({ correlationId: 'c', callerService }, fn);

describe('IdentityGrpcController', () => {
  it('GetUser rend le compte au format du contrat, pour notification', async () => {
    const response = await asCaller('notification', () => controller.getUser({ userId: ID }));
    expect(response).toEqual({
      user: {
        id: ID,
        status: identityV1.UserStatus.USER_STATUS_ACTIVE,
        firstName: 'Koffi',
        lastName: '',
        phoneE164: '+2290197000045',
        email: '',
        preferredLanguage: 'fr',
        createdAt: '2026-10-19T12:00:00.000Z',
        emailVerified: false,
      },
    });
  });

  it('GetUsersByIds omet les comptes introuvables', async () => {
    const response = await asCaller('notification', () =>
      controller.getUsersByIds({ userIds: [ID, '0192f1c4-0000-7000-8000-0000000000ff'] }),
    );
    expect(response.users.map((user) => user.id)).toEqual([ID]);
  });

  it('refuse un service appelant non autorisé', async () => {
    await expect(asCaller('gateway', () => controller.getUser({ userId: ID }))).rejects.toMatchObject({
      code: 'IDENTITY_CALLER_FORBIDDEN',
    });
  });

  it('GetOrganizationsByIds rend la fiche sans membres ni décisions ; e-mail à notification seul', async () => {
    const forNotification = await asCaller('notification', () =>
      controller.getOrganizationsByIds({ organizationIds: [ORG_ID, '0192f1c4-0000-7000-8000-0000000000ff'] }),
    );
    expect(forNotification).toEqual({
      organizations: [
        {
          id: ORG_ID,
          legalName: 'SARL Bénin Propre',
          address: 'Lot 12, Haie Vive, Cotonou',
          adminUserIds: [ID],
          ifu: '3201912345678',
          rccm: '',
          billingEmail: 'compta@benin-propre.bj',
          status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_SUSPENDED,
        },
      ],
    });
    const forBilling = await asCaller('billing', () =>
      controller.getOrganizationsByIds({ organizationIds: [ORG_ID] }),
    );
    expect(forBilling.organizations[0]?.billingEmail).toBe('');
    expect(forBilling.organizations[0]?.adminUserIds).toEqual([]);
    await expect(
      asCaller('gateway', () => controller.getOrganizationsByIds({ organizationIds: [ORG_ID] })),
    ).rejects.toMatchObject({ code: 'IDENTITY_CALLER_FORBIDDEN' });
  });

  it('RegisterCatalog : le service est celui du jeton ; GetCatalog rend le module', async () => {
    const response = await asCaller('cleaning', () =>
      controller.registerCatalog({
        service: 'cleaning',
        catalogVersion: 1,
        permissions: [
          { code: 'cleaning.request.read', description: 'Lire', service: '', module: '', retired: false },
        ],
        roles: [],
      }),
    );
    expect(response).toEqual({ accepted: true, permissionsAdded: 1, permissionsRetired: 0, rolesCreated: 0 });
    const catalog = await asCaller('cleaning', () => controller.getCatalog({ service: 'cleaning' }));
    expect(catalog.permissions[0]).toMatchObject({ code: 'cleaning.request.read', module: 'request' });
  });

  it('GrantRole : attribution au format RoleAssignment, auteur le service appelant', async () => {
    const response = await asCaller('cleaning', () =>
      controller.grantRole({
        userId: ID,
        roleCode: 'cleaning_agent',
        scopeType: identityV1.ScopeType.SCOPE_TYPE_UNSPECIFIED,
        scopeId: '',
        reason: 'Agent validé',
      }),
    );
    expect(response.assignment).toMatchObject({
      userId: ID,
      roleCode: 'cleaning_agent',
      scopeType: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
      scopeId: 'cleaning',
      grantedBy: 'cleaning',
      grantedAt: '2026-11-20T10:00:00.000Z',
    });
  });

  it('ListStaffByPermission : notification seul', async () => {
    await expect(
      asCaller('notification', () =>
        controller.listStaffByPermission({ permission: 'cleaning.request.process', zoneKey: 'cotonou' }),
      ),
    ).resolves.toEqual({ userIds: [ID] });
    await expect(
      asCaller('billing', () =>
        controller.listStaffByPermission({ permission: 'cleaning.request.process', zoneKey: '' }),
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_CALLER_FORBIDDEN' });
  });

  it('CheckPermission : refusé sans la permission', async () => {
    await expect(
      asCaller('cleaning', () =>
        controller.checkPermission({
          userId: ID,
          permission: 'cleaning.quote.adjust_price',
          scopeType: identityV1.ScopeType.SCOPE_TYPE_GLOBAL,
          scopeId: '',
        }),
      ),
    ).resolves.toEqual({ allowed: false, reason: 'permission_missing' });
  });
});
