/**
 * Lecture du contrat OpenAPI pour le générateur de la gateway : opérations, références et
 * valeurs nulles, dans la forme que le contrat emploie (OpenAPI 3.1, JSON Schema 2020-12).
 */

export type Json = Record<string, unknown>;

/** Schéma JSON tel qu'il est écrit dans le contrat (sous-ensemble lu par le générateur). */
export interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  propertyNames?: Schema;
  dependentRequired?: Record<string, string[]>;
  oneOf?: Schema[];
  anyOf?: Schema[];
  description?: string;
  default?: unknown;
  example?: unknown;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: Schema;
  $ref?: string;
}

export interface Operation {
  operationId: string;
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, { $ref?: string; content?: Record<string, { schema: Schema }> }>;
  [extension: `x-ksp-${string}`]: unknown;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, Operation | Parameter[]>>;
  components: { schemas: Record<string, Schema>; parameters: Record<string, Parameter> };
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export interface ContractOperation {
  method: Uppercase<(typeof HTTP_METHODS)[number]>;
  path: string;
  op: Operation;
}

/** Opérations du contrat, dans l'ordre du fichier. */
export function operationsOf(doc: OpenApiDocument): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => ({
      method: method.toUpperCase() as ContractOperation['method'],
      path,
      op: item[method] as Operation,
    })),
  );
}

/** Nom du composant désigné par une référence locale (#/components/schemas/Nom). */
export function refName(ref: string): string {
  const match = /^#\/components\/(schemas|parameters)\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!match) throw new Error(`Référence non prise en charge : ${ref}`);
  return match[2]!;
}

export function resolveParameter(doc: OpenApiDocument, parameter: Parameter): Parameter {
  if (!parameter.$ref) return parameter;
  const found = doc.components.parameters[refName(parameter.$ref)];
  if (!found) throw new Error(`Paramètre introuvable : ${parameter.$ref}`);
  return found;
}

export function resolveSchema(doc: OpenApiDocument, schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const found = doc.components.schemas[refName(schema.$ref)];
  if (!found) throw new Error(`Schéma introuvable : ${schema.$ref}`);
  return resolveSchema(doc, found);
}

/**
 * Schéma sans sa valeur nulle : `anyOf: [X, {type: null}]`, `type: [t, null]` ou `null` dans un
 * `enum`. `name` : composant désigné, quand le schéma est une référence.
 */
export interface Unwrapped {
  schema: Schema;
  nullable: boolean;
  name?: string;
}

export function withoutNull(doc: OpenApiDocument, input: Schema): Unwrapped {
  let schema = input;
  let nullable = false;
  if (schema.anyOf) {
    const others = schema.anyOf.filter((branch) => branch.type !== 'null');
    if (others.length !== 1 || others.length === schema.anyOf.length) {
      throw new Error(`anyOf non pris en charge : ${JSON.stringify(schema.anyOf)}`);
    }
    schema = others[0]!;
    nullable = true;
  }
  const name = schema.$ref ? refName(schema.$ref) : undefined;
  schema = resolveSchema(doc, schema);
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type) => type !== 'null');
    nullable ||= types.length < schema.type.length;
    // Plusieurs types restants (valeur simple : nombre, texte ou booléen) : gardés en liste.
    schema = { ...schema, type: types.length === 1 ? types[0]! : types };
  }
  if (schema.enum?.includes(null)) {
    schema = { ...schema, enum: schema.enum.filter((value) => value !== null) };
    nullable = true;
  }
  return { schema, nullable, ...(name ? { name } : {}) };
}

/** Schéma du corps JSON d'une réponse, ou null pour une réponse sans corps. */
export function responseSchema(op: Operation, status: string): Schema | null {
  const response = op.responses[status];
  if (!response) return null;
  const content = response.content?.['application/json'];
  return content ? content.schema : null;
}
