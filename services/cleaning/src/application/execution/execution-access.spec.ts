import { AppError, runWithContext } from '@ksp/platform';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import { ExecutionRuleError } from '../../domain/sessions/errors';
import { currentCustomer, inScope, requireOrganizationRole } from './customer-access';
import { executionError, guarded, ruleAppError } from './execution-errors';

/** Traduction des refus du lot E et périmètre du client (R-CP-03, partie 16.3). */
describe('erreurs du lot E', () => {
  it.each([
    ['CLEANING_SESSION_NOT_FOUND', 'NOT_FOUND'],
    ['CLEANING_TEAM_LEAD_ONLY', 'PERMISSION_DENIED'],
    ['CLEANING_SECOND_APPROVER_REQUIRED', 'PERMISSION_DENIED'],
    ['CLEANING_RESCHEDULE_OVERLAP', 'CONFLICT'],
    ['CLEANING_VALIDATION_FAILED', 'INVALID_ARGUMENT'],
    ['CLEANING_SESSION_OVERDUE_PAYMENT', 'FAILED_PRECONDITION'],
  ] as const)('%s → nature %s, détails gardés', (code, kind) => {
    const error = ruleAppError(new ExecutionRuleError(code, { sessionIds: ['s1'] }));
    expect(error).toMatchObject({ code, kind, details: { sessionIds: ['s1'] } });
  });

  it('conflit d’écriture → CLEANING_CONCURRENT_UPDATE ; autre erreur inchangée', async () => {
    expect(executionError(new ConcurrentUpdateError())).toMatchObject({ code: 'CLEANING_CONCURRENT_UPDATE' });
    const other = new Error('autre');
    expect(executionError(other)).toBe(other);
    await expect(
      guarded(() => Promise.reject(new ExecutionRuleError('CLEANING_NOTHING_TO_PAY'))),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('périmètre du client', () => {
  const org = '0192f1c4-0000-7000-8000-0000000000aa';
  const as = <T>(
    activeContext: string,
    roles: { role: string; scopeType: 'org'; scopeId: string }[],
    fn: () => T,
  ) =>
    runWithContext(
      {
        correlationId: 't',
        callerService: 'gateway',
        user: { userId: 'u1', sessionId: 's', activeContext, roles, mfa: false },
      },
      fn,
    );

  it('contexte personnel : le titulaire a tous les droits', () => {
    const scope = as('personal', [], currentCustomer);
    expect(scope).toEqual({ userId: 'u1', ownerKind: 'user', ownerId: 'u1', role: null });
    expect(() => requireOrganizationRole(scope, 'org_admin')).not.toThrow();
    expect(inScope(scope, { ownerKind: 'user', ownerId: 'u1' })).toBe(true);
    expect(inScope(scope, { ownerKind: 'organization', ownerId: 'u1' })).toBe(false);
  });

  it('organisation : membre pour payer, administrateur pour arrêter, lecteur refusé', () => {
    const member = as(org, [{ role: 'org_member', scopeType: 'org', scopeId: org }], currentCustomer);
    expect(member).toMatchObject({ ownerKind: 'organization', ownerId: org, role: 'org_member' });
    expect(() => requireOrganizationRole(member, 'org_member')).not.toThrow();
    expect(() => requireOrganizationRole(member, 'org_admin')).toThrow(
      expect.objectContaining({ code: 'AUTH_FORBIDDEN' }),
    );
    const viewer = as(org, [], currentCustomer);
    expect(viewer.role).toBe('org_viewer');
    expect(() => requireOrganizationRole(viewer, 'org_member')).toThrow(
      expect.objectContaining({ code: 'AUTH_FORBIDDEN' }),
    );
  });
});
