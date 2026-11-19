import { type OpenApiDocument, type Schema, withoutNull } from './openapi';
import { type ProtoField, type ProtoFile, type ProtoMessage, SCALAR_TYPES } from './proto';

/**
 * Correspondance entre le JSON de l'API REST et les messages gRPC, vérifiée champ par champ : mêmes
 * noms (camelCase des deux côtés), types compatibles, valeur nulle possible seulement quand le champ
 * gRPC peut être absent. Les écarts admis sont nommés (voir Codec) et relevés ; tout autre écart
 * arrête la génération. Le résultat est une table de conversion lue par l'adaptateur gRPC.
 */

/** Même forme que le type Codec de services/gateway/src/infrastructure/grpc/cleaning-codec.ts. */
export type Codec =
  | 'value'
  | 'parameterValue'
  | { message: string }
  | { list: Codec }
  | { map: Codec }
  | { wrap: string; list: Codec };

export interface FieldCodec {
  /** Nom du champ gRPC, quand il diffère du nom REST. */
  from?: string;
  codec?: Codec;
  /** Réponse : champ gRPC absent → null, ou champ omis. */
  absent?: 'null' | 'omit';
  /** Réponse : texte vide du champ gRPC (toujours présent) → null. */
  emptyAsNull?: true;
}

export type MessageCodec = Record<string, FieldCodec>;

export type Direction = 'request' | 'response';

/** Écart admis entre les deux contrats, relevé pour la documentation du fichier produit. */
export interface Gap {
  kind: string;
  where: string;
}

/** Message commun des montants : même forme des deux côtés ({ amount, currency }). */
const MONEY = 'ksp.common.v1.Money';
const INTEGER_TYPES = new Set([
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
]);

interface Table {
  codec: MessageCodec;
  /** Écarts propres à un sens : refusés seulement si la table sert dans ce sens. */
  problems: Record<Direction, string[]>;
  gaps: Record<Direction, Gap[]>;
}

export class CodecBuilder {
  private readonly tables = new Map<string, Table>();
  /** Composant REST → message gRPC auquel il a été associé (un composant, un message). */
  private readonly bound = new Map<string, string>();

  constructor(
    private readonly doc: OpenApiDocument,
    private readonly proto: ProtoFile,
  ) {}

  message(name: string): ProtoMessage {
    const found = this.proto.messages.get(name);
    if (!found) throw new Error(`Message gRPC introuvable : ${name}`);
    return found;
  }

  /**
   * Tables employées depuis ces conversions racines (corps, réponses), dans un ordre stable ; arrête la
   * génération si l'une d'elles a un écart refusé dans le sens où elle sert.
   */
  finish(roots: { codec: Codec; direction: Direction }[]): {
    messages: Map<string, MessageCodec>;
    gaps: Gap[];
  } {
    const used = new Map<string, Set<Direction>>();
    const visit = (codec: Codec | undefined, direction: Direction): void => {
      if (!codec || typeof codec === 'string') return;
      if ('message' in codec) {
        const seen = used.get(codec.message) ?? new Set<Direction>();
        if (seen.has(direction)) return;
        seen.add(direction);
        used.set(codec.message, seen);
        for (const field of Object.values(this.tables.get(codec.message)!.codec))
          visit(field.codec, direction);
      } else if ('map' in codec) visit(codec.map, direction);
      else visit(codec.list, direction);
    };
    for (const root of roots) visit(root.codec, root.direction);

    const problems: string[] = [];
    const gaps: Gap[] = [];
    const messages = new Map<string, MessageCodec>();
    for (const name of [...used.keys()].sort()) {
      const table = this.tables.get(name)!;
      for (const direction of used.get(name)!) {
        problems.push(...table.problems[direction]);
        gaps.push(...table.gaps[direction]);
      }
      messages.set(name, table.codec);
    }
    if (problems.length) throw new Error(`Écarts entre l'API REST et le proto :\n- ${problems.join('\n- ')}`);
    return { messages, gaps };
  }

