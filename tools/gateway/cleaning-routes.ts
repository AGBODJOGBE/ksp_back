/**
 * Produit la couche Nettoyage de la gateway à partir des contrats (ADR-054) :
 *   pnpm gateway:routes            écrit les fichiers produits ;
 *   pnpm gateway:routes --check    échoue si l'un d'eux n'est plus à jour (test de la gateway).
 *
 * Sources : contracts/openapi/ksp-api.v1.yaml (routes /api/v1/cleaning et /api/v1/admin/cleaning,
 * extensions x-ksp-*) et contracts/proto/ksp/cleaning/v1/cleaning.proto. Fichiers produits, à ne
 * jamais modifier à la main :
 * - services/gateway/src/domain/routing/cleaning-routes.ts : lignes du manifeste de routage ;
 * - services/gateway/src/interfaces/http/cleaning-schemas.ts : validation zod des paramètres et corps ;
 * - services/gateway/src/infrastructure/grpc/cleaning-bindings.ts : appel gRPC de chaque route et
 *   conversion JSON ⇄ message, avec la liste des écarts admis entre les deux contrats.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { parse } from 'yaml';
import { type Codec, CodecBuilder, type Direction, type Gap } from './codecs';
import {
  type ContractOperation,
  type OpenApiDocument,
  operationsOf,
  type Parameter,
  refName,
  resolveParameter,
  resolveSchema,
  responseSchema,
  withoutNull,
} from './openapi';
import { parseProto, type ProtoFile, type ProtoMessage } from './proto';
import { ZodEmitter } from './zod-schemas';

const ROOT = join(__dirname, '..', '..');
const GATEWAY = 'services/gateway/src';
export const PRODUCED = {
  routes: `${GATEWAY}/domain/routing/cleaning-routes.ts`,
  schemas: `${GATEWAY}/interfaces/http/cleaning-schemas.ts`,
  bindings: `${GATEWAY}/infrastructure/grpc/cleaning-bindings.ts`,
};
const PREFIXES = ['/api/v1/cleaning/', '/api/v1/admin/cleaning/'];
const PACKAGE = 'ksp.cleaning.v1';

/** Extensions lues ; toute autre extension x-ksp-* arrête la génération (elle demande un contrôle). */
const EXTENSIONS = new Set([
  'x-ksp-grpc',
  'x-ksp-access',
  'x-ksp-rate-limit',
  'x-ksp-roles',
  'x-ksp-permission',
  'x-ksp-default-roles',
  'x-ksp-mfa-max-age',
  'x-ksp-pending-deletion',
  'x-ksp-requires-complete-profile',
]);
const ACCESS_LEVELS = new Set(['public', 'refresh_token', 'mfa_token', 'authenticated']);

function header(sources: string[]): string {
  return [
    '// Produit par tools/gateway/cleaning-routes.ts (pnpm gateway:routes) : ne pas modifier, régénérer.',
    `// Source : ${sources.join(', ')}.`,
    '',
  ].join('\n');
}

interface Built {
  operationId: string;
  route: string;
  request: string;
  binding: string;
}

