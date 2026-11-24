import { identityV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { IdentityAgentRoles } from './identity-agent-roles';

const USER = '0192f1c4-0000-7000-8000-00000000a002';
const ASSIGNMENT = '0192f1c4-0000-7000-8000-0000000000f1';

function adapter(answers: { grant?: () => unknown; revoke?: () => unknown }) {
  const grants: identityV1.GrantRoleRequest[] = [];
  const revocations: identityV1.RevokeRoleRequest[] = [];
  const client = {
    grantRole: (request: identityV1.GrantRoleRequest) => {
      grants.push(request);
      return (answers.grant ?? (() => of({ assignment: { id: ASSIGNMENT } })))();
    },
    revokeRole: (request: identityV1.RevokeRoleRequest) => {
      revocations.push(request);
      return (answers.revoke ?? (() => of({})))();
    },
  } as unknown as identityV1.IdentityServiceClient;
  return {
    grants,
    revocations,
    roles: new IdentityAgentRoles(client, new GrpcCaller({ target: 'identity', retryBackoffMs: 1 })),
  };
}

const outage = () =>
  throwError(() => new AppError('UNAVAILABLE', 'GRPC_UNAVAILABLE', 'identity injoignable'));

describe('IdentityAgentRoles (identity.GrantRole et RevokeRole, R-AG-01)', () => {
  it('attribue cleaning_agent au compte, dans le métier cleaning, avec le motif tracé', async () => {
    const { roles, grants } = adapter({});
    await expect(roles.grant({ userId: USER, reason: 'Agent validé' })).resolves.toEqual({
      assignmentId: ASSIGNMENT,
    });
    expect(grants).toEqual([
      {
        userId: USER,
        roleCode: 'cleaning_agent',
        scopeType: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
        scopeId: 'cleaning',
        reason: 'Agent validé',
      },
    ]);
  });

  it('identity injoignable : une nouvelle tentative (appel idempotent), puis IDENTITY_UNAVAILABLE', async () => {
    const { roles, grants } = adapter({ grant: outage });
    await expect(roles.grant({ userId: USER, reason: 'Agent validé' })).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
    expect(grants).toHaveLength(2);
    const slow = adapter({
      revoke: () =>
        throwError(() => new AppError('DEADLINE_EXCEEDED', 'GRPC_DEADLINE_EXCEEDED', 'trop lent')),
    });
    await expect(slow.roles.revoke({ assignmentId: ASSIGNMENT, reason: 'x' })).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
  });

  it('refus d’identity transmis tel quel, sans nouvelle tentative ; réponse sans attribution : erreur', async () => {
    const refused = adapter({
      grant: () =>
        throwError(() =>
          AppError.precondition('IDENTITY_ACCOUNT_NOT_ACTIVE', 'Ce compte n’est pas actif.', {
            status: 'pending_verification',
          }),
        ),
    });
    await expect(refused.roles.grant({ userId: USER, reason: 'Agent validé' })).rejects.toMatchObject({
      code: 'IDENTITY_ACCOUNT_NOT_ACTIVE',
      details: { status: 'pending_verification' },
    });
    expect(refused.grants).toHaveLength(1);
    await expect(
      adapter({ grant: () => of({}) }).roles.grant({ userId: USER, reason: 'Agent validé' }),
    ).rejects.toThrow('Réponse d’identity sans attribution.');
  });

  it('retire l’attribution ; une attribution inconnue d’identity n’est plus à retirer', async () => {
    const { roles, revocations } = adapter({});
    await roles.revoke({ assignmentId: ASSIGNMENT, reason: 'Agent désactivé' });
    expect(revocations).toEqual([{ assignmentId: ASSIGNMENT, reason: 'Agent désactivé' }]);
    const unknown = adapter({
      revoke: () =>
        throwError(() =>
          AppError.notFound('IDENTITY_ROLE_ASSIGNMENT_NOT_FOUND', 'Cette attribution est introuvable.'),
        ),
    });
    await expect(
      unknown.roles.revoke({ assignmentId: ASSIGNMENT, reason: 'Agent désactivé' }),
    ).resolves.toBeUndefined();
    const forbidden = adapter({
      revoke: () =>
        throwError(() =>
          AppError.forbidden('IDENTITY_ROLE_FORBIDDEN', 'Ce service ne peut pas attribuer ce rôle.'),
        ),
    });
    await expect(
      forbidden.roles.revoke({ assignmentId: ASSIGNMENT, reason: 'Agent désactivé' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_ROLE_FORBIDDEN' });
  });
});
