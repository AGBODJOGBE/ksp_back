import { cleaningV1 } from '@ksp/contracts';
import {
  AppError,
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
import { CLEANING_BINDINGS } from '../../src/infrastructure/grpc/cleaning-bindings';
import { freePort, type TestKeys } from './harness';

/**
 * Service cleaning v2 simulé pour les tests de la gateway : implémente, pour chaque service de
 * ksp.cleaning.v1 appelé par une route, les méthodes du contrat (contrôleurs générés depuis
 * cleaning.proto), vérifie le jeton de service comme le vrai service, et répond UNIMPLEMENTED
 * (CLEANING_NOT_IMPLEMENTED) tant qu'un test ne fixe pas la réponse.
 */
const DECORATORS: Record<string, () => ClassDecorator> = {
  CatalogService: cleaningV1.CatalogServiceControllerMethods,
  PlaceService: cleaningV1.PlaceServiceControllerMethods,
  RequestService: cleaningV1.RequestServiceControllerMethods,
  ProgramService: cleaningV1.ProgramServiceControllerMethods,
  AgentService: cleaningV1.AgentServiceControllerMethods,
  CatalogAdminService: cleaningV1.CatalogAdminServiceControllerMethods,
  RequestAdminService: cleaningV1.RequestAdminServiceControllerMethods,
  AgentAdminService: cleaningV1.AgentAdminServiceControllerMethods,
  PlanningAdminService: cleaningV1.PlanningAdminServiceControllerMethods,
  ProgramAdminService: cleaningV1.ProgramAdminServiceControllerMethods,
  ClaimAdminService: cleaningV1.ClaimAdminServiceControllerMethods,
  SettingsAdminService: cleaningV1.SettingsAdminServiceControllerMethods,
};

export const NOT_IMPLEMENTED = 'CLEANING_NOT_IMPLEMENTED';

export interface CleaningStubCall {
  service: string;
  method: string;
  request: Record<string, unknown>;
  context: RequestContext | undefined;
}

type Handler = (request: Record<string, unknown>) => Promise<unknown>;

export class CleaningStub {
  readonly calls: CleaningStubCall[] = [];
  private readonly overrides = new Map<string, Handler>();

  /** Réponse d'une méthode (nom du client gRPC : createPlace…) jusqu'à reset(). */
  on(method: string, handler: Handler): void {
    this.overrides.set(method, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  last(method: string): CleaningStubCall | undefined {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async handle(service: string, method: string, request: object): Promise<never> {
    this.calls.push({ service, method, request: { ...request }, context: currentContext() });
    const override = this.overrides.get(method);
    if (override) return (await override({ ...request })) as never;
    throw new AppError('NOT_IMPLEMENTED', NOT_IMPLEMENTED, `${service}/${method} : pas encore livré.`);
  }
}

const STUB = Symbol('CLEANING_STUB');

/** Méthodes de chaque service, d'après les appels déclarés par les routes du Nettoyage. */
function methodsByService(): Map<string, Set<string>> {
  const services = new Map<string, Set<string>>();
  for (const { service, method } of Object.values(CLEANING_BINDINGS)) {
    services.set(service, (services.get(service) ?? new Set()).add(method));
  }
  return services;
}

/** Contrôleur d'un service : chaque méthode du contrat délègue au service simulé. */
function stubController(service: string, methods: Iterable<string>) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: CleaningStub) {}
  }
  for (const method of methods) {
    Object.defineProperty(StubController.prototype, method, {
      value(this: StubController, request: object) {
        return this.stub.handle(service, method, request);
      },
      writable: true,
      configurable: true,
    });
  }
  // Les décorateurs générés lisent les méthodes du prototype : on les applique après les avoir posées.
  // Une méthode du service sans route ferait échouer ce décorateur : toutes sont exposées en REST.
  DECORATORS[service]!()(StubController);
  return StubController;
}

export interface CleaningServer {
  stub: CleaningStub;
  url: string;
  close(): Promise<void>;
}

export async function startCleaningStub(keys: TestKeys): Promise<CleaningServer> {
  const stub = new CleaningStub();
  const controllers = [...methodsByService()].map(([service, methods]) => stubController(service, methods));

  @Module({ controllers, providers: [{ provide: STUB, useValue: stub }] })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['cleaning'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'cleaning',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
