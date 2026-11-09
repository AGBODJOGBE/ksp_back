import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  DOCUMENT_ID,
  type DocumentServer,
  SIGNATURE_ID,
  SIGNING_TOKEN,
  startDocumentStub,
} from './support/document-stub';
import {
  type IdentityServer,
  ORIGINS,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à document (ADR-044) : utilisateur et client (IP, navigateur) dans le
 * contexte pour la preuve, code et consentement validés, jeton du lien vérifié sur sa forme, routes
 * publiques limitées par adresse IP, aucun identifiant de fichier rendu.
 */
describe('gateway → document', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let documents: DocumentServer;
  let app: NestExpressApplication;
  let limited: NestExpressApplication;
  let customer: string;
  let stranger: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    documents = await startDocumentStub(keys);
    app = await startGateway({ identityUrl: identity.url, documentUrl: documents.url, keys });
    limited = await startGateway({
      identityUrl: identity.url,
      documentUrl: documents.url,
      keys,
      env: { RATE_LIMIT_DOCUMENT_LINK_CODE_REQUEST_PER_MINUTE: '2' },
    });
    customer = await keys.accessToken();
    stranger = await keys.accessToken({ subject: '0192f1c4-7a2b-7c3d-8e4f-0000000000ff' });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await limited?.close();
    await identity?.close();
    await documents?.close();
  });

  beforeEach(() => documents.stub.reset());

  const authed = (req: request.Test, bearer = customer) =>
    req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${bearer}`);

  it('document : utilisateur transmis, signataire connecté repéré, aucun identifiant de fichier', async () => {
    const res = await authed(request(app.getHttpServer()).get(`/api/v1/document/documents/${DOCUMENT_ID}`));
    expect(res.status).toBe(200);
    expect(documents.stub.last('getMyDocument')?.request).toEqual({ documentId: DOCUMENT_ID });
    expect(documents.stub.last('getMyDocument')?.context?.user?.userId).toBe(USER_ID);
    expect(res.body).toMatchObject({
      number: 'MAN-2026-000042',
      signedSha256: null,
      signature: {
        id: SIGNATURE_ID,
        canSign: true,
        signer: { hasAccount: true, phoneMasked: '+229********45' },
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/fileId|0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6101"/);

    const other = await authed(
      request(app.getHttpServer()).get(`/api/v1/document/documents/${DOCUMENT_ID}`),
      stranger,
    );
    expect(other.body.signature.canSign).toBe(false);
  });

  it('signature connectée : code et consentement transmis, IP et navigateur pour la preuve', async () => {
    const res = await authed(
      request(app.getHttpServer()).post(`/api/v1/document/signatures/${SIGNATURE_ID}/sign`),
    )
      .set('X-Forwarded-For', '197.234.10.20')
      .set('User-Agent', 'Mozilla/5.0 (Android 14)')
      .send({ code: '482913', consent: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed');
    const call = documents.stub.last('signDocument')!;
    expect(call.request).toEqual({ signatureRequestId: SIGNATURE_ID, code: '482913', consent: true });
    expect(call.context?.client?.userAgent).toBe('Mozilla/5.0 (Android 14)');
    expect(call.context?.client?.ip).toBeDefined();
  });

  it('corps refusé par la gateway : document n’est pas appelé', async () => {
    for (const body of [
      { code: '4829', consent: true },
      { code: '482913' },
      { code: '482913', consent: true, x: 1 },
    ]) {
      const res = await authed(
        request(app.getHttpServer()).post(`/api/v1/document/signatures/${SIGNATURE_ID}/sign`),
      ).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
    }
    expect(documents.stub.calls).toHaveLength(0);
  });

  it('lien sans compte : route publique, jeton transmis, jeton mal formé introuvable sans appel', async () => {
    const session = await request(app.getHttpServer()).get(`/api/v1/document/sign/${SIGNING_TOKEN}`);
    expect(session.status).toBe(200);
    expect(documents.stub.last('getSigningSession')?.request).toEqual({ token: SIGNING_TOKEN });
    expect(documents.stub.last('getSigningSession')?.context?.user).toBeUndefined();
    expect(session.body).toMatchObject({
      documentNumber: 'PAC-2026-000007',
      download: { version: 'original' },
    });

    const signed = await request(app.getHttpServer())
      .post(`/api/v1/document/sign/${SIGNING_TOKEN}/sign`)
      .send({ code: '482913', consent: true });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ status: 'signed', download: { version: 'signed' } });

    documents.stub.reset();
    const bad = await request(app.getHttpServer()).get('/api/v1/document/sign/abc$');
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('DOCUMENT_SIGNATURE_NOT_FOUND');
    expect(documents.stub.calls).toHaveLength(0);
  });

  it('codes par lien : limités par adresse IP', async () => {
    const send = () =>
      request(limited.getHttpServer())
        .post(`/api/v1/document/sign/${SIGNING_TOKEN}/otp`)
        .set('X-Forwarded-For', '198.51.100.77');
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const third = await send();
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
