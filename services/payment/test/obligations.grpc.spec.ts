import { type AddressInfo, createServer } from 'node:net';
import { commonV1 } from '@ksp/contracts';
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
import {
  asCustomer,
  CUSTOMER_ID,
  type InMemoryDues,
  makeDeps,
  MISSION_ID,
  missionDue,
} from '../src/application/testing/fakes';
import { createUseCases, PAYMENT_USE_CASES } from '../src/application/use-cases';
import { ObligationGrpcController } from '../src/interfaces/grpc/payment.controllers';

/**
 * ksp.common.v1.ObligationService sur un vrai serveur gRPC (doublures en mémoire, sans base) :
 * chargement du paquet commun à côté de celui de payment, traduction des messages et des erreurs.
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

describe('payment en gRPC : obligations avant la suppression d’un compte (ADR-036)', () => {
  let app: INestMicroservice;
  let obligations: commonV1.ObligationServiceClient;
  let useCases: ReturnType<typeof createUseCases>;
  const caller = new GrpcCaller({ target: 'payment' });

  beforeAll(async () => {
    const deps = makeDeps();
    (deps.dues as InMemoryDues).missions.set(MISSION_ID, missionDue());
    useCases = createUseCases(deps);

    @Module({
      controllers: [ObligationGrpcController],
      providers: [{ provide: PAYMENT_USE_CASES, useValue: useCases }, GrpcContextInterceptor],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['payment', 'obligation'], port),
      logger: false,
    });
    app.useGlobalFilters(new GrpcExceptionFilter());
    app.useGlobalInterceptors(app.get(GrpcContextInterceptor));
    await app.listen();
    obligations = (
      ClientProxyFactory.create(
        grpcClientOptions('o', 'obligation', `127.0.0.1:${port}`) as never,
      ) as unknown as ClientGrpc
    ).getService(commonV1.OBLIGATION_SERVICE_NAME);
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = <T>(invoke: (metadata: Metadata) => Observable<T>): Promise<T> =>
    runWithContext({ correlationId: '0192f1c4-0000-7000-8000-00000000c0de' }, () =>
      caller.call('test', invoke),
    );

  it('aucun paiement : rien ne bloque ; un paiement en attente bloque, avec sa référence', async () => {
    expect(
      await call((m) => obligations.hasPendingObligations({ userId: CUSTOMER_ID, organizationId: '' }, m)),
    ).toEqual({ hasPending: false, obligations: [] });

    const { payment } = await asCustomer(() =>
      useCases.createPayment.execute({
        subjectType: 'cleaning_mission',
        subjectId: MISSION_ID,
        part: 'deposit',
        idempotencyKey: 'pay-key-0001',
      }),
    );
    expect(
      await call((m) => obligations.hasPendingObligations({ userId: CUSTOMER_ID, organizationId: '' }, m)),
    ).toEqual({
      hasPending: true,
      obligations: [
        {
          kind: 'pending_payment',
          reference: payment.id,
          description: 'Un paiement de 15 000 FCFA est en attente de confirmation.',
        },
      ],
    });
  });

  it('identifiant mal formé : erreur traduite', async () => {
    await expect(
      call((m) => obligations.hasPendingObligations({ userId: 'x', organizationId: '' }, m)),
    ).rejects.toMatchObject({ code: 'PAYMENT_VALIDATION_FAILED' });
  });
});
