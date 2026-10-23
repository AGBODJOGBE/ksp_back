import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError, HealthController } from '@ksp/platform';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { type NestExpressApplication } from '@nestjs/platform-express';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_RATE_LIMITS } from '../src/domain/rate-limit/rate-limits';
import { ROUTE_MANIFEST, type RouteDefinition } from '../src/domain/routing/route-manifest';
import { RESERVED_PREFIXES } from '../src/domain/routing/manifest-rules';
import { IdentityHttpController } from '../src/interfaces/http/identity.controller';
import { JwksHttpController } from '../src/interfaces/http/jwks.controller';
import { ROUTE_DEFINITION } from '../src/interfaces/http/route.guard';
import { requestBodies } from '../src/interfaces/http/schemas';
import { type IdentityServer, ORIGINS, startGateway, startIdentityStub, TestKeys } from './support/harness';

/**
 * La gateway face au contrat qui fait foi (contracts/openapi/ksp-api.v1.yaml) : mêmes routes, mêmes
 * exigences, mêmes corps de requête, et des réponses réelles (succès et erreurs) conformes aux schémas.
 */

type Json = Record<string, unknown>;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const DOC_ID = 'ksp-api';

interface Operation extends Json {
  operationId: string;
  requestBody?: { content: { 'application/json': { schema: Json; example?: unknown } } };
  responses: Record<string, Json>;
  'x-ksp-grpc': string;
  'x-ksp-access': string;
  'x-ksp-rate-limit': string;
}

const doc = parse(
  readFileSync(resolve(__dirname, '..', '..', '..', 'contracts', 'openapi', 'ksp-api.v1.yaml'), 'utf8'),
) as Json & {
  paths: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], Operation>>>;
  components: Json & { schemas: Record<string, Json>; responses: Record<string, Json> };
  'x-ksp-rate-limits': Record<string, { limit: number; per: string; key: string }>;
  'x-ksp-reserved-prefixes': { prefix: string }[];
};

const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  HTTP_METHODS.filter((method) => item[method]).map((method) => ({
    path,
    method: method.toUpperCase(),
    op: item[method] as Operation,
  })),
);
const operation = (operationId: string) => {
  const found = operations.find(({ op }) => op.operationId === operationId);
  if (!found) throw new Error(`Opération ${operationId} absente du contrat`);
  return found;
};

function resolveRef<T>(value: T | { $ref: string }): T {
  if (value && typeof value === 'object' && '$ref' in value) {
    const path = (value as { $ref: string }).$ref.replace('#/', '').split('/');
    return path.reduce<unknown>((node, key) => (node as Json)[key], doc) as T;
  }
  return value as T;
}

function absolutize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(absolutize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) =>
        key === '$ref' && typeof inner === 'string' && inner.startsWith('#/')
          ? [key, `${DOC_ID}${inner}`]
          : [key, absolutize(inner)],
      ),
    );
  }
  return value;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: DOC_ID, components: doc.components });

function responseSchema(operationId: string, status: number): ValidateFunction {
  const response = operation(operationId).op.responses[String(status)];
  if (!response) throw new Error(`${operationId} ne déclare pas de réponse ${status} dans le contrat`);
  const content = resolveRef(response as Json & { content: Record<string, { schema: Json }> }).content;
  return ajv.compile(absolutize(content['application/json']!.schema) as Json);
}

/** Méthodes d'un contrôleur (le constructeur porte le chemin du contrôleur, pas une route). */
const handlers = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => (controller.prototype as Record<string, object>)[name]!);

const contractSchema = (name: string) => resolveRef(doc.components.schemas[name] as Json) as Json;