/** Contenu des trois fichiers produits, formatés comme le reste du dépôt. */
export async function renderCleaningLayer(root = ROOT): Promise<Record<string, string>> {
  const doc = parse(readFileSync(join(root, 'contracts/openapi/ksp-api.v1.yaml'), 'utf8')) as OpenApiDocument;
  const proto = parseProto(
    readFileSync(join(root, 'contracts/proto/ksp/cleaning/v1/cleaning.proto'), 'utf8'),
    'cleaning.proto',
  );
  if (proto.package !== PACKAGE) throw new Error(`Paquet ${proto.package} inattendu`);
  // Montants : message commun, même forme que le schéma REST Money ({ amount, currency }).
  proto.messages.set('ksp.common.v1.Money', {
    name: 'Money',
    fields: [
      { name: 'amount', jsonName: 'amount', type: 'int64', label: 'single' },
      { name: 'currency', jsonName: 'currency', type: 'string', label: 'single' },
    ],
  });

  const operations = operationsOf(doc).filter(({ path }) =>
    PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  const zod = new ZodEmitter(doc);
  const codecs = new CodecBuilder(doc, proto);
  const roots: { codec: Codec; direction: Direction }[] = [];
  const principal = new Map<string, string>();
  const built: Built[] = operations.map((operation) => {
    const grpc = String(operation.op['x-ksp-grpc']);
    const aliasOf = principal.get(grpc);
    if (!aliasOf) principal.set(grpc, operation.op.operationId);
    return {
      operationId: operation.op.operationId,
      route: renderRoute(operation, aliasOf),
      request: renderRequest(doc, zod, operation),
      binding: renderBinding(doc, proto, codecs, operation, roots),
    };
  });
  const { messages, gaps } = codecs.finish(roots);
  gaps.push(...codecs.rootGaps.request, ...codecs.rootGaps.response);

  const openapi = 'contracts/openapi/ksp-api.v1.yaml';
  const files: Record<string, string> = {
    [PRODUCED.routes]: [
      header([openapi]),
      "import { type RouteDefinition } from './route-manifest';",
      '',
      '/**',
      ` * Routes du Nettoyage v2 (ADR-054) : ${built.length} opérations du contrat, dans son ordre. Accès,`,
      ' * permission, double authentification, limite et clé d’idempotence repris des extensions x-ksp-* ;',
      ' * une route alias (`aliasOf`) appelle la même méthode gRPC qu’une autre route.',
      ' */',
      `export const CLEANING_ROUTES = [${built.map((item) => item.route).join(',\n')}] as const satisfies readonly RouteDefinition[];`,
      '',
      "export type CleaningOperationId = (typeof CLEANING_ROUTES)[number]['operationId'];",
    ].join('\n'),
    [PRODUCED.schemas]: [
      header([openapi]),
      "import { z } from 'zod';",
      "import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';",
      "import { booleanParam, date, dateTime, dependentRequired, numberParam, unique, uuid } from './contract-schemas';",
      "import { type CleaningRequestSchema } from './cleaning-request';",
      '',
      ...zod.declarations(),
      '',
      '/** Paramètres de chemin, de requête et corps de chaque route (champs inconnus du corps refusés). */',
      `export const CLEANING_REQUESTS = {${built.map((item) => `${item.operationId}: ${item.request}`).join(',\n')}} satisfies Record<CleaningOperationId, CleaningRequestSchema>;`,
    ].join('\n'),
    [PRODUCED.bindings]: [
      header([openapi, 'contracts/proto/ksp/cleaning/v1/cleaning.proto']),
      "import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';",
      "import { type CleaningBinding, type MessageCodec } from './cleaning-codec';",
      '',
      ...renderGaps(gaps),
      'export const CLEANING_BINDINGS = {',
      built.map((item) => `${item.operationId}: ${item.binding}`).join(',\n'),
      '} satisfies Record<CleaningOperationId, CleaningBinding>;',
      '',
      '/** Tables de conversion des objets : nom REST → champ gRPC et règle de conversion. */',
      `export const CLEANING_MESSAGES: Record<string, MessageCodec> = ${JSON.stringify(Object.fromEntries(messages))};`,
    ].join('\n'),
  };

  const formatted: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const filepath = join(root, path);
    const options = (await resolveConfig(filepath)) ?? {};
    formatted[path] = await format(content, { ...options, filepath });
  }
  return formatted;
}

function renderRoute({ method, path, op }: ContractOperation, aliasOf: string | undefined): string {
  const unknown = Object.keys(op).filter((key) => key.startsWith('x-ksp-') && !EXTENSIONS.has(key));
  if (unknown.length) {
    throw new Error(
      `${op.operationId} : extension non prise en charge par la gateway (${unknown.join(', ')})`,
    );
  }
  const level = String(op['x-ksp-access']);
  if (!ACCESS_LEVELS.has(level)) throw new Error(`${op.operationId} : accès ${level} inconnu`);
  const access: Record<string, unknown> = { level };
  const roles = op['x-ksp-roles'] as string[] | undefined;
  if (roles) access['anyRole'] = roles;
  if (op['x-ksp-permission'] !== undefined) access['permission'] = String(op['x-ksp-permission']);
  if (op['x-ksp-mfa-max-age'] !== undefined) access['recentMfaSeconds'] = Number(op['x-ksp-mfa-max-age']);
  if (op['x-ksp-pending-deletion'] === true) access['allowsPendingDeletion'] = true;

  const idempotency = idempotencyOf(op.parameters ?? []);
  const route: Record<string, unknown> = {
    operationId: op.operationId,
    method,
    path,
    grpc: op['x-ksp-grpc'],
    access,
    rateLimit: op['x-ksp-rate-limit'],
    requiresKnownClient: false,
    ...(idempotency ? { idempotencyKey: idempotency } : {}),
    ...(op['x-ksp-requires-complete-profile'] === true ? { requiresCompleteProfile: true } : {}),
    ...(op.responses['204'] && !op.responses['200'] ? { successStatus: 204 } : {}),
    ...(aliasOf ? { aliasOf } : {}),
  };
  return `// ${op.summary ?? op.operationId}\n${JSON.stringify(route)}`;
}

