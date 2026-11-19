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
import { CLEANING_GRPC_CONTROLLERS } from '../src/interfaces/grpc/controllers';

/**
 * Squelette v2 (ADR-054) sur un vrai serveur gRPC : chaque RPC des services lus dans les .proto
 * (ksp.cleaning.v1, plus ksp.common.v1.ObligationService) est exposée et répond UNIMPLEMENTED avec
 * le code CLEANING_NOT_IMPLEMENTED. Une méthode absente du serveur répondrait aussi UNIMPLEMENTED,
 * mais sans ce code : le test la repère.
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

const RPCS = [...rpcsOf('cleaning'), ...rpcsOf('obligation')];
const camel = (name: string) => name[0]!.toLowerCase() + name.slice(1);

describe('cleaning en gRPC : squelette v2', () => {
  let app: INestMicroservice;
  const clients = new Map<PackageName, ClientGrpc>();
  const caller = new GrpcCaller({ target: 'cleaning' });

  beforeAll(async () => {
    @Module({ controllers: CLEANING_GRPC_CONTROLLERS, providers: [GrpcContextInterceptor] })
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

  it.each(RPCS)('%s : %s.%s répond UNIMPLEMENTED', async (pkg, service, rpc) => {
    const client = clients
      .get(pkg)!
      .getService<Record<string, (request: object, metadata: Metadata) => Observable<unknown>>>(service);
    const failure = await runWithContext({ correlationId: '0192f1c4-0000-7000-8000-00000000c0de' }, () =>
      caller.call(rpc, (metadata) => client[camel(rpc)]!({}, metadata)),
    ).catch((error: AppError) => error);
    expect(failure).toMatchObject({
      kind: 'NOT_IMPLEMENTED',
      code: 'CLEANING_NOT_IMPLEMENTED',
      message: `La méthode ${rpc} n'est pas encore disponible.`,
    });
  });
});
