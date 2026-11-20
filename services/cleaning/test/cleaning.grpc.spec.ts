import { readFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { GRPC_PACKAGES, protoPath } from '@ksp/contracts';
import {
  type AppError,
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
import { CATALOG_USE_CASES, catalogUseCases } from '../src/application/catalog/catalog-use-cases';
import { TariffsUseCases } from '../src/application/catalog/tariffs.use-cases';
import { asStaff, CatalogMemory } from '../src/application/testing/catalog-fakes';
import {
  type MaisonCatalog,
  seedMaison,
  SOL_TARIFF,
  VITRES_TARIFF,
} from '../src/application/testing/catalog-fixtures';
import { CLEANING_GRPC_CONTROLLERS } from '../src/interfaces/grpc/controllers';

/**
 * Service cleaning sur un vrai serveur gRPC. Chaque RPC des services lus dans les .proto
 * (ksp.cleaning.v1, plus ksp.common.v1.ObligationService) est exposée. Lot A branché (ADR-054) :
 * CatalogService et CatalogAdminService répondent avec leurs cas d'usage (faux en mémoire ici) ;
 * toute autre RPC répond UNIMPLEMENTED avec le code CLEANING_NOT_IMPLEMENTED. Une méthode absente du
 * serveur répondrait aussi UNIMPLEMENTED, mais sans ce code : le test la repère.
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

type PackageName = 'cleaning' | 'obligation';

/** Services et RPC déclarés dans le fichier .proto d'un paquet, dans l'ordre du fichier. */
function rpcsOf(pkg: PackageName): Array<[PackageName, string, string]> {
  const source = readFileSync(protoPath(GRPC_PACKAGES[pkg].file), 'utf8');
  return [...source.matchAll(/^service (\w+) \{([\s\S]*?)^\}/gm)].flatMap(([, service, body]) =>
    [...body!.matchAll(/^\s+rpc (\w+)\(/gm)].map(
      ([, rpc]) => [pkg, service!, rpc!] as [PackageName, string, string],
    ),
  );
}

/** Services branchés par le lot A (UC-NT-01, 02, 25 à 29). */
const LOT_A_SERVICES = ['CatalogService', 'CatalogAdminService'];
const RPCS = [...rpcsOf('cleaning'), ...rpcsOf('obligation')];
const LOT_A = RPCS.filter(([, service]) => LOT_A_SERVICES.includes(service));
const NOT_IMPLEMENTED = RPCS.filter(([, service]) => !LOT_A_SERVICES.includes(service));
const camel = (name: string) => name[0]!.toLowerCase() + name.slice(1);

const VILLA = {
  superficie: { number: 120 },
  chambres: { number: 5 },
  cour: { flag: true },
  arriere_cour: { flag: false },
  fenetres: { number: 12 },
};
const WEEKLY_12 = {
  kind: 'weekly',
  startTime: '08:00',
  dates: [],
  weekdays: ['mon'],
  monthDays: [],
  monthWeekdays: [],
  startDate: '2027-01-04',
  durationWeeks: 12,
  excludedDates: [],
  addedDates: [],
};

describe('cleaning en gRPC', () => {
  let app: INestMicroservice;
  let catalog: MaisonCatalog;
  const memory = new CatalogMemory();
  const clients = new Map<PackageName, ClientGrpc>();
  const caller = new GrpcCaller({ target: 'cleaning' });

  /** Appel gRPC réel ; erreur rendue telle que le client la reçoit. */
  const call = <T>(pkg: PackageName, service: string, rpc: string, request: object): Promise<T> => {
    const client = clients
      .get(pkg)!
      .getService<Record<string, (request: object, metadata: Metadata) => Observable<unknown>>>(service);
    return caller.call(rpc, (metadata) => client[camel(rpc)]!(request, metadata)) as Promise<T>;
  };
  const anonymous = <T>(fn: () => Promise<T>) =>
    runWithContext({ correlationId: '0192f1c4-0000-7000-8000-00000000c0de' }, fn).catch(
      (error: AppError) => error,
    );
  const staff = <T>(fn: () => Promise<T>) => asStaff(fn).catch((error: AppError) => error);

  beforeAll(async () => {
    catalog = seedMaison(memory);
    const tariffs = new TariffsUseCases(memory.deps());
    for (const [offerId, tariff, key] of [
      [catalog.solOfferId, SOL_TARIFF, 'cle-sol-0001'],
      [catalog.vitresOfferId, VITRES_TARIFF, 'cle-vitres-01'],
    ] as const) {
      await asStaff(() => tariffs.createDraft({ ...tariff, offerId, idempotencyKey: key }));
      await asStaff(() => tariffs.publish({ offerId, version: 1, idempotencyKey: `${key}-p` }));
    }

    @Module({
      controllers: CLEANING_GRPC_CONTROLLERS,
      providers: [
        GrpcContextInterceptor,
        { provide: CATALOG_USE_CASES, useValue: catalogUseCases(memory.deps()) },
      ],
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
    for (const pkg of ['cleaning', 'obligation'] as const) {
      clients.set(
        pkg,
        ClientProxyFactory.create(
          grpcClientOptions(pkg, pkg, `127.0.0.1:${port}`) as never,
        ) as unknown as ClientGrpc,
      );
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('un contrôleur par service des contrats', () => {
    const services = new Set(RPCS.map(([, service]) => service));
    expect(services.size).toBe(14);
    expect(CLEANING_GRPC_CONTROLLERS).toHaveLength(services.size);
    expect(LOT_A).toHaveLength(41);
  });

  it.each(NOT_IMPLEMENTED)('%s : %s.%s répond UNIMPLEMENTED', async (pkg, service, rpc) => {
    const failure = await anonymous(() => call(pkg, service, rpc, {}));
    expect(failure).toMatchObject({
      kind: 'NOT_IMPLEMENTED',
      code: 'CLEANING_NOT_IMPLEMENTED',
      message: `La méthode ${rpc} n'est pas encore disponible.`,
    });
  });

  it.each(LOT_A)('%s : %s.%s est branchée (lot A)', async (pkg, service, rpc) => {
    const outcome = await staff(() => call(pkg, service, rpc, {}));
    expect(outcome).not.toMatchObject({ code: 'CLEANING_NOT_IMPLEMENTED' });
  });

  describe('CatalogService (public)', () => {
    it('Simulate : exemple de la partie 5 au franc près', async () => {
      const response = await anonymous(() =>
        call<{ simulation: { pricing: Record<string, unknown>; covered: boolean; disclaimer: string } }>(
          'cleaning',
          'CatalogService',
          'Simulate',
          {
            placeTypeId: catalog.placeTypeId,
            cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
            values: VILLA,
            schedule: WEEKLY_12,
            communeKey: 'cotonou',
          },
        ),
      );
      expect(response).toMatchObject({
        simulation: {
          covered: true,
          disclaimer: 'Estimation non contractuelle, confirmée après la visite des lieux',
          pricing: {
            status: 'priced',
            sessionPrice: { amount: 32_040, currency: 'XOF' },
            sessionsCount: 12,
            programTotal: { amount: 384_480 },
            range: { low: { amount: 28_500 }, high: { amount: 37_000 } },
            frequencyDiscount: { amount: 3560 },
            visitFee: { amount: 5000 },
            offers: [
              { cleaningTypeCode: 'sol', price: { amount: 26_640 }, tariffStatus: 'published' },
              { cleaningTypeCode: 'vitres', price: { amount: 5400 } },
            ],
          },
        },
      });
    });

    it('catalogue, détail d’un lieu, zones desservies, aperçu des dates', async () => {
      await expect(
        anonymous(() => call('cleaning', 'CatalogService', 'ListCatalog', {})),
      ).resolves.toMatchObject({
        categories: [{ code: 'maison', placeTypes: [{ code: 'villa', freeDescription: false }] }],
      });
      await expect(
        anonymous(() =>
          call('cleaning', 'CatalogService', 'GetCatalogPlaceType', { placeTypeId: catalog.placeTypeId }),
        ),
      ).resolves.toMatchObject({
        publicPlaceTypeDetail: {
          categoryId: catalog.categoryId,
          offers: [
            { cleaningType: { code: 'sol' } },
            { cleaningType: { code: 'vitres' }, extraParameters: [{ code: 'fenetres' }] },
          ],
          visitFee: { amount: 5000 },
        },
      });
      await expect(
        anonymous(() => call('cleaning', 'CatalogService', 'ListServedZones', {})),
      ).resolves.toEqual({
        zones: [{ communeKey: 'cotonou', name: 'Cotonou' }],
      });
      await expect(
        anonymous(() => call('cleaning', 'CatalogService', 'PreviewSchedule', { schedule: WEEKLY_12 })),
      ).resolves.toMatchObject({ schedulePreview: { count: 12, firstStart: '2027-01-04T07:00:00.000Z' } });
    });

    it('erreurs du contrat : lieu inconnu, valeur hors bornes', async () => {
      await expect(
        anonymous(() => call('cleaning', 'CatalogService', 'GetCatalogPlaceType', { placeTypeId: 'x' })),
      ).resolves.toMatchObject({ kind: 'NOT_FOUND', code: 'CLEANING_PLACE_TYPE_NOT_FOUND' });
      await expect(
        anonymous(() =>
          call('cleaning', 'CatalogService', 'Simulate', {
            placeTypeId: catalog.placeTypeId,
            cleaningTypeIds: [catalog.solTypeId],
            values: { ...VILLA, superficie: { number: 6000 } },
          }),
        ),
      ).resolves.toMatchObject({
        kind: 'INVALID_ARGUMENT',
        code: 'CLEANING_VALIDATION_FAILED',
        details: { field: 'values.superficie', reason: 'out_of_range' },
      });
    });
  });

  describe('CatalogAdminService (back-office)', () => {
    it('personnel connecté exigé', async () => {
      await expect(
        anonymous(() => call('cleaning', 'CatalogAdminService', 'ListZones', {})),
      ).resolves.toMatchObject({
        kind: 'UNAUTHENTICATED',
        code: 'AUTH_REQUIRED',
      });
    });

    it('catégorie créée (idempotente), relue avec le nom de son auteur', async () => {
      const request = {
        idempotencyKey: 'cle-grpc-0001',
        code: 'bureaux',
        name: 'Bureaux',
        visitFee: { amount: 7000, currency: 'XOF' },
      };
      const created = await staff(() =>
        call<{ placeCategory: { id: string } }>(
          'cleaning',
          'CatalogAdminService',
          'CreatePlaceCategory',
          request,
        ),
      );
      expect(created).toMatchObject({
        placeCategory: {
          code: 'bureaux',
          active: true,
          visitFee: { amount: 7000 },
          updatedByName: 'Nom ad01',
        },
      });
      const again = await staff(() =>
        call('cleaning', 'CatalogAdminService', 'CreatePlaceCategory', request),
      );
      expect(again).toEqual(created);
      const id = (created as { placeCategory: { id: string } }).placeCategory.id;
      await expect(
        staff(() => call('cleaning', 'CatalogAdminService', 'GetPlaceCategory', { id })),
      ).resolves.toEqual(created);
    });

    it('tarifs : liste des versions, brouillon, simulateur de test', async () => {
      await expect(
        staff(() => call('cleaning', 'CatalogAdminService', 'ListTariffs', { offerId: catalog.solOfferId })),
      ).resolves.toMatchObject({
        total: 1,
        items: [
          { version: 1, status: 'published', baseParameterCode: 'superficie', minimum: { amount: 10_000 } },
        ],
      });
      const draft = await staff(() =>
        call<{ tariff: { id: string } }>('cleaning', 'CatalogAdminService', 'CreateTariffDraft', {
          offerId: catalog.solOfferId,
          idempotencyKey: 'cle-grpc-0002',
          brackets: [{ from: 0, to: 400, mode: 'flat', amount: { amount: 20_000, currency: 'XOF' } }],
          supplements: [],
          minimum: { amount: 10_000, currency: 'XOF' },
          frequencyCoefficients: [],
        }),
      );
      expect(draft).toMatchObject({
        tariff: { version: 2, status: 'draft', baseParameterCode: 'superficie' },
      });
      const simulation = await staff(() =>
        call('cleaning', 'CatalogAdminService', 'SimulateWithDrafts', {
          placeTypeId: catalog.placeTypeId,
          cleaningTypeIds: [catalog.solTypeId],
          values: { superficie: VILLA.superficie, chambres: VILLA.chambres },
          draftTariffIds: [(draft as { tariff: { id: string } }).tariff.id],
        }),
      );
      expect(simulation).toMatchObject({
        simulation: {
          usesDrafts: true,
          pricing: { sessionPrice: { amount: 20_000 }, offers: [{ tariffStatus: 'draft' }] },
        },
      });
    });

    it('communes du référentiel et zones', async () => {
      await expect(
        staff(() => call('cleaning', 'CatalogAdminService', 'ListCommunes', {})),
      ).resolves.toMatchObject({
        communes: expect.arrayContaining([
          expect.objectContaining({
            communeKey: 'cotonou',
            name: 'Cotonou',
            zoneId: 'zone-cotonou',
            zoneActive: true,
          }),
        ]),
      });
      await expect(
        staff(() => call('cleaning', 'CatalogAdminService', 'ListZones', {})),
      ).resolves.toMatchObject({
        items: [{ communeKey: 'cotonou', coefficientBps: 10_000, openRequests: 0 }],
        nextCursor: '',
        total: 1,
      });
    });
  });
});
