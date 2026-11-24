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
import { CLEANING_DEPS, type CleaningDeps } from '../src/application/deps';
import { LOT_C_USE_CASES, lotCUseCases } from '../src/application/requests/lot-c-use-cases';
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
 * (ksp.cleaning.v1, plus ksp.common.v1.ObligationService) est exposée (ADR-054).
 * - Lot A : CatalogService et CatalogAdminService répondent avec leurs cas d'usage (faux en mémoire).
 * - Lots C, D, E et G : les RPC livrées exigent une connexion ; appelées sans utilisateur, elles
 *   répondent AUTH_REQUIRED avant tout accès aux données.
 * - Piste S : ObligationService.HasPendingObligations répond avec son cas d'usage (réservée à identity).
 * - Toute autre RPC répond UNIMPLEMENTED avec le code CLEANING_NOT_IMPLEMENTED. Une méthode absente du
 *   serveur répondrait aussi UNIMPLEMENTED, mais sans ce code : le test la repère.
 */

/** RPC branchées par le lot D (UC-NT-19 à 21, 34 à 37). */
const LOT_D: Readonly<Record<string, readonly string[]>> = {
  AgentService: [
    'SubmitAgentApplication',
    'GetMyAgentProfile',
    'GetMyAvailability',
    'SetMyAvailability',
    'DeclareMyUnavailability',
    'RemoveMyUnavailability',
    'ListMyAssignments',
    'AcceptAssignment',
    'DeclineAssignment',
  ],
  AgentAdminService: [
    'ListAgents',
    'GetAgent',
    'UpdateAgent',
    'StartAgentReview',
    'ApproveAgent',
    'RejectAgent',
    'SuspendAgent',
    'ReactivateAgent',
    'DeactivateAgent',
    'GetAgentAvailability',
    'SetAgentAvailability',
    'DeclareAgentUnavailability',
    'RemoveAgentUnavailability',
    'ListTeams',
    'CreateTeam',
    'GetTeam',
    'UpdateTeam',
  ],
  PlanningAdminService: [
    'GetPlanning',
    'ListUnassigned',
    'CheckAssignment',
    'CreateAssignments',
    'UpdateAssignment',
    'RemoveAssignment',
  ],
};
/** RPC branchées par le lot C (UC-NT-03 à 10, 22, 30 à 33). */
const LOT_C: Readonly<Record<string, readonly string[]>> = {
  PlaceService: ['ListMyPlaces', 'CreatePlace', 'GetMyPlace', 'UpdatePlace', 'ArchivePlace', 'LocatePoint'],
  RequestService: [
    'SubmitRequest',
    'ListMyRequests',
    'GetMyRequest',
    'PayVisitFee',
    'ChangeVisitSlot',
    'CancelRequest',
    'RequestReactivation',
    'GetMyQuote',
    'AcceptQuote',
    'DeclineQuote',
    'ForwardQuote',
  ],
  RequestAdminService: [
    'ListRequests',
    'GetRequest',
    'RejectRequest',
    'CorrectRequestLocation',
    'DecideReactivation',
    'ListVisits',
    'ScheduleVisit',
    'UpdateVisit',
    'CancelVisit',
    'RequestNewVisit',
    'CompleteVisitOnBehalf',
    'ReportVisitMissedOnBehalf',
    'RemoveVisitPhotoAsKsp',
    'SaveRetainedValues',
    'EstimateRetainedValues',
    'CreateQuote',
    'GetQuote',
    'UpdateQuoteDraft',
    'ApproveQuoteAdjustment',
    'SendQuote',
  ],
  AgentService: [
    'GetAgentVisit',
    'ArriveAtVisit',
    'SaveVisitObservations',
    'AddVisitPhoto',
    'CompleteVisit',
    'ReportVisitMissed',
    'RemoveVisitPhoto',
  ],
};
/**
 * RPC branchées par le lot E (UC-NT-11 à 14, 16, 23, 24, 46). GetWalletDebitStatus, réservée à
 * wallet, est testée à part (pas de compte connecté).
 */
const LOT_E: Readonly<Record<string, readonly string[]>> = {
  ProgramService: [
    'ListMyPrograms',
    'GetMyProgram',
    'ListMyProgramSessions',
    'GetMySession',
    'RescheduleSession',
    'CancelSession',
    'StopProgram',
    'PaySession',
    'RateSession',
  ],
  AgentService: [
    'GetMyActivity',
    'GetAgentSession',
    'ArriveAtSession',
    'StartSession',
    'UpdateSessionChecklist',
    'AddSessionPhoto',
    'ReportSessionIncident',
    'CompleteSession',
    'ReportSessionMissed',
    'RemoveSessionPhoto',
  ],
  ProgramAdminService: [
    'ListPrograms',
    'GetProgram',
    'ListProgramSessions',
    'GetSession',
    'SuspendProgram',
    'ResumeProgram',
    'CancelProgram',
    'ApproveProgramCancellation',
    'RescheduleSessionAsKsp',
    'CancelSessionAsKsp',
    'ResumeSession',
    'CompleteSessionAsKsp',
    'ReportSessionMissedAsKsp',
    'RemoveSessionPhotoAsKsp',
  ],
};
const SERVICE_ONLY = [['WalletDebitCheckService', 'GetWalletDebitStatus']];
/** RPC branchées par le lot G (UC-NT-17, 18, 38, 40, 43, 45). */
const LOT_G: Readonly<Record<string, readonly string[]>> = {
  PlanningAdminService: ['RunAutoPlanning', 'ListProposals', 'ApproveProposals'],
  SettingsAdminService: ['GetSettings', 'UpdateSettings'],
  ProgramService: ['OpenClaim', 'ListMyClaims', 'GetMyClaim', 'AddClaimMessage'],
  ClaimAdminService: ['ListClaims', 'GetClaim', 'UpdateClaim', 'DecideClaim', 'ApproveClaimCredit'],
};
/**
 * RPC branchée par la piste S (suppression d'un compte) : HasPendingObligations, réservée à identity,
 * est testée à part (pas de compte connecté).
 */
