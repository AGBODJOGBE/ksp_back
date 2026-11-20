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
import { CLEANING_DEPS } from '../src/application/deps';
import { CLEANING_GRPC_CONTROLLERS } from '../src/interfaces/grpc/controllers';

/**
 * Squelette v2 (ADR-054) sur un vrai serveur gRPC : chaque RPC des services lus dans les .proto
 * (ksp.cleaning.v1, plus ksp.common.v1.ObligationService) est exposée. Les RPC livrées (lot D)
 * exigent une connexion : appelées sans utilisateur, elles répondent AUTH_REQUIRED avant tout accès
 * aux données. Les autres répondent UNIMPLEMENTED avec le code CLEANING_NOT_IMPLEMENTED ; une
 * méthode absente du serveur répondrait aussi UNIMPLEMENTED, mais sans ce code : le test la repère.
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
const delivered = (service: string, rpc: string) => LOT_D[service]?.includes(rpc) ?? false;

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

const RPCS = [...rpcsOf('cleaning'), ...rpcsOf('obligation')];
const PENDING = RPCS.filter(([, service, rpc]) => !delivered(service, rpc));
const DELIVERED = RPCS.filter(([, service, rpc]) => delivered(service, rpc));
const camel = (name: string) => name[0]!.toLowerCase() + name.slice(1);

describe('cleaning en gRPC : squelette v2', () => {
  let app: INestMicroservice;
  const clients = new Map<PackageName, ClientGrpc>();
  const caller = new GrpcCaller({ target: 'cleaning' });

  beforeAll(async () => {
    // Dépendances vides : une RPC livrée appelée sans utilisateur s'arrête au contrôle d'accès.
    @Module({
      controllers: CLEANING_GRPC_CONTROLLERS,
      providers: [GrpcContextInterceptor, { provide: CLEANING_DEPS, useValue: {} }],
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
  });

  const call = (pkg: PackageName, service: string, rpc: string) => {
    const client = clients
      .get(pkg)!
      .getService<Record<string, (request: object, metadata: Metadata) => Observable<unknown>>>(service);
    return runWithContext({ correlationId: '0192f1c4-0000-7000-8000-00000000c0de' }, () =>
      caller.call(rpc, (metadata) => client[camel(rpc)]!({}, metadata)),
    ).catch((error: AppError) => error);
  };

  it('les RPC du lot D sont toutes dans le contrat', () => {
    const all = new Set(RPCS.map(([, service, rpc]) => `${service}.${rpc}`));
    for (const [service, rpcs] of Object.entries(LOT_D)) {
      for (const rpc of rpcs) expect(all).toContain(`${service}.${rpc}`);
    }
    expect(DELIVERED).toHaveLength(32);
  });

  it.each(DELIVERED)('%s : %s.%s est branchée et exige une connexion', async (pkg, service, rpc) => {
    expect(await call(pkg, service, rpc)).toMatchObject({ kind: 'UNAUTHENTICATED', code: 'AUTH_REQUIRED' });
  });

  it.each(PENDING)('%s : %s.%s répond UNIMPLEMENTED', async (pkg, service, rpc) => {
    expect(await call(pkg, service, rpc)).toMatchObject({
      kind: 'NOT_IMPLEMENTED',
      code: 'CLEANING_NOT_IMPLEMENTED',
      message: `La méthode ${rpc} n'est pas encore disponible.`,
    });
  });
});
