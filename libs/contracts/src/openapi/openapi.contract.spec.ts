import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const CONTRACTS_ROOT = resolve(__dirname, '..', '..', '..', '..', 'contracts');
const DOC_ID = 'ksp-api';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ACCESS_LEVELS = ['public', 'refresh_token', 'mfa_token', 'authenticated'];

type Json = Record<string, unknown>;

interface Operation extends Json {
  operationId?: string;
  security?: Json[];
  requestBody?: { content?: Record<string, MediaType> };
  responses?: Record<string, Json>;
  'x-ksp-grpc'?: string;
  'x-ksp-access'?: string;
  'x-ksp-rate-limit'?: string;
  'x-ksp-roles'?: string[];
  'x-ksp-mfa-max-age'?: number;
  'x-ksp-raw-body'?: boolean;
}

interface MediaType {
  schema?: Json;
  example?: unknown;
  examples?: Record<string, { value: unknown }>;
}

const doc = parse(readFileSync(join(CONTRACTS_ROOT, 'openapi', 'ksp-api.v1.yaml'), 'utf8')) as Json & {
  paths: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], Operation>>>;
  components: Json & { schemas: Record<string, Json>; responses: Record<string, Json> };
  'x-ksp-rate-limits': Record<string, unknown>;
  'x-ksp-reserved-prefixes': { prefix: string }[];
};

const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  HTTP_METHODS.filter((method) => item[method]).map((method) => ({
    path,
    method,
    op: item[method] as Operation,
  })),
);

/** Appels gRPC déclarés dans les .proto, sous la forme "<paquet>.<Service>/<Méthode>". */
function grpcMethods(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.proto')) {
        const source = readFileSync(full, 'utf8');
        const pkg = /^package\s+([\w.]+);/m.exec(source)?.[1];
        for (const service of source.matchAll(/^service\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
          for (const rpc of service[2].matchAll(/^\s*rpc\s+(\w+)\s*\(/gm)) {
            found.add(`${pkg}.${service[1]}/${rpc[1]}`);
          }
        }
      }
    }
  };
  walk(join(CONTRACTS_ROOT, 'proto'));
  return found;
}

/** Remplace "#/components/…" par une référence absolue au document, pour compiler un schéma isolé. */
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

function resolveRef<T>(value: T | { $ref: string }): T {
  if (value && typeof value === 'object' && '$ref' in value) {
    const path = (value as { $ref: string }).$ref.replace('#/', '').split('/');
    return path.reduce<unknown>((node, key) => (node as Json)[key], doc) as T;
  }
  return value as T;
}

describe('contrat OpenAPI de la gateway', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: DOC_ID, components: doc.components });

  it('est un document OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(operations.length).toBeGreaterThan(0);
  });

  it.each(operations)('$method $path déclare son appel gRPC, son accès et sa limite', ({ op }) => {
    expect(op.operationId).toBeTruthy();
    expect(grpcMethods()).toContain(op['x-ksp-grpc']);
    expect(ACCESS_LEVELS).toContain(op['x-ksp-access']);
    expect(Object.keys(doc['x-ksp-rate-limits'])).toContain(op['x-ksp-rate-limit']);
  });

  it.each(operations)(
    '$method $path exige un jeton d’accès si et seulement si la route est connectée',
    ({ op }) => {
      const needsBearer = (op.security ?? []).some((requirement) => 'bearerAuth' in requirement);
      expect(needsBearer).toBe(op['x-ksp-access'] === 'authenticated');
    },
  );

  it.each(operations)(
    '$method $path : rôles et double authentification seulement sur une route connectée ; toujours sur le back-office',
    ({ path, op }) => {
      const roles = op['x-ksp-roles'];
      const mfa = op['x-ksp-mfa-max-age'];
      if (roles !== undefined || mfa !== undefined) expect(op['x-ksp-access']).toBe('authenticated');
      if (roles !== undefined) {
        expect(Array.isArray(roles) && roles.length > 0).toBe(true);
        for (const role of roles) expect(role).toMatch(/^[a-z]+(_[a-z]+)*$/);
      }
      if (mfa !== undefined) expect(Number.isInteger(mfa) && mfa > 0).toBe(true);
      if (path.startsWith('/api/v1/admin/')) {
        expect(roles).toBeDefined();
        expect(mfa).toBeDefined();
      }
    },
  );

  it.each(operations)('$method $path respecte les préfixes', ({ path }) => {
    expect(path).toMatch(/^\/(api\/v1\/[a-z-]+\/|\.well-known\/)/);
    for (const { prefix } of doc['x-ksp-reserved-prefixes']) {
      expect(path.startsWith(prefix)).toBe(false);
    }
  });

  // Corps brut (x-ksp-raw-body : notification signée d'un prestataire) : transmis tel quel, la
  // signature porte sur lui ; seule cette exception est admise, et seulement sur une route publique.
  it.each(operations.filter(({ op }) => op['x-ksp-raw-body']))(
    '$method $path : corps brut seulement sur une route publique, avec sa limite propre',
    ({ op }) => {
      expect(op['x-ksp-access']).toBe('public');
      expect(op['x-ksp-rate-limit']).not.toBe('public');
    },
  );

  it.each(operations.filter(({ op }) => op.requestBody && !op['x-ksp-raw-body']))(
    '$method $path refuse les champs inconnus',
    ({ op }) => {
      const schema = resolveRef(op.requestBody?.content?.['application/json']?.schema as Json);
      expect(schema['additionalProperties']).toBe(false);
    },
  );

  /** Chaque exemple du contrat (requêtes, réponses, erreurs communes) respecte son schéma. */
  const examples = [
    ...operations.flatMap(({ path, method, op }) => {
      const media = [
        ['requête', op.requestBody?.content?.['application/json']],
        ...Object.entries(op.responses ?? {}).map(
          ([status, response]) =>
            [
              status,
              resolveRef(response as Json & { content?: Record<string, MediaType> }).content?.[
                'application/json'
              ],
            ] as const,
        ),
      ] as [string, MediaType | undefined][];
      return media.flatMap(([label, content]) => listExamples(`${method} ${path} ${label}`, content));
    }),
  ];

  function listExamples(label: string, content: MediaType | undefined): [string, Json, unknown][] {
    if (!content?.schema) return [];
    const named = Object.entries(content.examples ?? {}).map(
      ([name, example]) =>
        [`${label} (${name})`, content.schema as Json, example.value] as [string, Json, unknown],
    );
    return content.example === undefined ? named : [[label, content.schema, content.example], ...named];
  }

  it.each(examples)('exemple valide : %s', (_label, schema, example) => {
    const validate = ajv.compile(absolutize(schema) as Json);
    expect(validate(example) ? [] : validate.errors).toEqual([]);
  });
});