const PISTE_S: Readonly<Record<string, readonly string[]>> = {
  ObligationService: ['HasPendingObligations'],
};
const inLot = (lot: Readonly<Record<string, readonly string[]>>, service: string, rpc: string) =>
  lot[service]?.includes(rpc) ?? false;
const delivered = (service: string, rpc: string) =>
  [LOT_D, LOT_C, LOT_E, LOT_G].some((lot) => inLot(lot, service, rpc));
const serviceOnly = (service: string, rpc: string) =>
  SERVICE_ONLY.some(([s, r]) => s === service && r === rpc) || inLot(PISTE_S, service, rpc);

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
const DELIVERED = RPCS.filter(([, service, rpc]) => delivered(service, rpc));
const NOT_IMPLEMENTED = RPCS.filter(
  ([, service, rpc]) =>
    !LOT_A_SERVICES.includes(service) && !delivered(service, rpc) && !serviceOnly(service, rpc),
);
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
        // Dépendances vides : une RPC du lot D appelée sans utilisateur s'arrête au contrôle d'accès.
        { provide: CLEANING_DEPS, useValue: {} },
        // Lot C : cas d'usage sur des dépendances vides, arrêtés eux aussi au contrôle d'accès.
        { provide: LOT_C_USE_CASES, useValue: lotCUseCases({} as CleaningDeps) },
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

  it('les RPC du lot D sont toutes dans le contrat', () => {
    const all = new Set(RPCS.map(([, service, rpc]) => `${service}.${rpc}`));
    for (const [service, rpcs] of Object.entries(LOT_D)) {
      for (const rpc of rpcs) expect(all).toContain(`${service}.${rpc}`);
    }
    expect(DELIVERED.filter(([, service, rpc]) => LOT_D[service]?.includes(rpc))).toHaveLength(32);
  });

  it('les RPC du lot C sont toutes dans le contrat', () => {
    const all = new Set(RPCS.map(([, service, rpc]) => `${service}.${rpc}`));
    for (const [service, rpcs] of Object.entries(LOT_C)) {
      for (const rpc of rpcs) expect(all).toContain(`${service}.${rpc}`);
    }
    expect(DELIVERED).toHaveLength(32 + 44 + 33 + 14);
  });

  it('les RPC du lot E sont toutes dans le contrat', () => {
    const all = new Set(RPCS.map(([, service, rpc]) => `${service}.${rpc}`));
    for (const [service, rpcs] of Object.entries(LOT_E)) {
      for (const rpc of rpcs) expect(all).toContain(`${service}.${rpc}`);
    }
  });

  it('WalletDebitCheckService.GetWalletDebitStatus est branchée (lot E, réservée à wallet)', async () => {
    expect(
      await anonymous(() =>
        call('cleaning', 'WalletDebitCheckService', 'GetWalletDebitStatus', { objectType: 'autre' }),
      ),
    ).toMatchObject({ recorded: false, status: 'not_recorded' });
  });

  it('les RPC du lot G sont toutes dans le contrat', () => {
    const all = new Set(RPCS.map(([, service, rpc]) => `${service}.${rpc}`));
    const lotG = Object.entries(LOT_G).flatMap(([service, rpcs]) => rpcs.map((rpc) => `${service}.${rpc}`));
    for (const rpc of lotG) expect(all).toContain(rpc);
    expect(RPCS.filter(([, service, rpc]) => inLot(LOT_G, service, rpc))).toHaveLength(lotG.length);
  });

  it('ObligationService.HasPendingObligations est branchée (piste S, réservée à identity)', async () => {
    expect(RPCS.filter(([, service, rpc]) => inLot(PISTE_S, service, rpc))).toEqual([
      ['obligation', 'ObligationService', 'HasPendingObligations'],
    ]);
    // Identifiant refusé avant toute lecture : la méthode répond, sans CLEANING_NOT_IMPLEMENTED.
    expect(
      await anonymous(() =>
        call('obligation', 'ObligationService', 'HasPendingObligations', { userId: 'x' }),
      ),
    ).toMatchObject({
      kind: 'INVALID_ARGUMENT',
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'userId', reason: 'invalid_type' },
    });
  });

  it.each(DELIVERED)('%s : %s.%s est branchée et exige une connexion', async (pkg, service, rpc) => {
    expect(await anonymous(() => call(pkg, service, rpc, {}))).toMatchObject({
      kind: 'UNAUTHENTICATED',
      code: 'AUTH_REQUIRED',
    });
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
