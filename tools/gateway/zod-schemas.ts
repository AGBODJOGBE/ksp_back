import { type OpenApiDocument, refName, type Schema } from './openapi';

/**
 * Traduction des schémas JSON des requêtes (paramètres et corps) en code zod, le mécanisme de
 * validation de la gateway. Seules les formes employées par le contrat sont prises en charge ; toute
 * autre forme arrête la génération plutôt que d'être validée à moitié.
 */

const KNOWN_KEYS = new Set([
  '$ref',
  'type',
  'format',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'dependentRequired',
  'oneOf',
  'anyOf',
  // Sans effet sur la validation : la valeur par défaut est appliquée par le service.
  'description',
  'default',
  'example',
]);

/** Formats de texte reconnus, et leur schéma zod (mêmes définitions que les corps écrits à la main). */
const FORMATS: Record<string, string> = {
  uuid: 'uuid',
  'date-time': 'dateTime',
  date: 'date',
};

/** Paramètre de chemin ou de requête : texte reçu, converti selon le type déclaré. */
export type ParameterKind = 'path' | 'query';

export class ZodEmitter {
  /** Composants déjà traduits, dans l'ordre où ils doivent être déclarés. */
  private readonly declared = new Map<string, string>();
  private readonly pending = new Set<string>();

  constructor(private readonly doc: OpenApiDocument) {}

  /** Déclarations des composants utilisés, chacune après celles dont elle dépend. */
  declarations(): string[] {
    return [...this.declared].map(([name, code]) => `const ${name} = ${code};`);
  }

  /** Nom de la constante d'un composant, traduit à la première utilisation. */
  component(name: string): string {
    if (this.declared.has(name)) return name;
    if (this.pending.has(name)) throw new Error(`Schéma récursif non pris en charge : ${name}`);
    const schema = this.doc.components.schemas[name];
    if (!schema) throw new Error(`Schéma introuvable : ${name}`);
    this.pending.add(name);
    const code = this.schema(schema, name);
    this.pending.delete(name);
    this.declared.set(name, code);
    return name;
  }

  /** Schéma d'un paramètre de chemin ou de requête : le texte reçu est converti avant validation. */
  parameter(schema: Schema, where: string): string {
    this.check(schema, where);
    if (schema.$ref) return this.component(refName(schema.$ref));
    const type = this.singleType(schema, where);
    if (type === 'integer' || type === 'number') return `numberParam(${this.number(schema, type)})`;
    if (type === 'boolean') return 'booleanParam';
    if (type !== 'string') throw new Error(`${where} : paramètre de type ${type} non pris en charge`);
    return this.schema(schema, where);
  }

