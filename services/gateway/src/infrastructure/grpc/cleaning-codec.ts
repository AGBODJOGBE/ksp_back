import { type Json } from '../../application/common/api.ports';
import { type CleaningCall } from '../../application/cleaning/cleaning.ports';

/**
 * Conversion entre le JSON du contrat REST et les messages de ksp.cleaning.v1, tels que le client
 * gRPC les lit et les écrit (chargeur des .proto : champs en camelCase, entiers 64 bits en nombres,
 * champ facultatif absent → clé absente, message absent → null, oneof → clé discriminante). Les
 * tables viennent de cleaning-bindings.ts, produit depuis les deux contrats.
 */
export type Codec =
  /** Recopiée telle quelle : texte, nombre, booléen, montant { amount, currency }, liste de ceux-ci. */
  | 'value'
  /** Nombre, code de choix ou booléen en REST ; message ParameterValue (oneof) en gRPC. */
  | 'parameterValue'
  /** Objet : table nommée de CLEANING_MESSAGES. */
  | { message: string }
  | { list: Codec }
  /** Table : clé → valeur. */
  | { map: Codec }
  /** Tableau en REST ; en gRPC, message { <wrap>: [...] } : absent (inchangé) ≠ liste vide. */
  | { wrap: string; list: Codec };

export interface FieldCodec {
  /** Nom du champ gRPC, quand il diffère du nom REST (liste `data` → `items`…). */
  from?: string;
  codec?: Codec;
  /** Réponse : champ gRPC absent → null, ou champ omis. */
  absent?: 'null' | 'omit';
  /** Réponse : texte vide du champ gRPC (toujours présent) → null. */
  emptyAsNull?: true;
}

/** Champs d'un objet REST, dans l'ordre du contrat. */
export type MessageCodec = Readonly<Record<string, FieldCodec>>;

/** Appel gRPC d'une route : service et méthode de ksp.cleaning.v1, place de chaque donnée. */
export interface CleaningBinding {
  service: string;
  /** Méthode du client gRPC (camelCase). */
  method: string;
  /** Paramètre de chemin → champ du message (`id` → `placeId`…). */
  params?: Readonly<Record<string, string>>;
  /** En-tête Idempotency-Key transmis dans le champ idempotencyKey. */
  idempotencyKey?: boolean;
  /** Corps : ses champs sont ceux du message de la requête. */
  body?: Codec;
  /** Réponse : message entier, ou son seul champ `field` ; null : réponse sans corps (204). */
  response: { field?: string; codec: Codec; nullable?: boolean } | null;
}

export class CleaningCodec {
  constructor(private readonly messages: Readonly<Record<string, MessageCodec>>) {}

  /** Message de la requête : paramètres de chemin et de requête, clé d'idempotence, champs du corps. */
  request(binding: CleaningBinding, call: CleaningCall): Json {
    const message: Json = {};
    for (const [name, field] of Object.entries(binding.params ?? {})) message[field] = call.params[name];
    for (const [name, value] of Object.entries(call.query)) {
      if (value !== undefined) message[name] = value;
    }
    if (binding.idempotencyKey && call.idempotencyKey !== undefined) {
      message['idempotencyKey'] = call.idempotencyKey;
    }
    if (binding.body && call.body) Object.assign(message, this.toGrpc(call.body, binding.body));
    return message;
  }

  /** JSON de la réponse REST ; undefined pour une réponse sans corps. */
  response(binding: CleaningBinding, message: unknown): unknown {
    if (!binding.response) return undefined;
    const { field, codec } = binding.response;
    const value = field ? (message as Json | null | undefined)?.[field] : message;
    return value === undefined || value === null ? null : this.toRest(value, codec);
  }

  /** Valeur REST → valeur gRPC ; null ou absente : champ gRPC absent. */
  toGrpc(value: unknown, codec: Codec): unknown {
    if (value === null || value === undefined) return undefined;
    if (codec === 'value') return value;
    if (codec === 'parameterValue') {
      if (typeof value === 'number') return { number: value };
      if (typeof value === 'boolean') return { flag: value };
      return { choice: value };
    }
    if ('message' in codec) {
      const table = this.table(codec.message);
      const message: Json = {};
      for (const [name, inner] of Object.entries(value as Json)) {
        const field = table[name];
        // Valeur nulle : champ gRPC absent (le schéma ne l'admet que si le message sait le représenter).
        if (!field || inner === null || inner === undefined) continue;
        message[field.from ?? name] = this.toGrpc(inner, field.codec ?? 'value');
      }
      return message;
    }
    if ('map' in codec) {
      return Object.fromEntries(
        Object.entries(value as Json).map(([key, inner]) => [key, this.toGrpc(inner, codec.map)]),
      );
    }
    const items = (value as unknown[]).map((item) => this.toGrpc(item, codec.list));
    return 'wrap' in codec ? { [codec.wrap]: items } : items;
  }

  private toRest(value: unknown, codec: Codec): unknown {
    if (codec === 'value') return value;
    if (value === null || value === undefined) return null;
    if (codec === 'parameterValue') {
      const oneof = value as Json;
      // Clé discriminante du oneof (`value`), posée par le chargeur des .proto.
      const chosen = typeof oneof['value'] === 'string' ? oneof[oneof['value']] : undefined;
      return chosen ?? oneof['number'] ?? oneof['choice'] ?? oneof['flag'] ?? null;
    }
    if ('message' in codec) {
      const message = value as Json;
      const json: Json = {};
      for (const [name, field] of Object.entries(this.table(codec.message))) {
        const inner = message[field.from ?? name];
        if (inner === undefined || inner === null) {
          if (field.absent === 'omit') continue;
          json[name] = field.absent === 'null' ? null : empty(field.codec);
          continue;
        }
        json[name] = field.emptyAsNull && inner === '' ? null : this.toRest(inner, field.codec ?? 'value');
      }
      return json;
    }
    if ('map' in codec) {
      return Object.fromEntries(
        Object.entries(value as Json).map(([key, inner]) => [key, this.toRest(inner, codec.map)]),
      );
    }
    const items = 'wrap' in codec ? (value as Json)[codec.wrap] : value;
    return ((items as unknown[] | undefined) ?? []).map((item) => this.toRest(item, codec.list));
  }

  private table(name: string): MessageCodec {
    const table = this.messages[name];
    if (!table) throw new Error(`Table de conversion ${name} absente de cleaning-bindings.ts`);
    return table;
  }
}

/** Valeur d'un champ que le service n'a pas rempli alors que le contrat REST l'exige. */
function empty(codec: Codec | undefined): unknown {
  if (codec && typeof codec === 'object' && 'list' in codec) return [];
  if (codec && typeof codec === 'object' && 'map' in codec) return {};
  return null;
}
