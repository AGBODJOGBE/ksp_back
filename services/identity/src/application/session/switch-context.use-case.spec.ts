import { AppError } from '@ksp/platform';
import { type Organization } from '../../domain/organization/organization';
import { InMemoryOrganizations, InMemorySessionStore } from '../testing/fakes';
import { AccessTokenIssuer, type AccessTokenSubject } from '../token/access-token-issuer';
import { type Account } from './session.ports';
import { SwitchContextUseCase } from './switch-context.use-case';

const USER = '0192f1c4-0000-7000-8000-00000000c001';
const SESSION = '0192f1c4-0000-7000-8000-000000005e01';
const ORG = '0192f1c4-0000-7000-8000-0000000000a1';

function setup(status: Organization['status'] = 'active') {
  const now = new Date('2026-10-27T10:00:00Z');
  const sessions = new InMemorySessionStore();
  const account: Account = {
    id: USER,
    status: 'active',
    firstName: 'Koffi',
    lastName: 'Adjovi',
    phoneE164: '+2290197000045',
    email: null,
    emailVerifiedAt: null,
    preferredLanguage: 'fr',
    createdAt: now,
  };
  sessions.accounts.set(USER, account);
  sessions.sessions.push({
    id: SESSION,
    userId: USER,
    clientKind: 'web',
    createdAt: new Date('2026-10-20T08:00:00Z'),
    lastSeenAt: now,
    expiresAt: new Date('2026-11-20T08:00:00Z'),
    revokedAt: null,
  });
  const organizations = new InMemoryOrganizations();
  organizations.rows.push({
    id: ORG,
    legalName: 'SARL Bénin Propre',
    address: 'Haie Vive, Cotonou',
    ifu: '3201912345678',
    rccm: null,
    billingEmail: null,
    status,
    createdBy: USER,
    createdAt: now,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    suspendedAt: null,
    suspensionReason: null,
  });
  organizations.memberRows.push({
    organizationId: ORG,
    userId: USER,
    role: 'org_admin',
    joinedAt: now,
    removedAt: null,
  });

  const issued: AccessTokenSubject[] = [];
  const accessTokens = new AccessTokenIssuer(
    { sign: async () => 'jwt', publicKeys: () => [] },
    { next: () => '0192f1c4-0000-7000-8000-00000000j001' },
    { now: () => now },
    900,
  );
  const issue = accessTokens.issue.bind(accessTokens);
  accessTokens.issue = async (subject) => {
    issued.push(subject);
    return issue(subject);
  };
  const useCase = new SwitchContextUseCase(sessions, organizations, accessTokens, { now: () => now });
  return { useCase, sessions, organizations, issued };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('SwitchContextUseCase (UC-ID-15)', () => {
  it('active une organisation validée : jeton ctx = organisation, rôle du membre, session mise à jour', async () => {
    const { useCase, sessions, issued } = setup();
    const switched = await useCase.execute({ userId: USER, sessionId: SESSION, organizationId: ORG });
    expect(switched.activeContext).toEqual({
      type: 'business',
      organizationId: ORG,
      organizationName: 'SARL Bénin Propre',
    });
    expect(issued[0]).toMatchObject({
      activeContext: ORG,
      clientId: 'web',
      mfa: false,
      amr: ['otp'],
      authTime: new Date('2026-10-20T08:00:00Z'),
      roles: [
        { role: 'customer', scopeType: 'personal' },
        { role: 'org_admin', scopeType: 'org', scopeId: ORG },
      ],
    });
    expect(sessions.sessions[0].activeOrgId).toBe(ORG);
  });

  it('retour au contexte personnel', async () => {
    const { useCase, sessions, issued } = setup();
    await useCase.execute({ userId: USER, sessionId: SESSION, organizationId: ORG });
    const back = await useCase.execute({ userId: USER, sessionId: SESSION, organizationId: null });
    expect(back.activeContext).toEqual({ type: 'individual', organizationId: null, organizationName: null });
    expect(issued[1]).toMatchObject({
      activeContext: 'personal',
      roles: [{ role: 'customer', scopeType: 'personal' }],
    });
    expect(sessions.sessions[0].activeOrgId).toBeNull();
  });

  it.each(['pending_review', 'rejected', 'suspended'] as const)(
    'organisation %s : refusée comme contexte actif',
    async (status) => {
      const { useCase, sessions } = setup(status);
      const error = await expectAppError(
        useCase.execute({ userId: USER, sessionId: SESSION, organizationId: ORG }),
        'IDENTITY_ORGANIZATION_NOT_ACTIVE',
      );
      expect(error.details).toEqual({ status });
      expect(sessions.sessions[0].activeOrgId).toBeUndefined();
    },
  );

  it('organisation inconnue ou dont l’utilisateur n’est pas membre : introuvable', async () => {
    const { useCase, organizations } = setup();
    await expectAppError(
      useCase.execute({
        userId: USER,
        sessionId: SESSION,
        organizationId: '0192f1c4-0000-7000-8000-0000000000ff',
      }),
      'IDENTITY_ORGANIZATION_NOT_FOUND',
    );
    organizations.memberRows[0].removedAt = new Date();
    await expectAppError(
      useCase.execute({ userId: USER, sessionId: SESSION, organizationId: ORG }),
      'IDENTITY_ORGANIZATION_NOT_FOUND',
    );
  });

  it('session fermée, d’un autre compte ou du back-office : refus', async () => {
    const { useCase, sessions } = setup();
    await expectAppError(
      useCase.execute({
        userId: '0192f1c4-0000-7000-8000-00000000c002',
        sessionId: SESSION,
        organizationId: ORG,
      }),
      'IDENTITY_SESSION_REVOKED',
    );
    sessions.sessions[0].clientKind = 'backoffice';
    await expectAppError(
      useCase.execute({ userId: USER, sessionId: SESSION, organizationId: ORG }),
      'IDENTITY_CONTEXT_FORBIDDEN',
    );
    sessions.sessions[0].revokedAt = new Date();
    await expectAppError(
      useCase.execute({ userId: USER, sessionId: SESSION, organizationId: null }),
      'IDENTITY_SESSION_REVOKED',
    );
  });
});
