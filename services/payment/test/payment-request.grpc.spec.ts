import { type AddressInfo, createServer } from 'node:net';
import { paymentV1 } from '@ksp/contracts';
import {
  GrpcCaller,
  grpcClientOptions,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  runWithContext,
} from '@ksp/platform';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type ClientGrpc, ClientProxyFactory, type MicroserviceOptions } from '@nestjs/microservices';
import { type Metadata } from '@grpc/grpc-js';
import { type Observable } from 'rxjs';
import { CUSTOMER_ID, makeDeps, ORGANIZATION_ID } from '../src/application/testing/fakes';
import { createUseCases, PAYMENT_USE_CASES } from '../src/application/use-cases';
import { TopUpPaymentGrpcController } from '../src/interfaces/grpc/payment.controllers';

/**
 * TopUpPaymentService.CreatePaymentRequest sur un vrai serveur gRPC (doublures en mémoire, sans
 * base) : traduction de la demande (montant, objet visé) et de la réponse (target, checkout_url).
 * Sans vérificateur de jetons, l'appel est attribué au premier service autorisé (cleaning).
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const SESSION_ID = '0192f1c4-0000-7000-8000-0000000e0001';

describe('payment en gRPC : paiement direct d’un objet (CreatePaymentRequest, v2)', () => {
  let app: INestMicroservice;
  let topUps: paymentV1.TopUpPaymentServiceClient;
  const caller = new GrpcCaller({ target: 'payment' });

  beforeAll(async () => {
    const useCases = createUseCases(makeDeps());

    @Module({
      controllers: [TopUpPaymentGrpcController],
      providers: [{ provide: PAYMENT_USE_CASES, useValue: useCases }, GrpcContextInterceptor],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['payment'], port),
      logger: false,
    });
    app.useGlobalFilters(new GrpcExceptionFilter());
    app.useGlobalInterceptors(app.get(GrpcContextInterceptor));
    await app.listen();
    topUps = (
      ClientProxyFactory.create(
        grpcClientOptions('p', 'payment', `127.0.0.1:${port}`) as never,
      ) as unknown as ClientGrpc
    ).getService(paymentV1.TOP_UP_PAYMENT_SERVICE_NAME);
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = <T>(invoke: (metadata: Metadata) => Observable<T>): Promise<T> =>
    runWithContext({ correlationId: '0192f1c4-0000-7000-8000-00000000c0de' }, () =>
      caller.call('test', invoke),
    );

  const request = (overrides: Partial<paymentV1.CreatePaymentRequestRequest> = {}) => ({
    idempotencyKey: `cleaning_session:${SESSION_ID}:1`,
    customerId: CUSTOMER_ID,
    organizationId: ORGANIZATION_ID,
    amount: { amount: 12000, currency: 'XOF' },
    target: {
      service: '',
      objectType: 'cleaning_session',
      objectId: SESSION_ID,
      part: '',
      reference: 'séance 3/15',
    },
    description: 'Nettoyage — séance 3/15',
    expiresAt: '',
    ...overrides,
  });

  it('recharge du titulaire qui porte l’objet visé, page de paiement ; rejeu sans doublon', async () => {
    const first = await call((m) => topUps.createPaymentRequest(request(), m));
    expect(first).toMatchObject({
      created: true,
      payment: {
        status: 'pending',
        subject: { type: 'wallet_top_up', id: ORGANIZATION_ID, part: '', reference: '' },
        amount: { amount: 12000, currency: 'XOF' },
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        checkoutUrl: expect.stringContaining('https://'),
        target: {
          service: 'cleaning',
          objectType: 'cleaning_session',
          objectId: SESSION_ID,
          part: '',
          reference: 'séance 3/15',
        },
      },
    });
    const again = await call((m) => topUps.createPaymentRequest(request(), m));
    expect(again).toMatchObject({ created: false, payment: { id: first.payment!.id } });
  });

  it('demande invalide : PAYMENT_VALIDATION_FAILED', async () => {
    await expect(
      call((m) => topUps.createPaymentRequest(request({ description: '' }), m)),
    ).rejects.toMatchObject({ code: 'PAYMENT_VALIDATION_FAILED' });
  });
});
