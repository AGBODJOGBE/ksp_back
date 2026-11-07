import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { FILE_ID, type FileServer, startFileStub } from './support/file-stub';
import {
  type IdentityServer,
  ORIGINS,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à file (ADR-038) : utilisateur dans le contexte, métadonnées seules
 * (jamais de contenu), adresses présignées rendues telles quelles, limite de déclaration par
 * utilisateur.
 */
describe('gateway → file', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let file: FileServer;
  let app: NestExpressApplication;
  let limited: NestExpressApplication;
  let customer: string;

  const BODY = {
    purpose: 'cleaning_intervention_photo',
    fileName: 'salon-avant.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1843200,
  };

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    file = await startFileStub(keys);
    app = await startGateway({ identityUrl: identity.url, fileUrl: file.url, keys });
    limited = await startGateway({
      identityUrl: identity.url,
      fileUrl: file.url,
      keys,
      env: { RATE_LIMIT_FILE_UPLOAD_PER_MINUTE: '2' },
    });
    customer = await keys.accessToken();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await limited?.close();
    await identity?.close();
    await file?.close();
  });

  beforeEach(() => file.stub.reset());

  const authed = (req: request.Test) =>
    req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${customer}`);

  it('déclaration : corps transmis, utilisateur dans le contexte, adresse présignée rendue', async () => {
    const res = await authed(request(app.getHttpServer()).post('/api/v1/file/uploads')).send(BODY);
    expect(res.status).toBe(200);
    expect(file.stub.last('createUpload')?.request).toEqual(BODY);
    expect(file.stub.last('createUpload')?.context?.user?.userId).toBe(USER_ID);
    expect(res.body.file).toMatchObject({ id: FILE_ID, status: 'pending', subject: null, completedAt: null });
    expect(res.body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    expect(res.body.upload.url).toContain('X-Amz-Signature');
  });

  it('champ inconnu ou taille non entière : refus par la gateway, file n’est pas appelé', async () => {
    for (const body of [
      { ...BODY, ownerId: USER_ID },
      { ...BODY, sizeBytes: 1.5 },
      { ...BODY, purpose: 'x' },
    ]) {
      const res = await authed(request(app.getHttpServer()).post('/api/v1/file/uploads')).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
    }
    expect(file.stub.calls).toHaveLength(0);
  });

  it('confirmation, lecture et adresse de lecture : identifiant transmis', async () => {
    const server = request(app.getHttpServer());
    expect((await authed(server.post(`/api/v1/file/files/${FILE_ID}/complete`))).body.status).toBe(
      'available',
    );
    expect(file.stub.last('completeUpload')?.request).toEqual({ fileId: FILE_ID });
    expect((await authed(server.get(`/api/v1/file/files/${FILE_ID}`))).body.subject).toEqual({
      type: 'cleaning_intervention',
      id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000',
    });
    const link = await authed(server.get(`/api/v1/file/files/${FILE_ID}/download-url`));
    expect(link.body).toEqual({
      url: expect.stringContaining('X-Amz-Signature'),
      expiresAt: '2026-11-07T09:05:00.000Z',
    });
  });

  it('sans connexion : 401, file n’est pas appelé', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/file/uploads')
      .set('Origin', ORIGINS.web)
      .send(BODY);
    expect(res.status).toBe(401);
    expect(file.stub.calls).toHaveLength(0);
  });

  it('limite file_upload par utilisateur', async () => {
    const send = () => authed(request(limited.getHttpServer()).post('/api/v1/file/uploads')).send(BODY);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('GATEWAY_RATE_LIMITED');
  });
});
