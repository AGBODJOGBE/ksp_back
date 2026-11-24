/**
 * Lecture minimale d'un fichier .proto (proto3) pour le générateur de la gateway : messages, champs,
 * services et méthodes. Le contrat est écrit dans une forme régulière (un champ par ligne, aucun
 * message imbriqué, aucune énumération) ; toute autre forme est refusée plutôt que mal lue.
 */

export interface ProtoField {
  /** Nom dans le .proto (snake_case). */
  name: string;
  /** Nom vu par le client gRPC de la gateway (camelCase, option keepCase: false du chargeur). */
  jsonName: string;
  /** Type du champ ; pour une table, type des valeurs. Types d'un autre paquet : nom complet. */
  type: string;
  label: 'single' | 'optional' | 'repeated' | 'map';
  /** Groupe oneof déclaré, s'il y en a un. */
  oneof?: string;
}

export interface ProtoMessage {
  name: string;
  fields: ProtoField[];
}

export interface ProtoMethod {
  name: string;
  input: string;
  output: string;
}

export interface ProtoFile {
  package: string;
  messages: Map<string, ProtoMessage>;
  services: Map<string, ProtoMethod[]>;
}

export const SCALAR_TYPES = new Set([
  'string',
  'bool',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'double',
  'float',
  'bytes',
]);

const FIELD = /^(optional |repeated )?([A-Za-z0-9_.]+) ([a-z][a-z0-9_]*) = \d+;$/;
const MAP_FIELD = /^map<string, ([A-Za-z0-9_.]+)> ([a-z][a-z0-9_]*) = \d+;$/;
const RPC = /^rpc ([A-Z]\w*)\(([A-Za-z0-9_.]+)\) returns \(([A-Za-z0-9_.]+)\);$/;

/** snake_case → camelCase, comme le chargeur des .proto de grpc-js. */
export function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

export function parseProto(source: string, file: string): ProtoFile {
  const proto: ProtoFile = { package: '', messages: new Map(), services: new Map() };
  let message: ProtoMessage | null = null;
  let service: ProtoMethod[] | null = null;
  let oneof: string | null = null;

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const fail = (reason: string): never => {
      throw new Error(`${file}:${index + 1} : ${reason} (« ${raw.trim()} »)`);
    };
    if (!line) return;
    if (oneof !== null) {
      if (line === '}') {
        oneof = null;
        return;
      }
      const match = FIELD.exec(line);
      if (!match || match[1]) fail('champ de oneof inattendu');
      message!.fields.push(field('single', match![2]!, match![3]!, oneof));
      return;
    }
    if (message) {
      if (line === '}') {
        proto.messages.set(message.name, message);
        message = null;
        return;
      }
      const group = /^oneof ([a-z_]+) \{$/.exec(line);
      if (group) {
        oneof = group[1]!;
        return;
      }
      const map = MAP_FIELD.exec(line);
      if (map) {
        message.fields.push(field('map', map[1]!, map[2]!));
        return;
      }
      const match = FIELD.exec(line) ?? fail('champ non reconnu');
      const label = match[1]?.trim() as 'optional' | 'repeated' | undefined;
      message.fields.push(field(label ?? 'single', match[2]!, match[3]!));
      return;
    }
    if (service) {
      if (line === '}') {
        service = null;
        return;
      }
      const rpc = RPC.exec(line) ?? fail('méthode non reconnue');
      service.push({ name: rpc[1]!, input: rpc[2]!, output: rpc[3]! });
      return;
    }
    const pkg = /^package ([a-z0-9.]+);$/.exec(line);
    if (pkg) {
      proto.package = pkg[1]!;
      return;
    }
    const start = /^message ([A-Z]\w*) \{(\})?$/.exec(line);
    if (start) {
      if (start[2]) proto.messages.set(start[1]!, { name: start[1]!, fields: [] });
      else message = { name: start[1]!, fields: [] };
      return;
    }
    const svc = /^service ([A-Z]\w*) \{$/.exec(line);
    if (svc) {
      service = [];
      proto.services.set(svc[1]!, service);
      return;
    }
    if (/^(syntax|import|option) /.test(line)) return;
    fail('déclaration non reconnue');
  });
  return proto;
}

function field(label: ProtoField['label'], type: string, name: string, oneof?: string): ProtoField {
  return { name, jsonName: camelCase(name), type, label, ...(oneof ? { oneof } : {}) };
}
