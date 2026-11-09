import { documentV1 } from '@ksp/contracts';
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
 * Service document simulé pour les tests de la gateway : implémente DocumentService et
 * DocumentSigningService générés depuis document.proto, vérifie le jeton de service comme le vrai
 * service, et répond des messages complets.
 */
export const DOCUMENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001';
export const SIGNATURE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7201';
export const SIGNING_TOKEN = 'Zk3vQ0b4H1m0w2nY5p7r9t1v3x5z7B9D1F3H5J7L9Nq';

const signature: documentV1.SignatureRequest = {
  id: SIGNATURE_ID,
  documentId: DOCUMENT_ID,
  status: 'pending',
  signer: { userId: USER_ID, phoneMasked: '+229********45', displayName: 'Koffi Mensah' },
  createdAt: '2026-11-09T10:00:01.000Z',
  expiresAt: '2026-11-16T10:00:01.000Z',
  signedAt: '',
  codeExpiresAt: '',
};

export const protoDocument: documentV1.Document = {
  id: DOCUMENT_ID,
  template: 'recovery_mandate',
  templateVersion: 1,
  title: 'Mandat de recouvrement',
  number: 'MAN-2026-000042',
  status: 'pending_signature',
  subject: { type: 'recovery_case', id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7100' },
  ownerId: USER_ID,
  fileId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6101',
  sha256: 'a'.repeat(64),
  sizeBytes: 16188,
  signedFileId: '',
  signedSha256: '',
  createdAt: '2026-11-09T10:00:00.000Z',
  signedAt: '',
  cancelledAt: '',
  signature,
};

const download: documentV1.DownloadUrl = {
  url: `https://files.ksp.bj/ksp-files/generated_document/0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6101?X-Amz-Signature=7b2c`,
  expiresAt: '2026-11-09T10:05:00.000Z',
  version: 'original',
};

const delivery: documentV1.CodeDelivery = {
  channel: 'whatsapp',
  expiresAt: '2026-11-09T10:10:00.000Z',
  resendAfterSeconds: 60,
};

const session: documentV1.SigningSession = {
  documentTitle: 'Protocole d’accord et échéancier de paiement',
  documentNumber: 'PAC-2026-000007',
  status: 'pending',
  signer: { userId: '', phoneMasked: '+229********45', displayName: 'Koffi Mensah' },
  expiresAt: '2026-11-16T10:00:00.000Z',
  signedAt: '',
  codeExpiresAt: '',
  download,
};

type DocumentMethod = keyof documentV1.DocumentServiceController;
type SigningMethod = keyof documentV1.DocumentSigningServiceController;
type Method = DocumentMethod | SigningMethod;

const DOCUMENT_DEFAULTS: Record<DocumentMethod, () => unknown> = {
  getMyDocument: () => ({ document: protoDocument }),
  createMyDownloadUrl: () => ({ download }),
  sendSignatureCode: () => ({ delivery }),
  signDocument: () => ({
    document: {
      ...protoDocument,
      status: 'signed',
      signedFileId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6102',
      signedSha256: 'b'.repeat(64),
      signedAt: '2026-11-09T10:02:00.000Z',
      signature: { ...signature, status: 'signed', signedAt: '2026-11-09T10:02:00.000Z' },
    },
  }),
};

const SIGNING_DEFAULTS: Record<SigningMethod, () => unknown> = {
  getSigningSession: () => ({ session }),
  sendSigningCode: () => ({ delivery }),
  signWithLink: () => ({
    session: {
      ...session,
      status: 'signed',
      signedAt: '2026-11-09T10:02:00.000Z',
      download: { ...download, version: 'signed' },
    },
  }),
};

const DEFAULTS: Record<Method, () => unknown> = { ...DOCUMENT_DEFAULTS, ...SIGNING_DEFAULTS };

export class DocumentStub {
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

const STUB = Symbol('DOCUMENT_STUB');

@Controller()
class DocumentStubController {
  constructor(@Inject(STUB) readonly stub: DocumentStub) {}
}
@Controller()
class SigningStubController {
  constructor(@Inject(STUB) readonly stub: DocumentStub) {}
}
const bind = (target: { prototype: object }, methods: readonly Method[]) => {
  for (const method of methods) {
    Object.defineProperty(target.prototype, method, {
      value(this: { stub: DocumentStub }, request: object) {
        return this.stub.handle(method, request);
      },
    });
  }
};
bind(DocumentStubController, Object.keys(DOCUMENT_DEFAULTS) as DocumentMethod[]);
bind(SigningStubController, Object.keys(SIGNING_DEFAULTS) as SigningMethod[]);
documentV1.DocumentServiceControllerMethods()(DocumentStubController);
documentV1.DocumentSigningServiceControllerMethods()(SigningStubController);

export interface DocumentServer {
  stub: DocumentStub;
  url: string;
  close(): Promise<void>;
}

export async function startDocumentStub(keys: TestKeys): Promise<DocumentServer> {
  const stub = new DocumentStub();

  @Module({
    controllers: [DocumentStubController, SigningStubController],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['document'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'document',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