  /** Expression zod d'un schéma. */
  schema(schema: Schema, where: string): string {
    this.check(schema, where);
    if (schema.$ref) {
      const others = Object.keys(schema).filter((key) => key !== '$ref' && key !== 'description');
      if (others.length)
        throw new Error(`${where} : mots-clés à côté d'une référence (${others.join(', ')})`);
      return this.component(refName(schema.$ref));
    }
    if (schema.anyOf) {
      const others = schema.anyOf.filter((branch) => branch.type !== 'null');
      if (others.length !== 1 || others.length === schema.anyOf.length) {
        throw new Error(`${where} : anyOf non pris en charge`);
      }
      return `${this.schema(others[0]!, where)}.nullable()`;
    }
    if (schema.oneOf) {
      const types = schema.oneOf.map((branch) => this.singleType(branch, where));
      // Branches de types différents : « une seule branche valide » revient à une union.
      if (new Set(types.map((type) => (type === 'integer' ? 'number' : type))).size !== types.length) {
        throw new Error(`${where} : oneOf aux branches de même type non pris en charge`);
      }
      return `z.union([${schema.oneOf.map((branch, index) => this.schema(branch, `${where}|${index}`)).join(', ')}])`;
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const nullable = types.includes('null') || (schema.enum?.includes(null) ?? false);
    const base = this.base({ ...schema, type: types.filter((type) => type !== 'null')[0] }, where);
    return nullable ? `${base}.nullable()` : base;
  }

  private base(schema: Schema, where: string): string {
    if (schema.const !== undefined) return `z.literal(${JSON.stringify(schema.const)})`;
    if (schema.enum) {
      const values = schema.enum.filter((value) => value !== null);
      if (!values.every((value) => typeof value === 'string')) {
        throw new Error(`${where} : énumération non textuelle`);
      }
      return `z.enum(${JSON.stringify(values)})`;
    }
    const type = this.singleType(schema, where);
    switch (type) {
      case 'string':
        return this.string(schema, where);
      case 'integer':
      case 'number':
        return this.number(schema, type);
      case 'boolean':
        return 'z.boolean()';
      case 'array':
        return this.array(schema, where);
      case 'object':
        return this.object(schema, where);
      default:
        throw new Error(`${where} : type ${type} non pris en charge`);
    }
  }

  private string(schema: Schema, where: string): string {
    let code = 'z.string()';
    if (schema.format) {
      code = FORMATS[schema.format] ?? '';
      if (!code) throw new Error(`${where} : format ${schema.format} non pris en charge`);
      if (schema.minLength !== undefined || schema.maxLength !== undefined || schema.pattern) {
        throw new Error(`${where} : longueur ou motif sur un format ${schema.format}`);
      }
      return code;
    }
    if (schema.minLength !== undefined) code += `.min(${schema.minLength})`;
    if (schema.maxLength !== undefined) code += `.max(${schema.maxLength})`;
    if (schema.pattern) code += `.regex(${regex(schema.pattern, where)})`;
    return code;
  }

  private number(schema: Schema, type: string): string {
    let code = type === 'integer' ? 'z.number().int()' : 'z.number()';
    if (schema.minimum !== undefined) code += `.min(${schema.minimum})`;
    if (schema.maximum !== undefined) code += `.max(${schema.maximum})`;
    return code;
  }

  private array(schema: Schema, where: string): string {
    if (!schema.items) throw new Error(`${where} : tableau sans items`);
    let code = `z.array(${this.schema(schema.items, `${where}[]`)})`;
    if (schema.minItems !== undefined) code += `.min(${schema.minItems})`;
    if (schema.maxItems !== undefined) code += `.max(${schema.maxItems})`;
    return schema.uniqueItems ? `unique(${code})` : code;
  }

  private object(schema: Schema, where: string): string {
    if (schema.properties) {
      if (schema.additionalProperties !== false) {
        throw new Error(`${where} : objet qui accepte des champs inconnus`);
      }
      const required = new Set(schema.required ?? []);
      for (const name of required) {
        if (!(name in schema.properties)) throw new Error(`${where} : champ obligatoire ${name} non décrit`);
      }
      const fields = Object.entries(schema.properties).map(([name, property]) => {
        const code = this.schema(property, `${where}.${name}`);
        return `${JSON.stringify(name)}: ${required.has(name) ? code : `${code}.optional()`}`;
      });
      const object = `z.strictObject({ ${fields.join(', ')} })`;
      return schema.dependentRequired
        ? `${object}.superRefine(dependentRequired(${JSON.stringify(schema.dependentRequired)}))`
        : object;
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const key = schema.propertyNames ? this.propertyName(schema.propertyNames, where) : 'z.string()';
      return `z.record(${key}, ${this.schema(schema.additionalProperties, `${where}{}`)})`;
    }
    throw new Error(`${where} : objet sans champs ni valeurs décrits`);
  }

  private propertyName(schema: Schema, where: string): string {
    const keys = Object.keys(schema);
    if (keys.length !== 1 || !schema.pattern) throw new Error(`${where} : propertyNames non pris en charge`);
    return `z.string().regex(${regex(schema.pattern, where)})`;
  }

  private singleType(schema: Schema, where: string): string {
    if (schema.$ref) return this.singleType(this.doc.components.schemas[refName(schema.$ref)]!, where);
    if (schema.enum || schema.const !== undefined) return 'string';
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
      (type) => type !== 'null',
    );
    if (types.length !== 1 || !types[0]) throw new Error(`${where} : type absent ou multiple`);
    return types[0];
  }

  private check(schema: Schema, where: string): void {
    const unknown = Object.keys(schema).filter((key) => !KNOWN_KEYS.has(key));
    if (unknown.length) throw new Error(`${where} : mots-clés non pris en charge (${unknown.join(', ')})`);
  }
}

/** Motif du contrat en expression régulière JavaScript (drapeau u, comme les validateurs JSON Schema). */
function regex(pattern: string, where: string): string {
  try {
    new RegExp(pattern, 'u');
  } catch {
    throw new Error(`${where} : motif invalide ${pattern}`);
  }
  return `/${pattern.replace(/\//g, '\\/')}/u`;
}
