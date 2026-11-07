import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  ACCOUNT_ID,
  type IdentityServer,
  ORIGINS,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à identity pour l'administration des comptes (ADR-043) : utilisateur
 * dans le contexte, champs absents en valeurs par défaut, énumérations converties, valeurs vides en
 * null ; refus avant tout appel hors des rôles du manifeste.
 */
describe('gateway → identity : administration des comptes', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let app: NestExpressApplication;
  let director: string;
  let cleaningHead: string;
  let supervisor: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    app = await startGateway({ identityUrl: identity.url, keys });
    const staff = (role: string) =>
      keys.accessToken({
        claims: { client_id: 'backoffice', mfa: true, roles: [{ role, scopeType: 'global' }] },
      });
    director = await staff('super_admin');
    cleaningHead = await staff('cleaning_admin');
    supervisor = await staff('cleaning_supervisor');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await identity?.close();
  });

  beforeEach(() => identity.stub.reset());

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${token}`);
  const base = '/api/v1/admin/identity/accounts';

  it('recherche : corps vide accepté, valeurs par défaut transmises, curseur vide → null', async () => {
    const res = await as(http().post(`${base}/search`), cleaningHead).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        expect.objectContaining({
          userId: ACCOUNT_ID,
          status: 'active',
          phone: '+2290197000045',
          suspendedAt: null,
          roles: ['cleaning_agent'],
        }),
      ],
      nextCursor: null,
    });
    const call = identity.stub.last('searchAccounts')!;
    expect(call.request).toEqual({ query: '', limit: 0, cursor: '' });
    expect(call.context?.user).toMatchObject({ userId: USER_ID });
  });

  it('fiche : portée convertie, valeurs vides en null', async () => {
    const res = await as(http().get(`${base}/${ACCOUNT_ID}`), director);
    expect(res.status).toBe(200);
    expect(res.body.roles[0]).toMatchObject({ scopeType: 'domain', scopeId: 'cleaning', revokedAt: null });
    expect(res.body.roles[1]).toMatchObject({ scopeType: 'global', scopeId: null, grantedBy: null });
    expect(res.body.mfa).toEqual({
      configured: true,
      configuredAt: '2026-10-20T08:00:00.000Z',
      recoveryCodesRemaining: 9,
    });
  });

  it('attribution et retrait : identifiants et motif transmis tels quels', async () => {
    await as(http().post(`${base}/${ACCOUNT_ID}/roles`), cleaningHead)
      .send({ roleCode: 'cleaning_agent', reason: 'Renfort' })
      .expect(200);
    expect(identity.stub.last('grantAccountRole')!.request).toEqual({
      userId: ACCOUNT_ID,
      roleCode: 'cleaning_agent',
      reason: 'Renfort',
    });
    const assignmentId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0b01';
    await as(http().post(`${base}/${ACCOUNT_ID}/roles/revoke`), cleaningHead)
      .send({ assignmentId, reason: 'Départ' })
      .expect(200);
    expect(identity.stub.last('revokeAccountRole')!.request).toEqual({
      userId: ACCOUNT_ID,
      assignmentId,
      reason: 'Départ',
    });
  });

  it('suspension, réactivation, réinitialisation : réservées à super_admin dès la gateway', async () => {
    const suspended = await as(http().post(`${base}/${ACCOUNT_ID}/suspend`), director).send({
      reason: 'Fraude',
    });
    expect(suspended.body.account).toMatchObject({ status: 'suspended', suspensionReason: 'Fraude' });
    for (const action of ['suspend', 'reactivate', 'mfa/reset']) {
      const res = await as(http().post(`${base}/${ACCOUNT_ID}/${action}`), cleaningHead).send({
        reason: 'x',
      });
      expect(res.status).toBe(403);
    }
    expect(identity.stub.calls.map((call) => call.method)).toEqual(['suspendAccount']);
  });

  it('un rôle hors du manifeste est refusé avant tout appel', async () => {
    const res = await as(http().get('/api/v1/admin/identity/roles'), supervisor);
    expect(res.status).toBe(403);
    expect(identity.stub.calls).toEqual([]);
  });
});