function idempotencyOf(parameters: Parameter[]): 'required' | 'optional' | null {
  const refs = parameters.map((parameter) => parameter.$ref ?? '');
  if (refs.some((ref) => ref.endsWith('/IdempotencyKey'))) return 'required';
  if (refs.some((ref) => ref.endsWith('/OptionalIdempotencyKey'))) return 'optional';
  return null;
}

function renderRequest(doc: OpenApiDocument, zod: ZodEmitter, { op }: ContractOperation): string {
  const parameters = (op.parameters ?? []).map((parameter) => resolveParameter(doc, parameter));
  const parts: string[] = [];
  for (const place of ['path', 'query'] as const) {
    const list = parameters.filter((parameter) => parameter.in === place);
    if (!list.length) continue;
    const fields = list.map((parameter) => {
      const code = zod.parameter(parameter.schema, `${op.operationId}.${place}.${parameter.name}`);
      const required = place === 'path' || parameter.required === true;
      return `${JSON.stringify(parameter.name)}: ${required ? code : `${code}.optional()`}`;
    });
    // Paramètres de requête inconnus ignorés (paramètre anti-cache d'un navigateur…), comme ailleurs.
    parts.push(`${place === 'path' ? 'params' : 'query'}: z.object({ ${fields.join(', ')} })`);
  }
  const content = op.requestBody?.content['application/json'];
  if (op.requestBody && !content) throw new Error(`${op.operationId} : corps non JSON`);
  if (content) {
    parts.push(`body: ${zod.schema(content.schema, `${op.operationId}.body`)}`);
    if (op.requestBody?.required) parts.push('bodyRequired: true');
  }
  return `{ ${parts.join(', ')} }`;
}

