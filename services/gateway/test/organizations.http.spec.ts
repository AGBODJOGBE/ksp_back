import { identityV1 } from '@ksp/contracts';
import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  type IdentityServer,
  ORGANIZATION_ID,
  ORIGINS,
  SESSION_ID,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à identity pour les comptes entreprise (ADR-027) : utilisateur et
 * session dans le contexte, valeurs absentes en chaînes vides, état converti en énumération ;
 * vue du client sans les comptes du back-office ; refus avant tout appel sans rôle ou sans
 * double authentification.
 */
describe('gateway → identity : comptes entreprise', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let app: NestExpressApplication;
  let customer: string;
  let director: string;
  let support: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    app = await startGateway({ identityUrl: identity.url, keys });
    customer = await keys.accessToken();
    const staff = (role: string) =>
      keys.accessToken({
        claims: { client_id: 'backoffice', mfa: true, roles: [{ role, scopeType: 'global' }] },
      });
    director = await staff('super_admin');
    support = await staff('support_agent');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await identity?.close();
  });

  beforeEach(() => identity.stub.reset());

  const http = () => request(app.getHttpServer());
  const web = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${token}`);
  const backoffice = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${token}`);

  it('changement de contexte : session du jeton transmise, null ramène au contexte personnel', async () => {
    const res = await web(http().post('/api/v1/identity/context'), customer).send({
      organizationId: ORGANIZATION_ID,
    });
    expect(res.status).toBe(200);
    expect(res.body.activeContext).toEqual({
      type: 'business',
      organizationId: ORGANIZATION_ID,
      organizationName: 'SARL Bénin Propre',
    });
    const call = identity.stub.last('switchContext')!;
    expect(call.request).toEqual({ organizationId: ORGANIZATION_ID });
    expect(call.context?.user).toMatchObject({ userId: USER_ID, sessionId: SESSION_ID });

    const back = await web(http().post('/api/v1/identity/context'), customer).send({ organizationId: null });
    expect(back.body.activeContext).toEqual({
      type: 'individual',
      organizationId: null,
      organizationName: null,
    });
    expect(identity.stub.last('switchContext')!.request).toEqual({ organizationId: '' });
  });

  it('création : RCCM absent transmis vide ; vue du client sans les comptes du back-office', async () => {
    const res = await web(http().post('/api/v1/identity/organizations'), customer).send({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 1234, Haie Vive, Cotonou',
      ifu: '3201912345678',
    });
    expect(res.status).toBe(200);
    expect(identity.stub.last('createOrganization')!.request).toEqual({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 1234, Haie Vive, Cotonou',
      ifu: '3201912345678',
      rccm: '',
    });
    expect(res.body).toMatchObject({
      role: 'org_admin',
      pendingBillingEmail: null,
      organization: { status: 'pending_review', rccm: null, billingEmail: null, reviewedAt: null },
    });
    expect(res.body.organization).not.toHaveProperty('createdBy');
    expect(res.body.organization).not.toHaveProperty('reviewedBy');
  });

  it('e-mail de facturation : organisation du chemin et adresse transmises', async () => {
    const res = await web(
      http().put(`/api/v1/identity/organizations/${ORGANIZATION_ID}/billing-email`),
      customer,
    ).send({ email: 'Compta@BeninPropre.bj' });
    expect(res.status).toBe(200);
    expect(identity.stub.last('changeOrganizationBillingEmail')!.request).toEqual({
      organizationId: ORGANIZATION_ID,
      email: 'Compta@BeninPropre.bj',
    });
  });

  it('back-office : filtre d’état converti, consultation ouverte au support, décision avec motif', async () => {
    const list = await backoffice(
      http().get('/api/v1/admin/identity/organizations?status=pending_review&limit=5'),
      support,
    );
    expect(list.status).toBe(200);
    expect(identity.stub.last('listOrganizations')!.request).toEqual({
      status: identityV1.OrganizationStatus.ORGANIZATION_STATUS_PENDING_REVIEW,
      limit: 5,
      cursor: '',
    });
    expect(list.body).toMatchObject({
      nextCursor: ORGANIZATION_ID,
      data: [{ createdBy: USER_ID, suspendedAt: null }],
    });

    const rejected = await backoffice(
      http().post(`/api/v1/admin/identity/organizations/${ORGANIZATION_ID}/reject`),
      director,
    ).send({ reason: 'IFU introuvable au registre de la DGI.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'IFU introuvable au registre de la DGI.',
    });
    expect(identity.stub.last('rejectOrganization')!.request).toEqual({
      organizationId: ORGANIZATION_ID,
      reason: 'IFU introuvable au registre de la DGI.',
    });
  });

  it('refus avant tout appel : décision par le support, client sur le back-office, état inconnu', async () => {
    const validate = `/api/v1/admin/identity/organizations/${ORGANIZATION_ID}/validate`;
    expect((await backoffice(http().post(validate), support)).status).toBe(403);
    expect((await backoffice(http().get('/api/v1/admin/identity/organizations'), customer)).status).toBe(403);
    const unknown = await backoffice(
      http().get('/api/v1/admin/identity/organizations?status=closed'),
      director,
    );
    expect(unknown.status).toBe(400);
    expect(identity.stub.calls).toEqual([]);
  });
});