describe('contrat OpenAPI : manifeste de routage', () => {
  it('le manifeste déclare exactement les opérations du contrat, avec leurs extensions x-ksp-*', () => {
    const fromContract = operations
      .map(({ path, method, op }) => ({
        operationId: op.operationId,
        method,
        path,
        grpc: op['x-ksp-grpc'],
        access: op['x-ksp-access'],
        rateLimit: op['x-ksp-rate-limit'],
      }))
      .sort((a, b) => a.operationId.localeCompare(b.operationId));
    const fromManifest = (ROUTE_MANIFEST as readonly RouteDefinition[])
      .map((route) => ({
        operationId: route.operationId,
        method: route.method,
        path: route.path,
        grpc: route.grpc,
        access: route.access.level,
        rateLimit: route.rateLimit,
      }))
      .sort((a, b) => a.operationId.localeCompare(b.operationId));
    expect(fromManifest).toEqual(fromContract);
  });

  it('les limites par défaut sont celles du contrat (x-ksp-rate-limits)', () => {
    const fromContract = Object.fromEntries(
      Object.entries(doc['x-ksp-rate-limits']).map(([category, rule]) => {
        expect(rule.per).toBe('minute');
        return [category, { limit: rule.limit, windowSeconds: 60, key: rule.key }];
      }),
    );
    expect(DEFAULT_RATE_LIMITS).toEqual(fromContract);
  });

  it('les préfixes réservés sont ceux du contrat', () => {
    expect([...RESERVED_PREFIXES].sort()).toEqual(doc['x-ksp-reserved-prefixes'].map((p) => p.prefix).sort());
  });

  it('chaque point d’entrée des contrôleurs vient du manifeste, et chaque route du manifeste a le sien', () => {
    const exposed: { operationId: string; method: string; path: string }[] = [];
    for (const controller of [IdentityHttpController, JwksHttpController]) {
      expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('/');
      for (const handler of handlers(controller)) {
        const path = Reflect.getMetadata(PATH_METADATA, handler);
        if (path === undefined) continue;
        const route = Reflect.getMetadata(ROUTE_DEFINITION, handler) as RouteDefinition | undefined;
        expect(route).toBeDefined();
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        expect({ method, path }).toEqual({ method: expect.any(Number), path: route!.path });
        exposed.push({ operationId: route!.operationId, method: route!.method, path });
      }
    }
    expect(exposed.map((e) => e.operationId).sort()).toEqual(
      ROUTE_MANIFEST.map((route) => route.operationId).sort(),
    );
  });

  it('les seules autres routes sont techniques (santé, métriques), hors de /api et /.well-known', () => {
    const paths = handlers(HealthController)
      .map((handler) => Reflect.getMetadata(PATH_METADATA, handler))
      .filter(Boolean);
    expect(paths.sort()).toEqual(['health/live', 'health/ready', 'metrics']);
  });
});

