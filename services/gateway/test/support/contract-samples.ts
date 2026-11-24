/**
 * Valeurs construites depuis un schéma du contrat OpenAPI, pour les tests qui couvrent toutes les
 * routes du Nettoyage : la plus petite valeur valide (champs obligatoires seulement), ou complète
 * (tous les champs, sans null) pour exercer chaque conversion.
 */
type Json = Record<string, unknown>;

export interface SchemaNode {
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
  items?: SchemaNode;
  minItems?: number;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
}

export const SAMPLE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1001';

/** Textes essayés, dans l'ordre, contre le motif d'un champ. */
const CANDIDATES = [
  'texte',
  'abc_def',
  'cotonou',
  'cleaning.request.read',
  '09:00',
  '+22901970000',
  'weekly',
  'abcdefgh',
];

export class ContractSampler {
  constructor(private readonly components: Record<string, SchemaNode>) {}

  /** `full` : tous les champs décrits, sinon les seuls champs obligatoires. */
  sample(schema: SchemaNode, full = false, depth = 0): unknown {
    if (depth > 40) throw new Error('Schéma trop profond (récursif ?) pour un exemple');
    if (schema.$ref) return this.sample(this.component(schema.$ref), full, depth + 1);
    if (schema.anyOf)
      return this.sample(
        schema.anyOf.find((branch) => branch.type !== 'null')!,
        full,
        depth + 1,
      );
    if (schema.oneOf) return this.sample(schema.oneOf[0]!, full, depth + 1);
    if (schema.const !== undefined) return schema.const;
    if (schema.enum) return schema.enum.find((value) => value !== null);
    const types = Array.isArray(schema.type) ? schema.type.filter((type) => type !== 'null') : [schema.type];
    switch (types[0]) {
      case 'string':
        return this.text(schema);
      case 'integer':
      case 'number':
        return Math.min(Math.max(schema.minimum ?? 1, 1), schema.maximum ?? Infinity);
      case 'boolean':
        return true;
      case 'array': {
        const count = Math.max(schema.minItems ?? 0, full ? 1 : 0);
        return Array.from({ length: count }, () => this.sample(schema.items!, full, depth + 1));
      }
      case 'object': {
        if (!schema.properties) {
          const value = schema.additionalProperties;
          return full && value && typeof value === 'object'
            ? { abc_def: this.sample(value, full, depth + 1) }
            : {};
        }
        const required = new Set(schema.required ?? []);
        const json: Json = {};
        for (const [name, property] of Object.entries(schema.properties)) {
          if (full || required.has(name)) json[name] = this.sample(property, full, depth + 1);
        }
        return json;
      }
      default:
        throw new Error(`Type sans exemple : ${JSON.stringify(schema)}`);
    }
  }

  private text(schema: SchemaNode): string {
    if (schema.format === 'uuid') return SAMPLE_ID;
    if (schema.format === 'date-time') return '2026-12-01T09:00:00.000Z';
    if (schema.format === 'date') return '2026-12-01';
    if (schema.format === 'uri') return 'https://files.ksp.bj/objet';
    const fits = (value: string) =>
      value.length >= (schema.minLength ?? 0) &&
      value.length <= (schema.maxLength ?? Infinity) &&
      (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
    const found = CANDIDATES.find(fits);
    if (!found) throw new Error(`Aucun exemple pour le motif ${schema.pattern ?? ''}`);
    return found;
  }

  private component(ref: string): SchemaNode {
    const name = ref.replace('#/components/schemas/', '');
    const found = this.components[name];
    if (!found) throw new Error(`Schéma introuvable : ${ref}`);
    return found;
  }
}