  /** Conversion d'une valeur, d'après le schéma REST et le type du champ gRPC. */
  codec(value: Schema, field: Pick<ProtoField, 'type' | 'label'>, where: string, table?: Table): Codec {
    const { schema, name } = withoutNull(this.doc, value);
    if (field.label === 'repeated') {
      if (schema.type !== 'array' || !schema.items)
        throw new Error(`${where} : liste gRPC, pas de tableau REST`);
      const item = this.codec(schema.items, { type: field.type, label: 'single' }, `${where}[]`, table);
      return item === 'value' ? 'value' : { list: item };
    }
    if (field.label === 'map') {
      if (schema.type !== 'object' || schema.properties || typeof schema.additionalProperties !== 'object') {
        throw new Error(`${where} : table gRPC, pas de table REST`);
      }
      const entry = this.codec(
        schema.additionalProperties,
        { type: field.type, label: 'single' },
        `${where}{}`,
        table,
      );
      return entry === 'value' ? 'value' : { map: entry };
    }
    if (SCALAR_TYPES.has(field.type)) {
      this.scalar(schema, field.type, where);
      return 'value';
    }
    if (field.type === MONEY) {
      // Money ou montant saisi (CleaningAmountInput) : { amount: entier, currency: "XOF" } des deux côtés.
      const amount = schema.properties?.['amount'];
      const currency = schema.properties?.['currency'];
      const same =
        Object.keys(schema.properties ?? {}).length === 2 &&
        amount?.type === 'integer' &&
        (currency?.const === 'XOF' || currency?.type === 'string');
      if (!same) throw new Error(`${where} : montant gRPC, pas de montant REST { amount, currency }`);
      return 'value';
    }
    const message = this.message(field.type);
    if (isParameterValue(message)) {
      if (!schema.oneOf && !Array.isArray(schema.type)) {
        throw new Error(`${where} : ${message.name} attend un nombre, un code ou un booléen`);
      }
      this.gap(
        table,
        'both',
        'valeur simple en REST (nombre, code, booléen), message ParameterValue en gRPC',
        where,
      );
      return 'parameterValue';
    }
    if (schema.type === 'array') {
      // Liste enveloppée : en gRPC, un message absent (inchangé) se distingue d'une liste vide.
      const only = message.fields[0];
      if (message.fields.length !== 1 || only?.label !== 'repeated') {
        throw new Error(`${where} : tableau REST en face du message ${message.name}`);
      }
      this.gap(table, 'both', `tableau en REST, message ${message.name} en gRPC`, where);
      const items = this.codec(value, only, where, table);
      return { wrap: only.jsonName, list: items === 'value' ? 'value' : (items as { list: Codec }).list };
    }
    return { message: this.object(schema, name ?? where, message) };
  }

  /**
   * Table de conversion d'un objet REST et d'un message gRPC ; `name` la nomme (composant REST, ou
   * emplacement d'un schéma écrit sur place).
   */
  object(schema: Schema, name: string, message: ProtoMessage): string {
    const key =
      this.bound.has(name) && this.bound.get(name) !== message.name ? `${name}~${message.name}` : name;
    if (this.tables.has(key)) return key;
    this.bound.set(name, message.name);
    const table: Table = {
      codec: {},
      problems: { request: [], response: [] },
      gaps: { request: [], response: [] },
    };
    this.tables.set(key, table);

    const { schema: object } = withoutNull(this.doc, schema);
    if (object.type !== 'object' || !object.properties) {
      throw new Error(`${key} : objet attendu en face du message ${message.name}`);
    }
    const required = new Set(object.required ?? []);
    const fields = new Map(message.fields.map((field) => [field.jsonName, field]));
    const used = new Set<string>();
    for (const [property, value] of Object.entries(object.properties)) {
      const where = `${key}.${property}`;
      const field = fields.get(property) ?? this.listField(property, value, message, object, table);
      if (!field) throw new Error(`${where} : champ absent du message ${message.name}`);
      used.add(field.jsonName);
      table.codec[property] = this.field(property, value, field, required.has(property), where, table);
    }
    for (const field of message.fields) {
      if (!used.has(field.jsonName)) {
        this.gap(table, 'response', 'champ gRPC non exposé en REST', `${message.name}.${field.jsonName}`);
      }
    }
    return key;
  }

