import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { type CleaningServer, IDS, startCleaningStub } from './support/cleaning-stub';
import {
  type IdentityServer,
  ORIGINS,
  protoUser,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à cleaning : utilisateur et rôles dans le contexte, clé
 * d'idempotence, montants convertis en { amount, currency }, profil vérifié avant une demande.
 */
describe('gateway → cleaning', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let cleaning: CleaningServer;
  let app: NestExpressApplication;
  let customer: string;
  let staff: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    cleaning = await startCleaningStub(keys);
    app = await startGateway({ identityUrl: identity.url, cleaningUrl: cleaning.url, keys });
    customer = await keys.accessToken();
    staff = await keys.accessToken({
      claims: {
        client_id: 'backoffice',
        mfa: true,
        roles: [{ role: 'cleaning_supervisor', scopeType: 'global' }],
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await identity?.close();
    await cleaning?.close();
  });

  beforeEach(() => {
    identity.stub.reset();
    cleaning.stub.reset();
    identity.stub.on('getMe', async () => ({ user: protoUser, profileIncomplete: false }));
  });

  const http = () => request(app.getHttpServer());
  const QUOTE_BODY = {
    serviceCode: 'home_cleaning',
    premisesType: 'house',
    quantity: 6,
    commune: 'Cotonou',
    address: 'Lot 12',
    preferredSlots: [{ start: '2026-11-05T08:00:00Z', end: '2026-11-05T11:00:00Z' }],
  };

  it('demande de devis : profil vérifié, clé d’idempotence et utilisateur transmis', async () => {
    const res = await http()
      .post('/api/v1/cleaning/quote-requests')
      .set('Origin', ORIGINS.web)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'demande-0001')
      .send(QUOTE_BODY);
    expect(res.status).toBe(200);
    expect(identity.stub.last('getMe')).toBeDefined();
    const call = cleaning.stub.last('requestQuote')!;
    expect(call.request).toMatchObject({
      idempotencyKey: 'demande-0001',
      options: [],
      comment: '',
      requestedTeamSize: 0,
    });
    expect(call.context?.user?.userId).toBe(USER_ID);
    expect(call.context?.callerService).toBe('gateway');
  });

  it('profil incomplet : rien n’est transmis à cleaning', async () => {
    identity.stub.on('getMe', async () => ({ user: protoUser, profileIncomplete: true }));
    const res = await http()
      .post('/api/v1/cleaning/quote-requests')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'demande-0002')
      .send(QUOTE_BODY);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDENTITY_PROFILE_INCOMPLETE');
    expect(cleaning.stub.last('requestQuote')).toBeUndefined();
  });

  it('simulateur public : aucun jeton, aucun utilisateur transmis', async () => {
    const res = await http()
      .post('/api/v1/cleaning/simulations')
      .send({ serviceCode: 'home_cleaning', premisesType: 'house', quantity: 6, commune: 'Cotonou' });
    expect(res.status).toBe(200);
    expect(res.body.estimate.low).toEqual({ amount: 33500, currency: 'XOF' });
    expect(cleaning.stub.last('simulate')!.context?.user).toBeUndefined();
  });

  it('devis : montant de chaque ligne calculé, rôles transmis', async () => {
    const res = await http()
      .post(`/api/v1/admin/cleaning/quote-requests/${IDS.request}/quote`)
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`)
      .send({
        lines: [{ label: 'Bureaux', quantity: 200, unitPrice: 250 }],
        proposedSlots: [{ start: '2026-11-05T08:00:00Z', end: '2026-11-05T11:00:00Z' }],
        durationMinutes: 180,
      });
    expect(res.status).toBe(200);
    const call = cleaning.stub.last('sendQuote')!;
    expect(call.request['lines']).toEqual([
      {
        label: 'Bureaux',
        quantity: 200,
        unitPrice: { amount: 250, currency: 'XOF' },
        amount: { amount: 50000, currency: 'XOF' },
      },
    ]);
    expect(call.context?.user?.roles).toEqual([
      expect.objectContaining({ role: 'cleaning_supervisor', scopeType: 'global' }),
    ]);
    expect(call.context?.user?.mfa).toBe(true);
  });

  it('pagination : curseur suivant transmis tel quel, absent → null', async () => {
    const res = await http()
      .get('/api/v1/cleaning/missions?limit=5')
      .set('Authorization', `Bearer ${customer}`);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe(IDS.mission);
    expect(cleaning.stub.last('listMyMissions')!.request['page']).toEqual({ limit: 5, cursor: '' });
    const bad = await http()
      .get('/api/v1/cleaning/missions?limit=500')
      .set('Authorization', `Bearer ${customer}`);
    expect(bad.status).toBe(400);
  });
});
