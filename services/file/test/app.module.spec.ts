import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule, createStorage } from '../src/app.module';
import { configSchema, dailyBytesPerOwner } from '../src/config';
import { FileGrpcController, FileInternalGrpcController } from '../src/interfaces/grpc/file.controllers';

const BASE = {
  SERVICE_NAME: 'file',
  NODE_ENV: 'test',
  GRPC_PORT: '50056',
  HTTP_PORT: '3106',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  RABBITMQ_URL: 'amqp://localhost',
  FILE_STORAGE_ACCESS_KEY: 'ksp',
  FILE_STORAGE_SECRET_KEY: 'ksp-local-secret',
};

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, { ...BASE, FILE_PURGE_INTERVAL_MS: '0' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(FileGrpcController)).toBeDefined();
    expect(moduleRef.get(FileInternalGrpcController)).toBeDefined();
    await moduleRef.close();
  });
});

describe('configuration de file', () => {
  it('valeurs par défaut : MinIO local, adresses courtes, purge des envois après 24 heures', () => {
    const config = loadConfig(configSchema, BASE);
    expect(config.FILE_STORAGE_ENDPOINT).toBe('http://localhost:9000');
    expect(config.FILE_STORAGE_BUCKET).toBe('ksp-files');
    expect(config.FILE_STORAGE_FORCE_PATH_STYLE).toBe(true);
    expect(config.FILE_UPLOAD_URL_TTL_SECONDS).toBe(900);
    expect(config.FILE_DOWNLOAD_URL_TTL_SECONDS).toBe(300);
    expect(config.FILE_PENDING_TTL_MINUTES).toBe(1440);
    expect(dailyBytesPerOwner(config)).toBe(500 * 1024 * 1024);
  });

  it('les clés du stockage sont obligatoires', () => {
    expect(() => loadConfig(configSchema, { ...BASE, FILE_STORAGE_SECRET_KEY: '' })).toThrow(
      /FILE_STORAGE_SECRET_KEY/,
    );
  });

  it('un envoi en cours n’est jamais purgé : délai d’attente plus long que l’adresse d’envoi', () => {
    expect(() =>
      loadConfig(configSchema, {
        ...BASE,
        FILE_PENDING_TTL_MINUTES: '30',
        FILE_UPLOAD_URL_TTL_SECONDS: '3600',
      }),
    ).toThrow(/FILE_PENDING_TTL_MINUTES/);
  });

  it('production : stockage en HTTPS, création du bucket interdite', () => {
    const production = (env: Record<string, string> = {}) =>
      loadConfig(configSchema, {
        ...BASE,
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
        ...env,
      });
    expect(() => production()).toThrow(/FILE_STORAGE_PUBLIC_ENDPOINT/);
    expect(() =>
      production({
        FILE_STORAGE_PUBLIC_ENDPOINT: 'https://files.ksp.bj',
        FILE_STORAGE_CREATE_BUCKET: 'true',
      }),
    ).toThrow(/FILE_STORAGE_CREATE_BUCKET/);
    expect(production({ FILE_STORAGE_PUBLIC_ENDPOINT: 'https://files.ksp.bj' }).NODE_ENV).toBe('production');
  });

  it('les adresses présignées portent l’adresse publique, signée avec type et taille', async () => {
    const config = loadConfig(configSchema, {
      ...BASE,
      FILE_STORAGE_ENDPOINT: 'http://minio:9000',
      FILE_STORAGE_PUBLIC_ENDPOINT: 'https://files.ksp.bj',
    });
    const storage = createStorage(config);
    const upload = await storage.presignUpload('avatar/0192f1c4-0000-7000-8000-000000000001', {
      contentType: 'image/png',
      sizeBytes: 1234,
      expiresInSeconds: 900,
    });
    const url = new URL(upload.url);
    expect(url.origin).toBe('https://files.ksp.bj');
    expect(url.pathname).toBe('/ksp-files/avatar/0192f1c4-0000-7000-8000-000000000001');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    // Aucune somme de contrôle imposée : inconnue de certains stockages compatibles.
    expect([...url.searchParams.keys()].some((key) => key.toLowerCase().includes('checksum'))).toBe(false);
    expect(upload.headers).toEqual({ 'Content-Type': 'image/png' });

    const download = new URL(
      await storage.presignDownload('avatar/0192f1c4-0000-7000-8000-000000000001', {
        fileName: 'Photo d’été.png',
        contentType: 'image/png',
        expiresInSeconds: 300,
      }),
    );
    expect(download.origin).toBe('https://files.ksp.bj');
    expect(download.searchParams.get('response-content-type')).toBe('image/png');
    expect(download.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="Photo d__t_.png"; filename*=UTF-8\'\'Photo%20d%E2%80%99%C3%A9t%C3%A9.png',
    );
    storage.destroy();
  });
});