function renderBinding(
  doc: OpenApiDocument,
  proto: ProtoFile,
  codecs: CodecBuilder,
  { op }: ContractOperation,
  roots: { codec: Codec; direction: Direction }[],
): string {
  const where = op.operationId;
  const match = /^ksp\.cleaning\.v1\.([A-Z]\w*)\/([A-Z]\w*)$/.exec(String(op['x-ksp-grpc']));
  if (!match) throw new Error(`${where} : appel ${String(op['x-ksp-grpc'])} hors de ksp.cleaning.v1`);
  const [, service, rpc] = match as unknown as [string, string, string];
  const method = proto.services.get(service)?.find((candidate) => candidate.name === rpc);
  if (!method) throw new Error(`${where} : ${service}/${rpc} absent de cleaning.proto`);
  const input = codecs.message(method.input);
  const output = codecs.message(method.output);
  const binding: Record<string, unknown> = { service, method: rpc[0]!.toLowerCase() + rpc.slice(1) };

  // Requête : en-tête, paramètres de requête et champs du corps portent le nom du champ gRPC ; les
  // paramètres de chemin prennent les champs restants (`id` → `placeId`…).
  const parameters = (op.parameters ?? []).map((parameter) => resolveParameter(doc, parameter));
  const fields = new Map(input.fields.map((field) => [field.jsonName, field]));
  const taken = new Set<string>();
  const take = (name: string, what: string) => {
    const field = fields.get(name);
    if (!field || taken.has(name))
      throw new Error(`${where} : ${what} ${name} sans champ dans ${input.name}`);
    taken.add(name);
    return field;
  };
  if (parameters.some((parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key')) {
    if (take('idempotencyKey', 'en-tête').type !== 'string')
      throw new Error(`${where} : idempotencyKey non texte`);
    binding['idempotencyKey'] = true;
  }
  for (const parameter of parameters.filter((each) => each.in === 'header')) {
    if (parameter.name !== 'Idempotency-Key')
      throw new Error(`${where} : en-tête ${parameter.name} non pris en charge`);
  }
  for (const parameter of parameters.filter((each) => each.in === 'query')) {
    const field = take(parameter.name, 'paramètre de requête');
    if (codecs.codec(parameter.schema, field, `${where}?${parameter.name}`) !== 'value') {
      throw new Error(`${where} : paramètre de requête ${parameter.name} non simple`);
    }
  }
  const content = op.requestBody?.content['application/json'];
  if (content) {
    const body = resolveSchema(doc, content.schema);
    for (const property of Object.keys(body.properties ?? {})) take(property, 'champ du corps');
    const name = content.schema.$ref ? refName(content.schema.$ref) : `${where}.body`;
    const codec: Codec = { message: codecs.object(content.schema, name, input) };
    roots.push({ codec, direction: 'request' });
    binding['body'] = codec;
  }
  const pathParameters = parameters.filter((parameter) => parameter.in === 'path');
  const params: Record<string, string> = {};
  for (const parameter of pathParameters.filter((each) => fields.has(each.name) && !taken.has(each.name))) {
    params[parameter.name] = take(parameter.name, 'paramètre de chemin').jsonName;
  }
  const rest = input.fields.filter((field) => !taken.has(field.jsonName));
  const unmatched = pathParameters.filter((parameter) => !(parameter.name in params));
  if (unmatched.length > 1 || rest.length !== unmatched.length) {
    throw new Error(
      `${where} : paramètres de chemin ${unmatched.map((p) => p.name).join(', ') || '(aucun)'} face aux champs ` +
        `${rest.map((field) => field.jsonName).join(', ') || '(aucun)'} de ${input.name}`,
    );
  }
  for (const parameter of unmatched)
    params[parameter.name] = take(rest[0]!.jsonName, 'paramètre de chemin').jsonName;
  for (const parameter of pathParameters) {
    const field = fields.get(params[parameter.name]!)!;
    if (codecs.codec(parameter.schema, field, `${where}/${parameter.name}`) !== 'value') {
      throw new Error(`${where} : paramètre de chemin ${parameter.name} non simple`);
    }
  }
  if (Object.keys(params).length) binding['params'] = params;

  binding['response'] = renderResponse(doc, codecs, op, output, roots);
  return JSON.stringify(binding);
}

/**
 * Réponse : le message gRPC entier (listes, pages), ou son unique champ quand le schéma REST décrit
 * ce champ (`{ place }` → lieu). Sans corps (204) : null.
 */
function renderResponse(
  doc: OpenApiDocument,
  codecs: CodecBuilder,
  op: ContractOperation['op'],
  output: ProtoMessage,
  roots: { codec: Codec; direction: Direction }[],
): unknown {
  const schema = responseSchema(op, '200');
  if (!schema) {
    if (!op.responses['204']) throw new Error(`${op.operationId} : ni 200 ni 204`);
    if (output.fields.length)
      throw new Error(`${op.operationId} : réponse 204 face à ${output.name} non vide`);
    return null;
  }
  const { schema: object, nullable, name } = withoutNull(doc, schema);
  const names = new Set(output.fields.map((field) => field.jsonName));
  const direct =
    !nullable &&
    object.type === 'object' &&
    object.properties !== undefined &&
    Object.keys(object.properties).every((property) => names.has(property) || property === 'data');
  if (direct) {
    const codec: Codec = { message: codecs.object(schema, name ?? `${op.operationId}.response`, output) };
    roots.push({ codec, direction: 'response' });
    return { codec };
  }
  const only = output.fields[0];
  if (output.fields.length !== 1 || !only)
    throw new Error(`${op.operationId} : réponse ${output.name} à plusieurs champs`);
  const codec = codecs.codec(schema, only, `${op.operationId}.response`);
  roots.push({ codec, direction: 'response' });
  return { field: only.jsonName, codec, ...(nullable ? { nullable: true } : {}) };
}

function renderGaps(gaps: Gap[]): string[] {
  const byKind = new Map<string, Set<string>>();
  for (const gap of gaps) byKind.set(gap.kind, (byKind.get(gap.kind) ?? new Set()).add(gap.where));
  const lines = [
    '/**',
    ' * Appel gRPC de chaque route du Nettoyage et conversion entre le JSON du contrat REST et les messages',
    ' * de ksp.cleaning.v1 (chargés en camelCase, montants en nombres). Noms et types vérifiés à la',
    ' * génération ; écarts admis entre les deux contrats :',
  ];
  for (const kind of [...byKind.keys()].sort()) {
    const places = [...byKind.get(kind)!].sort();
    let line = ` * - ${kind} (${places.length}) :`;
    places.forEach((place, index) => {
      const item = ` ${place}${index === places.length - 1 ? '.' : ','}`;
      if (line.length + item.length > 106) {
        lines.push(line);
        line = ' *  ';
      }
      line += item;
    });
    lines.push(line);
  }
  lines.push(' */');
  return lines;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const files = await renderCleaningLayer();
  const stale: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const target = join(ROOT, path);
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // Fichier absent : à produire.
    }
    if (current === content) continue;
    if (check) stale.push(relative(ROOT, target).replace(/\\/g, '/'));
    else writeFileSync(target, content);
  }
  if (stale.length) {
    process.stderr.write(
      `Fichiers produits pas à jour (lancer « pnpm gateway:routes ») : ${stale.join(', ')}\n`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
