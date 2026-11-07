import { fileV1 } from '@ksp/contracts';
import {
  currentContext,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  type RequestContext,
  ServiceTokenVerifier,
} from '@ksp/platform';
import { Controller, Inject, type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions } from '@nestjs/microservices';
import { createLocalJWKSet } from 'jose';
import { freePort, type TestKeys, USER_ID } from './harness';

/**
 * Service file simulé pour les tests de la gateway : implémente FileService généré depuis
 * file.proto, vérifie le jeton de service comme le vrai service, et répond des messages complets.
 */
export const FILE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001';

export const protoFile: fileV1.StoredFile = {
  id: FILE_ID,
  purpose: 'cleaning_intervention_photo',
  fileName: 'salon-avant.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 1843200,
  status: 'pending',
  rejectionReason: '',
  ownerId: USER_ID,
  subject: undefined,
  createdAt: '2026-11-07T09:00:00.000Z',
  completedAt: '',
};

type Method = keyof fileV1.FileServiceController;

const DEFAULTS: Record<Method, () => unknown> = {
  createUpload: () => ({
    file: protoFile,
    upload: {
      url: `https://files.ksp.bj/ksp-files/cleaning_intervention_photo/${FILE_ID}?X-Amz-Signature=3f1c`,
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      expiresAt: '2026-11-07T09:15:00.000Z',
    },
  }),
  completeUpload: () => ({
    file: { ...protoFile, status: 'available', completedAt: '2026-11-07T09:00:12.000Z' },
  }),
  getMyFile: () => ({
    file: {
      ...protoFile,
      status: 'available',
      completedAt: '2026-11-07T09:00:12.000Z',
      subject: { type: 'cleaning_intervention', id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000' },
    },
  }),
  createMyDownloadUrl: () => ({
    download: {
      url: `https://files.ksp.bj/ksp-files/cleaning_intervention_photo/${FILE_ID}?X-Amz-Signature=9a0e`,
      expiresAt: '2026-11-07T09:05:00.000Z',
    },
  }),
};

export class FileStub {
  readonly calls: {
    method: Method;
    request: Record<string, unknown>;
    context: RequestContext | undefined;
  }[] = [];
  private readonly overrides = new Map<Method, (request: Record<string, unknown>) => Promise<unknown>>();

  on(method: Method, handler: (request: Record<string, unknown>) => Promise<unknown>): void {
    this.overrides.set(method, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  last(method: Method) {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async handle(method: Method, request: object): Promise<never> {
    this.calls.push({ method, request: { ...request }, context: currentContext() });
    const override = this.overrides.get(method);
    return (override ? await override({ ...request }) : DEFAULTS[method]()) as never;
  }
}

const STUB = Symbol('FILE_STUB');

@Controller()
class FileStubController {
  constructor(@Inject(STUB) readonly stub: FileStub) {}
}
for (const method of Object.keys(DEFAULTS) as Method[]) {
  Object.defineProperty(FileStubController.prototype, method, {
    value(this: FileStubController, request: object) {
      return this.stub.handle(method, request);
    },
  });
}
fileV1.FileServiceControllerMethods()(FileStubController);

export interface FileServer {
  stub: FileStub;
  url: string;
  close(): Promise<void>;
}

export async function startFileStub(keys: TestKeys): Promise<FileServer> {
  const stub = new FileStub();

  @Module({ controllers: [FileStubController], providers: [{ provide: STUB, useValue: stub }] })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['file'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'file',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
