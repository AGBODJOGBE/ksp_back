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
  'x-ksp-permission'?: string;
  'x-ksp-default-roles'?: string[];
  'x-ksp-mfa-max-age'?: number;
  'x-ksp-raw-body'?: boolean;
  'x-ksp-pending-deletion'?: boolean;
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
    '$method $path : rôles ou permission et double authentification seulement sur une route connectée ; toujours sur le back-office',
    ({ path, op }) => {
      const roles = op['x-ksp-roles'];
      const permission = op['x-ksp-permission'];
      const defaultRoles = op['x-ksp-default-roles'];
      const mfa = op['x-ksp-mfa-max-age'];
      if (roles !== undefined || permission !== undefined || mfa !== undefined) {
        expect(op['x-ksp-access']).toBe('authenticated');
      }
      for (const list of [roles, defaultRoles]) {
        if (list === undefined) continue;
        expect(Array.isArray(list) && list.length > 0).toBe(true);
        for (const role of list) expect(role).toMatch(/^[a-z]+(_[a-z]+)*$/);
      }
      // RBAC dynamique (R-RB-02) : la permission est la seule condition d'accès ; une liste de rôles
      // exigés à côté d'elle refuserait un rôle créé au back-office. Les rôles par défaut ne sont
      // qu'une information.
      if (permission !== undefined) {
        expect(permission).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
        expect(roles).toBeUndefined();
      }
      if (defaultRoles !== undefined) expect(permission).toBeDefined();
      if (mfa !== undefined) expect(Number.isInteger(mfa) && mfa > 0).toBe(true);
      if (path.startsWith('/api/v1/admin/')) {
        expect(roles !== undefined || permission !== undefined).toBe(true);
        expect(mfa).toBeDefined();
      }
    },
  );

  // Session restreinte d'un compte en cours de suppression (ADR-036) : acceptée seulement sur les
  // routes connectées qui le déclarent ; toutes les autres la refusent (403).
  it.each(operations.filter(({ op }) => op['x-ksp-access'] === 'authenticated'))(
    '$method $path : session restreinte acceptée explicitement, ou refusée (403)',
    ({ op }) => {
      const pendingDeletion = op['x-ksp-pending-deletion'];
      if (pendingDeletion !== undefined) expect(pendingDeletion).toBe(true);
      else expect(Object.keys(op.responses ?? {})).toContain('403');
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

/**
 * Routes du Nettoyage v2 qui reprennent les règles de la v1 : permission, clé d'idempotence, double
 * authentification récente pour les actions sensibles, limite d'appels des paiements, profil complet.
 */
describe('contrat OpenAPI du Nettoyage : règles reprises de la v1', () => {
  const byId = new Map(operations.map((entry) => [entry.op.operationId, entry]));
  const route = (operationId: string) => {
    const entry = byId.get(operationId);
    if (!entry) throw new Error(`route absente : ${operationId}`);
    return entry;
  };
  const hasIdempotencyKey = (op: Operation): boolean =>
    ((op['parameters'] ?? []) as Json[]).some((p) => p['$ref'] === '#/components/parameters/IdempotencyKey');

  // operationId, méthode, chemin, permission (null : sans permission déclarée), double authentification
  it.each([
    [
      'cleaningCorrectRequestLocation',
      'put',
      '/api/v1/admin/cleaning/requests/{id}/location',
      'cleaning.request.process',
      43200,
    ],
    [
      'cleaningCorrectRequestLocationOnSite',
      'put',
      '/api/v1/cleaning/agent/requests/{id}/location',
      null,
      undefined,
    ],
    [
      'cleaningRequestNewVisit',
      'post',
      '/api/v1/admin/cleaning/requests/{id}/new-visit',
      'cleaning.request.process',
      43200,
    ],
    [
      'cleaningCompleteVisitOnBehalf',
      'post',
      '/api/v1/admin/cleaning/visits/{id}/complete',
      'cleaning.request.process',
      600,
    ],
    [
      'cleaningReportVisitMissedOnBehalf',
      'post',
      '/api/v1/admin/cleaning/visits/{id}/missed',
      'cleaning.request.process',
      600,
    ],
    [
      'cleaningRemoveVisitPhotoAsKsp',
      'post',
      '/api/v1/admin/cleaning/visits/{id}/photos/{fileId}/remove',
      'cleaning.request.process',
      600,
    ],
    [
      'cleaningCompleteSessionAsKsp',
      'post',
      '/api/v1/admin/cleaning/sessions/{id}/complete',
      'cleaning.program.manage',
      600,
    ],
    [
      'cleaningReportSessionMissedAsKsp',
      'post',
      '/api/v1/admin/cleaning/sessions/{id}/missed',
      'cleaning.program.manage',
      600,
    ],
    [
      'cleaningRemoveSessionPhotoAsKsp',
      'post',
      '/api/v1/admin/cleaning/sessions/{id}/photos/{fileId}/remove',
      'cleaning.program.manage',
      600,
    ],
    [
      'cleaningRemoveSessionPhoto',
      'delete',
      '/api/v1/cleaning/sessions/{id}/photos/{fileId}',
      'cleaning.session.perform',
      undefined,
    ],
    [
      'cleaningRemoveVisitPhoto',
      'delete',
      '/api/v1/cleaning/visits/{id}/photos/{fileId}',
      'cleaning.visit.perform',
      undefined,
    ],
    [
      'cleaningRemoveAssignment',
      'post',
      '/api/v1/admin/cleaning/assignments/{id}/remove',
      'cleaning.planning.manage',
      43200,
    ],
  ] as const)(
    '%s : %s %s, permission %s, idempotente, double authentification %s',
    (id, method, path, permission, mfa) => {
      const { op, method: actualMethod, path: actualPath } = route(id);
      expect([actualMethod, actualPath]).toEqual([method, path]);
      expect(op['x-ksp-permission']).toBe(permission ?? undefined);
      expect(op['x-ksp-mfa-max-age']).toBe(mfa);
      expect(hasIdempotencyKey(op)).toBe(true);
    },
  );

  it.each([
    ['cleaningLocatePoint', 'post', '/api/v1/cleaning/places/locate', null],
    ['cleaningListCommunes', 'get', '/api/v1/admin/cleaning/communes', 'cleaning.catalog.read'],
    [
      'cleaningEstimateRetainedValues',
      'post',
      '/api/v1/admin/cleaning/requests/{id}/retained-values/estimate',
      'cleaning.quote.manage',
    ],
  ] as const)('%s : lecture sans écriture, sans clé d’idempotence', (id, method, path, permission) => {
    const { op, method: actualMethod, path: actualPath } = route(id);
    expect([actualMethod, actualPath]).toEqual([method, path]);
    expect(op['x-ksp-permission']).toBe(permission ?? undefined);
    expect(hasIdempotencyKey(op)).toBe(false);
  });

  it('la correction de position a une route back-office et une route de l’agent sur place, sur le même appel', () => {
    const admin = route('cleaningCorrectRequestLocation').op;
    const onSite = route('cleaningCorrectRequestLocationOnSite').op;
    expect(onSite['x-ksp-grpc']).toBe(admin['x-ksp-grpc']);
    expect(onSite.requestBody).toEqual(admin.requestBody);
    expect(onSite['x-ksp-access']).toBe('authenticated');
    expect(onSite['x-ksp-default-roles']).toBeUndefined();
  });

  it('la désaffectation ne passe plus par un DELETE avec un corps', () => {
    expect(doc.paths['/api/v1/admin/cleaning/assignments/{id}']?.delete).toBeUndefined();
    for (const { path, method, op } of operations) {
      if (method === 'delete' && path.includes('/cleaning/')) expect(op.requestBody).toBeUndefined();
    }
  });

  it.each([
    'cleaningRescheduleSession',
    'cleaningCancelSession',
    'cleaningStopProgram',
    'cleaningRescheduleSessionAsKsp',
    'cleaningCancelSessionAsKsp',
    'cleaningCancelProgram',
    'cleaningApproveProgramCancellation',
    'cleaningChangeProgramSchedule',
    'cleaningApproveClaimCredit',
    'cleaningCancelVisit',
    'cleaningApproveProposals',
    'cleaningUpdateClaim',
    'cleaningDecideReactivation',
    'cleaningCancelRequest',
    'cleaningRejectRequest',
    'cleaningChangeVisitSlot',
    'cleaningUpdateVisit',
    'cleaningSuspendProgram',
    'cleaningResumeProgram',
    'cleaningResumeSession',
    'cleaningApproveAgent',
    'cleaningApproveQuoteAdjustment',
    'cleaningRequestReactivation',
    'cleaningDeclineQuote',
    'cleaningPublishTariff',
    'cleaningSetZoneActive',
    'cleaningStartAgentReview',
    'cleaningRejectAgent',
    'cleaningSuspendAgent',
    'cleaningReactivateAgent',
    'cleaningDeactivateAgent',
  ])('%s exige Idempotency-Key (toute action qui change un dossier, l’agenda ou l’argent)', (id) => {
    expect(hasIdempotencyKey(route(id).op)).toBe(true);
  });

  it('le catalogue public et la vue de l’agent ne portent pas la trace de modification des paramètres', () => {
    const schemas = doc.components.schemas;
    for (const field of ['updatedAt', 'updatedBy', 'updatedByName']) {
      expect((schemas['CleaningPublicParameter']?.['properties'] as Json)[field]).toBeUndefined();
    }
    const parameterItems = (schema: string, property: string) =>
      ((schemas[schema]?.['properties'] as Record<string, Json>)[property]?.['items'] as Json)['$ref'];
    expect(parameterItems('CleaningPublicOffer', 'extraParameters')).toBe(
      '#/components/schemas/CleaningPublicParameter',
    );
    expect(parameterItems('CleaningPublicPlaceTypeDetail', 'parameters')).toBe(
      '#/components/schemas/CleaningPublicParameter',
    );
    expect(parameterItems('CleaningAgentVisitView', 'parameters')).toBe(
      '#/components/schemas/CleaningPublicParameter',
    );
    // Aucune route hors back-office n'atteint ParameterDefinition, même par un schéma intermédiaire.
    const reaches = (node: unknown, seen = new Set<string>()): boolean => {
      if (Array.isArray(node)) return node.some((item) => reaches(item, seen));
      if (!node || typeof node !== 'object') return false;
      const ref = (node as Json)['$ref'];
      if (typeof ref === 'string') {
        const name = ref.split('/').pop() as string;
        if (name === 'CleaningParameterDefinition') return true;
        if (seen.has(name)) return false;
        seen.add(name);
        return reaches(schemas[name], seen);
      }
      return Object.values(node).some((value) => reaches(value, seen));
    };
    for (const { path, op } of operations) {
      if (path.startsWith('/api/v1/cleaning/')) expect([path, reaches(op.responses)]).toEqual([path, false]);
    }
  });

  it.each(['cleaningPayVisitFee', 'cleaningPaySession'])('%s : limite d’appels des paiements', (id) => {
    expect(route(id).op['x-ksp-rate-limit']).toBe('payment_create');
  });

  it.each(['cleaningSubmitRequest', 'cleaningRenewProgram', 'cleaningReorderProgram'])(
    '%s : profil complet vérifié par la gateway',
    (id) => {
      expect(route(id).op['x-ksp-requires-complete-profile']).toBe(true);
    },
  );

  it('les permissions de terrain ne sont livrées par défaut qu’au rôle agent', () => {
    for (const { op } of operations) {
      const permission = op['x-ksp-permission'];
      if (permission === 'cleaning.visit.perform' || permission === 'cleaning.session.perform') {
        expect(op['x-ksp-default-roles']).toEqual(['cleaning_agent']);
      }
    }
  });
});