describe('contrat OpenAPI : corps des requêtes', () => {
  const bodies = Object.entries(requestBodies).map(([operationId, schema]) => {
    const body = operation(operationId).op.requestBody!.content['application/json'];
    return {
      operationId,
      schema: schema as z.ZodType,
      contract: resolveRef(body.schema),
      example: body.example,
    };
  });

  it('chaque opération avec un corps a son schéma de validation, et seulement elles', () => {
    expect(bodies.map((b) => b.operationId).sort()).toEqual(
      operations
        .filter(({ op }) => op.requestBody)
        .map(({ op }) => op.operationId)
        .sort(),
    );
  });

  it.each(bodies)(
    '$operationId : mêmes champs, mêmes champs obligatoires, champs inconnus refusés',
    (body) => {
      const generated = z.toJSONSchema(body.schema, { io: 'input' }) as Json & {
        properties: Json;
        required?: string[];
        additionalProperties?: boolean;
      };
      const contract = body.contract as typeof generated;
      expect(Object.keys(generated.properties).sort()).toEqual(Object.keys(contract.properties).sort());
      expect([...(generated.required ?? [])].sort()).toEqual([...(contract.required ?? [])].sort());
      expect(generated.additionalProperties).toBe(false);
      expect(contract.additionalProperties).toBe(false);
    },
  );

  it.each(bodies)('$operationId : l’exemple du contrat est accepté', ({ schema, example }) => {
    expect(schema.safeParse(example).success).toBe(true);
  });

  it('les motifs du contrat sont appliqués (téléphone, code, langue, identifiant)', () => {
    const phone = (contractSchema('PhoneE164')['pattern'] as string) ?? '';
    expect(phone).toBe('^\\+[1-9][0-9]{6,14}$');
    expect(requestBodies.requestOtp.safeParse({ phone: '+22901' }).success).toBe(false);
    expect(requestBodies.verifyOtp.safeParse({ challengeId: 'x', code: '482913' }).success).toBe(false);
    expect(
      requestBodies.verifyOtp.safeParse({ challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', code: '48a' })
        .success,
    ).toBe(false);
    expect(requestBodies.updateMe.safeParse({ preferredLanguage: 'fra' }).success).toBe(false);
    expect(requestBodies.updateMe.safeParse({}).success).toBe(false);
  });
});

describe('contrat OpenAPI : réponses réelles de la gateway', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let app: NestExpressApplication;
  let token: string;
  let ip = 0;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    app = await startGateway({ identityUrl: identity.url, keys });
    token = await keys.accessToken();
  });

  afterAll(async () => {
    await app?.close();
    await identity?.close();
  });

  beforeEach(() => identity.stub.reset());

  const http = () => request(app.getHttpServer());
  const from = (req: request.Test, client: 'web' | 'mobile' | 'backoffice' | 'none' = 'web') => {
    req.set('X-Forwarded-For', `192.0.2.${++ip}`);
    if (client === 'web') req.set('Origin', ORIGINS.web);
    if (client === 'backoffice') req.set('Origin', ORIGINS.backoffice);
    if (client === 'mobile') req.set('X-App-Version', '1.4.2');
    return req;
  };
  const authed = (req: request.Test, client: 'web' | 'mobile' | 'none' = 'none') =>
    from(req, client).set('Authorization', `Bearer ${token}`);
  const fail = (method: Parameters<typeof identity.stub.on>[0], error: AppError) =>
    identity.stub.on(method, () => Promise.reject(error));

  const OTP_BODY = { phone: '+2290197000045' };
  const VERIFY_BODY = { challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', code: '482913' };
  const suspended = AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.');
  const down = AppError.unavailable('IDENTITY_OTP_SEND_FAILED', "Le code n'a pas pu être envoyé.");

  const scenarios: [string, string, number, () => request.Test | Promise<request.Test>][] = [
    [
      'code envoyé',
      'requestOtp',
      200,
      () => from(http().post('/api/v1/identity/otp/request')).send(OTP_BODY),
    ],
    [
      'numéro mal formé',
      'requestOtp',
      400,
      () => from(http().post('/api/v1/identity/otp/request')).send({ phone: '97000045' }),
    ],
    [
      'client inconnu',
      'requestOtp',
      400,
      () => from(http().post('/api/v1/identity/otp/request'), 'none').send(OTP_BODY),
    ],
    [
      'trop de codes',
      'requestOtp',
      429,
      () => {
        fail(
          'requestOtp',
          AppError.rateLimited('IDENTITY_OTP_RATE_LIMITED', 'Trop de codes.', { retryAfterSeconds: 45 }),
        );
        return from(http().post('/api/v1/identity/otp/request')).send(OTP_BODY);
      },
    ],
    [
      'envoi impossible',
      'requestOtp',
      503,
      () => {
        fail('requestOtp', down);
        return from(http().post('/api/v1/identity/otp/request')).send(OTP_BODY);
      },
    ],
    [
      'session web',
      'verifyOtp',
      200,
      () => from(http().post('/api/v1/identity/otp/verify')).send(VERIFY_BODY),
    ],
    [
      'session mobile',
      'verifyOtp',
      200,
      () => from(http().post('/api/v1/identity/otp/verify'), 'mobile').send(VERIFY_BODY),
    ],
    [
      'double authentification',
      'verifyOtp',
      200,
      () => {
        identity.stub.on('verifyOtp', async () => ({
          result: {
            mfaRequired: {
              mfaToken: 'mfa',
              expiresAt: '2026-10-17T10:05:00.000Z',
              methods: ['MFA_METHOD_TOTP'],
              enrollmentRequired: true,
            },
          },
        }));
        return from(http().post('/api/v1/identity/otp/verify'), 'backoffice').send(VERIFY_BODY);
      },
    ],
    [
      'code incorrect',
      'verifyOtp',
      400,
      () => {
        fail(
          'verifyOtp',
          AppError.invalid('IDENTITY_OTP_INVALID', 'Code incorrect.', { attemptsRemaining: 3 }),
        );
        return from(http().post('/api/v1/identity/otp/verify')).send(VERIFY_BODY);
      },
    ],
    [
      'compte suspendu',
      'verifyOtp',
      403,
      () => {
        fail('verifyOtp', suspended);
        return from(http().post('/api/v1/identity/otp/verify')).send(VERIFY_BODY);
      },
    ],
    [
      'code expiré',
      'verifyOtp',
      422,
      () => {
        fail('verifyOtp', AppError.precondition('IDENTITY_OTP_EXPIRED', 'Le code a expiré.'));
        return from(http().post('/api/v1/identity/otp/verify')).send(VERIFY_BODY);
      },
    ],
    [
      'configuration de l’application',
      'enrollTotp',
      200,
      () => from(http().post('/api/v1/identity/mfa/totp/enroll'), 'backoffice').send({ mfaToken: 'mfa' }),
    ],
    [
      'jeton de double authentification absent',
      'enrollTotp',
      400,
      () => from(http().post('/api/v1/identity/mfa/totp/enroll'), 'backoffice').send({}),
    ],
    [
      'jeton de double authentification expiré',
      'enrollTotp',
      401,
      () => {
        fail('enrollTotp', AppError.unauthenticated('IDENTITY_MFA_TOKEN_INVALID', 'Étape expirée.'));
        return from(http().post('/api/v1/identity/mfa/totp/enroll'), 'backoffice').send({ mfaToken: 'mfa' });
      },
    ],
    [
      'application déjà configurée',
      'enrollTotp',
      422,
      () => {
        fail('enrollTotp', AppError.precondition('IDENTITY_MFA_ALREADY_ENROLLED', 'Déjà configurée.'));
        return from(http().post('/api/v1/identity/mfa/totp/enroll'), 'backoffice').send({ mfaToken: 'mfa' });
      },
    ],
    [
      'configuration confirmée',
      'confirmTotp',
      200,
      () =>
        from(http().post('/api/v1/identity/mfa/totp/confirm'), 'backoffice').send({
          mfaToken: 'mfa',
          code: '287082',
        }),
    ],
    [
      'premier code faux',
      'confirmTotp',
      400,
      () => {
        fail(
          'confirmTotp',
          AppError.invalid('IDENTITY_MFA_CODE_INVALID', 'Code incorrect.', { attemptsRemaining: 4 }),
        );
        return from(http().post('/api/v1/identity/mfa/totp/confirm'), 'backoffice').send({
          mfaToken: 'mfa',
          code: '000000',
        });
      },
    ],
    [
      'compte sans rôle du back-office',
      'confirmTotp',
      403,
      () => {
        fail('confirmTotp', AppError.forbidden('IDENTITY_BACKOFFICE_FORBIDDEN', 'Accès refusé.'));
        return from(http().post('/api/v1/identity/mfa/totp/confirm'), 'backoffice').send({
          mfaToken: 'mfa',
          code: '287082',
        });
      },
    ],
    [
      'seconde étape réussie',
      'verifyMfa',
      200,
      () =>
        from(http().post('/api/v1/identity/mfa/verify'), 'backoffice').send({
          mfaToken: 'mfa',
          method: 'totp',
          code: '081804',
        }),
    ],
    [
      'méthode SMS refusée',
      'verifyMfa',
      400,
      () =>
        from(http().post('/api/v1/identity/mfa/verify'), 'backoffice').send({
          mfaToken: 'mfa',
          method: 'sms',
          code: '081804',
        }),
    ],
    [
      'trop de codes faux',
      'verifyMfa',
      422,
      () => {
        fail('verifyMfa', AppError.precondition('IDENTITY_MFA_TOO_MANY_ATTEMPTS', 'Recommencez.'));
        return from(http().post('/api/v1/identity/mfa/verify'), 'backoffice').send({
          mfaToken: 'mfa',
          method: 'recovery_code',
          code: '7KQ2M-X9PDA',
        });
      },
    ],
    [
      'renouvellement web',
      'refreshSession',
      200,
      () => from(http().post('/api/v1/identity/token/refresh')).set('Cookie', '__Secure-ksp_rt=rt-old'),
    ],
    [
      'renouvellement mobile',
      'refreshSession',
      200,
      () => from(http().post('/api/v1/identity/token/refresh'), 'mobile').send({ refreshToken: 'rt-old' }),
    ],
    [
      'jeton dans le corps sur le web',
      'refreshSession',
      400,
      () => from(http().post('/api/v1/identity/token/refresh')).send({ refreshToken: 'rt-old' }),
    ],
    ['cookie absent', 'refreshSession', 401, () => from(http().post('/api/v1/identity/token/refresh'))],
    [
      'compte suspendu au renouvellement',
      'refreshSession',
      403,
      () => {
        fail('refreshSession', suspended);
        return from(http().post('/api/v1/identity/token/refresh'), 'mobile').send({ refreshToken: 'rt' });
      },
    ],
    [
      'déconnexion',
      'logout',
      200,
      () => authed(http().post('/api/v1/identity/logout'), 'web').send({ scope: 'all_devices' }),
    ],
    [
      'portée inconnue',
      'logout',
      400,
      () => authed(http().post('/api/v1/identity/logout'), 'web').send({ scope: 'everything' }),
    ],
    ['non connecté', 'logout', 401, () => from(http().post('/api/v1/identity/logout'))],
    ['profil', 'getMe', 200, () => authed(http().get('/api/v1/identity/me'))],
    ['profil sans jeton', 'getMe', 401, () => from(http().get('/api/v1/identity/me'), 'none')],
    [
      'compte supprimé',
      'getMe',
      404,
      () => {
        fail('getMe', AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'));
        return authed(http().get('/api/v1/identity/me'));
      },
    ],
    [
      'identity indisponible',
      'getMe',
      503,
      () => {
        fail('getMe', AppError.unavailable('IDENTITY_UNAVAILABLE', 'Indisponible.'));
        return authed(http().get('/api/v1/identity/me'));
      },
    ],
    [
      'profil complété',
      'updateMe',
      200,
      () => authed(http().patch('/api/v1/identity/me')).send({ firstName: 'Koffi', lastName: 'Adjovi' }),
    ],
    [
      'nom invalide',
      'updateMe',
      400,
      () => {
        fail('updateMe', AppError.invalid('IDENTITY_NAME_INVALID', 'Nom invalide.', { field: 'firstName' }));
        return authed(http().patch('/api/v1/identity/me')).send({ firstName: 'K0ffi' });
      },
    ],
    [
      'modification sans jeton',
      'updateMe',
      401,
      () => from(http().patch('/api/v1/identity/me'), 'none').send({ firstName: 'Koffi' }),
    ],
    ['clés publiques', 'getJwks', 200, () => from(http().get('/.well-known/jwks.json'), 'none')],
  ];

  it('chaque opération du contrat a au moins un scénario de succès', () => {
    const succeeded = new Set(scenarios.filter(([, , status]) => status === 200).map(([, id]) => id));
    expect([...succeeded].sort()).toEqual(operations.map(({ op }) => op.operationId).sort());
  });

  it.each(scenarios)(
    '%s (%s → %i) : réponse conforme au contrat',
    async (_label, operationId, status, run) => {
      const res = await run();
      expect(res.status).toBe(status);
      expect(Object.keys(operation(operationId).op.responses)).toContain(String(status));

      const validate = responseSchema(operationId, status);
      expect(validate(res.body) ? [] : validate.errors).toEqual([]);
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
      if (status >= 400) {
        expect(res.body.error.correlationId).toBe(res.headers['x-correlation-id']);
        if (status === 429) expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      }

      // Set-Cookie seulement là où le contrat le déclare.
      const declaredHeaders = Object.keys(
        (resolveRef(operation(operationId).op.responses[String(status)] as Json)['headers'] as Json) ?? {},
      );
      if (res.headers['set-cookie']) expect(declaredHeaders).toContain('Set-Cookie');
    },
  );
});