  /**
   * Liste `data` des réponses REST (pages, listes) : en gRPC, l'unique champ répété du message
   * (`items`, `categories`…).
   */
  private listField(
    property: string,
    value: Schema,
    message: ProtoMessage,
    object: Schema,
    table: Table,
  ): ProtoField | undefined {
    if (property !== 'data' || withoutNull(this.doc, value).schema.type !== 'array') return undefined;
    const lists = message.fields.filter(
      (field) => field.label === 'repeated' && !(field.jsonName in (object.properties ?? {})),
    );
    if (lists.length !== 1) return undefined;
    this.gap(
      table,
      'both',
      'liste « data » en REST, champ répété nommé en gRPC',
      `${message.name}.${lists[0]!.jsonName}`,
    );
    return lists[0];
  }

  private field(
    property: string,
    value: Schema,
    field: ProtoField,
    required: boolean,
    where: string,
    table: Table,
  ): FieldCodec {
    const { nullable } = withoutNull(this.doc, value);
    const absentable = field.label === 'optional' || field.oneof !== undefined || isMessage(field);
    const result: FieldCodec = {};
    if (field.jsonName !== property) result.from = field.jsonName;
    const codec = this.codec(value, field, where, table);
    if (codec !== 'value') result.codec = codec;

    // Requête : une valeur nulle devient un champ gRPC absent, si le message sait le représenter.
    if (nullable && !absentable && field.label === 'single') {
      table.problems.request.push(`${where} : null accepté en REST, champ gRPC toujours présent`);
    }
    // Réponse : champ gRPC absent → null ou champ omis, selon le schéma REST.
    if (absentable) {
      if (nullable) result.absent = 'null';
      else if (!required) result.absent = 'omit';
      else if (field.label === 'optional') {
        table.problems.response.push(`${where} : obligatoire en REST, facultatif en gRPC`);
      }
    } else if (nullable && field.label === 'single') {
      if (field.type === 'string') {
        // Texte toujours présent en gRPC : le texte vide tient lieu de null (curseur de fin…).
        result.emptyAsNull = true;
        this.gap(table, 'response', 'texte vide en gRPC, null en REST', where);
      } else {
        table.problems.response.push(`${where} : null possible en REST, champ gRPC toujours présent`);
      }
    }
    return result;
  }

  private scalar(schema: Schema, type: string, where: string): void {
    const rest = schema.const !== undefined || schema.enum ? 'string' : (schema.type as string | undefined);
    const ok =
      (rest === 'string' && type === 'string') ||
      (rest === 'boolean' && type === 'bool') ||
      (rest === 'integer' && (INTEGER_TYPES.has(type) || type === 'double')) ||
      (rest === 'number' && (type === 'double' || type === 'float'));
    if (!ok) throw new Error(`${where} : ${rest ?? 'type inconnu'} en REST, ${type} en gRPC`);
  }

  private gap(table: Table | undefined, direction: Direction | 'both', kind: string, where: string): void {
    const directions: Direction[] = direction === 'both' ? ['request', 'response'] : [direction];
    for (const each of directions) {
      if (table) table.gaps[each].push({ kind, where });
      else this.rootGaps[each].push({ kind, where });
    }
  }

  /** Écarts relevés hors de toute table (valeur racine d'une requête ou d'une réponse). */
  readonly rootGaps: Record<Direction, Gap[]> = { request: [], response: [] };
}

function isMessage(field: ProtoField): boolean {
  return field.label === 'single' && !SCALAR_TYPES.has(field.type);
}

/** Message dont les champs forment un seul oneof de valeurs simples (ParameterValue). */
function isParameterValue(message: ProtoMessage): boolean {
  const groups = new Set(message.fields.map((field) => field.oneof));
  return (
    message.fields.length > 1 &&
    groups.size === 1 &&
    !groups.has(undefined) &&
    message.fields.every((field) => SCALAR_TYPES.has(field.type))
  );
}
