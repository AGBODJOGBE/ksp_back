import { readFileSync } from 'node:fs';
import { type Metadata } from '@grpc/grpc-js';
import { resolve } from 'node:path';
import { recoveryV1 } from '@ksp/contracts';
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
import { parse } from 'yaml';
import { freePort, type TestKeys } from './harness';

/**
 * Service recovery simulé pour les tests de la gateway : implémente les quatre services de
 * recovery.proto et vérifie le jeton de service comme le vrai service. Chaque méthode répond par
 * défaut un exemple complet tiré du schéma de réponse du contrat OpenAPI, rangé dans le message
 * gRPC de recovery.proto (réponse entière ou un de ses champs) : la gateway doit le rendre conforme.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..', 'contracts');
const PROTO = readFileSync(resolve(ROOT, 'proto', 'ksp', 'recovery', 'v1', 'recovery.proto'), 'utf8');
type Json = Record<string, unknown>;
const contract = parse(readFileSync(resolve(ROOT, 'openapi', 'ksp-api.v1.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
};
const schemas = contract.components.schemas;

export const RECOVERY_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001';
export const DEBTOR_TOKEN = 'k3Jd9fQ2mZ7xB1vR8tY4wP6sN0cH5gL2aE9uI3oK7qT';

const camel = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const lowerFirst = (value: string) => value[0]!.toLowerCase() + value.slice(1);

/** Méthodes de chaque service et champs de chaque message, lus dans recovery.proto. */
const services = Object.fromEntries(
  [...PROTO.matchAll(/^service (\w+) \{([\s\S]*?)^\}/gm)].map((m) => [
    m[1]!,
    [...m[2]!.matchAll(/^\s*rpc (\w+)\(/gm)].map((rpc) => rpc[1]!),
  ]),
);
const messageFields = (name: string): Record<string, string> => {
  const body = new RegExp(`^message ${name} \\{\\r?\\n([\\s\\S]*?)^\\}`, 'm').exec(PROTO)?.[1] ?? '';
  return Object.fromEntries(
    [...body.matchAll(/^\s*(?:repeated\s+)?(map<[^>]+>|\S+)\s+(\w+)\s*=\s*\d+;/gm)].map((f) => [
      camel(f[2]!),
      f[1]!,
    ]),
  );
};

/** Exemple complet d'un schéma du contrat (toutes les propriétés, jamais null). */
function sample(raw: Json, name = ''): unknown {
  const ref = raw['$ref'] as string | undefined;
  if (ref) return sample(schemas[ref.split('/').pop()!]!, name);
  if (raw['oneOf'])
    return sample(
      (raw['oneOf'] as Json[]).find((o) => o['type'] !== 'null')!,
      name,
    );
  if ('const' in raw) return raw['const'];
  if (raw['enum']) return (raw['enum'] as unknown[]).find((v) => v !== null);
  const type = ([] as unknown[]).concat(raw['type']).find((t) => t !== 'null');
  if (type === 'object') {
    const props = (raw['properties'] ?? {}) as Record<string, Json>;
    return Object.fromEntries(Object.entries(props).map(([key, value]) => [key, sample(value, key)]));
  }
  if (type === 'array') return [sample(raw['items'] as Json, name)];
  if (type === 'integer') {
    const value = Math.max(Number(raw['minimum'] ?? 1), 1);
    return raw['maximum'] !== undefined ? Math.min(value, Number(raw['maximum'])) : value;
  }
  if (type === 'boolean') return true;
  const pattern = raw['pattern'] as string | undefined;
  if (raw['format'] === 'uuid') return RECOVERY_ID;
  if (raw['format'] === 'date') return '2026-12-15';
  if (raw['format'] === 'date-time') return '2026-12-15T09:00:00.000Z';
  if (raw['format'] === 'email') return 'contact@exemple.bj';
  if (raw['format'] === 'uri') return 'https://ksp.bj/recouvrement';
  if (pattern?.startsWith('^\\+')) return '+2290197000045';
  if (pattern?.startsWith('^RC-')) return 'RC-000123';
  if (pattern?.startsWith('^[0-9]{4}-')) return '2026-11';
  if (pattern?.includes('{43}')) return DEBTOR_TOKEN;
  if (pattern?.includes('[01][0-9]|2[0-3]')) return '08:00';
  return name ? `Exemple ${name}` : 'Exemple';
}

/** Les null deviennent des champs absents : valeurs par défaut du message gRPC. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== null)
        .map(([key, inner]) => [key, withoutNulls(inner)]),
    );
  }
  return value;
}

/** Réponse gRPC par défaut d'une méthode, construite depuis le contrat de sa route. */
function defaultResponse(service: string, rpc: string): Json {
  const grpc = `ksp.recovery.v1.${service}/${rpc}`;
  const op = Object.values(contract.paths)
    .flatMap((item) => Object.values(item))
    .find((candidate) => candidate['x-ksp-grpc'] === grpc);
  if (!op) throw new Error(`Aucune route du contrat pour ${grpc}`);
  const responses = op['responses'] as Record<string, Json>;
  const schemaRef = ((responses['200']!['content'] as Json)['application/json'] as Json)['schema'] as Json;
  const schemaName = (schemaRef['$ref'] as string).split('/').pop()!;
  const value = withoutNulls(sample(schemaRef)) as Json;
  const fields = messageFields(`${rpc}Response`);
  if (schemaName === 'RecoverySettingsView') {
    return {
      settings: {
        ...(value['settings'] as Json),
        updatedAt: value['updatedAt'],
        updatedBy: value['updatedBy'],
      },
    };
  }
  if (Object.keys(value).every((key) => key in fields)) return value;
  const [field, ...others] = Object.keys(fields).filter(
    (key) => fields[key] !== 'string' && fields[key] !== 'bool',
  );
  if (!field || others.length) throw new Error(`Réponse ${rpc} : champ à remplir introuvable`);
  return { [field]: value };
}

type Handler = (request: Json) => Promise<unknown>;

export class RecoveryStub {
  readonly calls: {
    method: string;
    request: Json;
    context: RequestContext | undefined;
    /** Session du débiteur reçue en métadonnée (ADR-061). */
    debtorSession: string | undefined;
  }[] = [];
  private readonly overrides = new Map<string, Handler>();
  private readonly defaults = new Map<string, Json>();

  constructor() {
    for (const [service, rpcs] of Object.entries(services)) {
      for (const rpc of rpcs) this.defaults.set(lowerFirst(rpc), defaultResponse(service, rpc));
    }
  }

  on(method: string, handler: Handler): void {
    this.overrides.set(method, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.calls.length = 0;
  }

  last(method: string) {
    return this.calls.filter((call) => call.method === method).at(-1);
  }

  async handle(method: string, request: object, metadata?: Metadata): Promise<never> {
    const session = metadata?.get('x-debtor-session')[0];
    this.calls.push({
      method,
      request: { ...request } as Json,
      context: currentContext(),
      debtorSession: typeof session === 'string' ? session : undefined,
    });
    const override = this.overrides.get(method);
    return (override ? await override({ ...request } as Json) : this.defaults.get(method)) as never;
  }
}

const STUB = Symbol('RECOVERY_STUB');

function stubController(service: string, decorate: () => ClassDecorator) {
  @Controller()
  class StubController {
    constructor(@Inject(STUB) readonly stub: RecoveryStub) {}
  }
  for (const rpc of services[service] ?? []) {
    const method = lowerFirst(rpc);
    Object.defineProperty(StubController.prototype, method, {
      value(this: StubController, request: object, metadata: Metadata) {
        return this.stub.handle(method, request, metadata);
      },
    });
  }
  decorate()(StubController);
  return StubController;
}

export interface RecoveryServer {
  stub: RecoveryStub;
  url: string;
  close(): Promise<void>;
}

export async function startRecoveryStub(keys: TestKeys): Promise<RecoveryServer> {
  const stub = new RecoveryStub();

  @Module({
    controllers: [
      stubController('RecoveryCreditorService', recoveryV1.RecoveryCreditorServiceControllerMethods),
      stubController('RecoveryDebtorService', recoveryV1.RecoveryDebtorServiceControllerMethods),
      stubController('RecoveryPartnerService', recoveryV1.RecoveryPartnerServiceControllerMethods),
      stubController('RecoveryAdminService', recoveryV1.RecoveryAdminServiceControllerMethods),
    ],
    providers: [{ provide: STUB, useValue: stub }],
  })
  class StubModule {}

  const port = await freePort();
  const app: INestMicroservice = await NestFactory.createMicroservice<MicroserviceOptions>(StubModule, {
    ...grpcServerOptions(['recovery'], port),
    logger: false,
  });
  app.useGlobalFilters(new GrpcExceptionFilter());
  app.useGlobalInterceptors(
    new GrpcContextInterceptor(
      new ServiceTokenVerifier({
        audience: 'recovery',
        issuer: 'ksp-identity',
        keys: createLocalJWKSet(keys.serviceJwks),
      }),
    ),
  );
  await app.listen();
  return { stub, url: `127.0.0.1:${port}`, close: () => app.close() };
}
