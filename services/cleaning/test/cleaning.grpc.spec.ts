import { type AddressInfo, createServer } from 'node:net';
import { cleaningV1, commonV1 } from '@ksp/contracts';
import {
  AppError,
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
import { homeCleaning, testWorld, type TestWorld } from '../src/application/testing/fakes';
import { CLEANING_USE_CASES, createUseCases } from '../src/application/use-cases';
import { CleaningAdminGrpcController } from '../src/interfaces/grpc/admin.controller';
import {
  CatalogGrpcController,
  MissionGrpcController,
  ObligationGrpcController,
  QuoteGrpcController,
} from '../src/interfaces/grpc/customer.controllers';

/**
 * Bout en bout sur un vrai serveur gRPC (doublures en mémoire, sans base) : chargement des deux
 * paquets (cleaning et ksp.common.v1), traduction des messages, contexte utilisateur transmis
 * dans les métadonnées comme le fait la gateway, et traduction des erreurs.
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

const CUSTOMER = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
const SLOT = { start: '2026-12-30T08:00:00.000Z', end: '2026-12-30T11:00:00.000Z' };

describe('cleaning en gRPC', () => {
  let app: INestMicroservice;
  let world: TestWorld;
  let catalog: cleaningV1.CatalogServiceClient;
  let quotes: cleaningV1.QuoteServiceClient;
  let admin: cleaningV1.CleaningAdminServiceClient;
  let obligations: commonV1.ObligationServiceClient;
  const caller = new GrpcCaller({ target: 'cleaning' });

  beforeAll(async () => {
    world = testWorld();
    world.clock.current = new Date('2026-12-01T08:00:00Z');
    world.catalog.services.set('home_cleaning', homeCleaning());

    @Module({
      controllers: [
        CatalogGrpcController,
        QuoteGrpcController,
        MissionGrpcController,
        CleaningAdminGrpcController,
        ObligationGrpcController,
      ],
      providers: [{ provide: CLEANING_USE_CASES, useValue: createUseCases(world) }, GrpcContextInterceptor],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['cleaning', 'obligation'], port),
      logger: false,
    });
    app.useGlobalFilters(new GrpcExceptionFilter());
    app.useGlobalInterceptors(app.get(GrpcContextInterceptor));
    await app.listen();

    const url = `127.0.0.1:${port}`;
    const client = (pkg: 'cleaning' | 'obligation') =>
      ClientProxyFactory.create(grpcClientOptions('c', pkg, url) as never) as unknown as ClientGrpc;
    catalog = client('cleaning').getService(cleaningV1.CATALOG_SERVICE_NAME);
    quotes = client('cleaning').getService(cleaningV1.QUOTE_SERVICE_NAME);
    admin = client('cleaning').getService(cleaningV1.CLEANING_ADMIN_SERVICE_NAME);
    obligations = client('obligation').getService(commonV1.OBLIGATION_SERVICE_NAME);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Appel au nom d'un utilisateur : le contexte part dans les métadonnées (x-user-id, x-user-roles…). */
  const call = <T>(
    invoke: (metadata: Metadata) => Observable<T>,
    user?: { userId: string; roles: string[]; mfa?: boolean },
  ): Promise<T> =>
    runWithContext(
      {
        correlationId: '0192f1c4-0000-7000-8000-00000000c0de',
        ...(user
          ? {
              user: {
                userId: user.userId,
                sessionId: 's',
                activeContext: 'personal',
                roles: user.roles.map((role) => ({ role, scopeType: 'global' as const })),
                mfa: user.mfa ?? false,
                authTime: Math.floor(Date.now() / 1000),
              },
            }
          : {}),
      },
      () => caller.call('test', invoke),
    );
  const asCustomer = { userId: CUSTOMER, roles: ['customer'] };

  it('catalogue et simulateur publics, montants en entiers XOF', async () => {
    const { services } = await call((m) => catalog.listServices({}, m));
    expect(services[0]).toMatchObject({
      code: 'home_cleaning',
      priced: true,
      minimumPrice: { amount: 15000, currency: 'XOF' },
    });

    const simulation = await call((m) =>
      catalog.simulate(
        {
          serviceCode: 'home_cleaning',
          premisesType: 'house',
          quantity: 6,
          options: ['windows'],
          commune: 'Abomey-Calavi',
          frequency: 'once',
        },
        m,
      ),
    );
    expect(simulation).toMatchObject({
      covered: true,
      priced: true,
      estimate: { low: { amount: 33500, currency: 'XOF' }, high: { amount: 43000, currency: 'XOF' } },
      computedPrice: { amount: 37400, currency: 'XOF' },
      communeCoefficientBp: 11000,
    });
  });

  it('zones desservies publiques : actives seulement, code et nom, sans utilisateur', async () => {
    const calavi = world.catalog.zones.get('abomey-calavi')!;
    world.catalog.zones.set('abomey-calavi', { ...calavi, active: false });
    try {
      const { zones } = await call((m) => catalog.listServedZones({}, m));
      expect(zones).toEqual([
        { code: 'cotonou', commune: 'Cotonou' },
        { code: 'porto-novo', commune: 'Porto-Novo' },
      ]);
    } finally {
      world.catalog.zones.set('abomey-calavi', calavi);
    }
  });

  it('demande de devis au nom du client transmis par la gateway', async () => {
    const { request } = await call(
      (m) =>
        quotes.requestQuote(
          {
            idempotencyKey: 'grpc-1',
            serviceCode: 'home_cleaning',
            premisesType: 'house',
            quantity: 6,
            options: [],
            commune: 'Cotonou',
            address: 'Lot 12',
            preferredSlots: [SLOT],
            comment: '',
            requestedTeamSize: 0,
            daysPerWeek: 0,
          },
          m,
        ),
      asCustomer,
    );
    expect(request).toMatchObject({
      status: 'received',
      customerId: CUSTOMER,
      organizationId: '',
      missionId: '',
    });
    expect(request?.preferredSlots).toEqual([SLOT]);
    const { obligations: none } = await call((m) =>
      obligations.hasPendingObligations({ userId: CUSTOMER, organizationId: '' }, m),
    );
    expect(none).toEqual([]);
  });

  it('traduit les erreurs : non connecté, introuvable, droits du back-office', async () => {
    const reason = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: AppError) => [error.kind, error.code],
      );
    expect(await reason(call((m) => quotes.listMyRequests({}, m)))).toEqual([
      'UNAUTHENTICATED',
      'AUTH_REQUIRED',
    ]);
    expect(
      await reason(
        call((m) => quotes.getRequest({ requestId: '0192f1c4-0000-7000-8000-000000000999' }, m), asCustomer),
      ),
    ).toEqual(['NOT_FOUND', 'CLEANING_REQUEST_NOT_FOUND']);
    expect(await reason(call((m) => admin.getCatalog({}, m), asCustomer))).toEqual([
      'PERMISSION_DENIED',
      'AUTH_FORBIDDEN',
    ]);
    expect(
      await reason(
        call((m) => admin.getCatalog({}, m), { userId: CUSTOMER, roles: ['cleaning_admin'], mfa: false }),
      ),
    ).toEqual(['PERMISSION_DENIED', 'AUTH_MFA_REQUIRED']);
    const { services } = await call((m) => admin.getCatalog({}, m), {
      userId: CUSTOMER,
      roles: ['cleaning_admin'],
      mfa: true,
    });
    expect(services[0]?.pricing?.unitPrice).toEqual({ amount: 5000, currency: 'XOF' });
  });
});
