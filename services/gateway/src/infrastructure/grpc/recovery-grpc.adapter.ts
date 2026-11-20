import { type Metadata } from '@grpc/grpc-js';
import { type recoveryV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { type Json } from '../../application/cleaning/cleaning.ports';
import {
  type RecoveryApi,
  type RecoveryOperationId,
  type RecoveryRequest,
} from '../../application/recovery/recovery.ports';
import { RECOVERY_OPERATIONS, type RecoveryClientName } from './recovery-operations';
import { RECOVERY_SHAPES, type RecoveryShapeName } from './recovery-shapes';
import { toUpstreamError } from './upstream-error';

/** Session du débiteur transmise à recovery (ADR-061), jamais journalisée. */
export const DEBTOR_SESSION_METADATA = 'x-debtor-session';

/** Réponse de recovery qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de recovery inattendue (${what}).`);

/** Montant : devise reprise de recovery (XOF par défaut), comme pour payment et wallet. */
const money = (value: unknown) => {
  const source = value as { amount?: unknown; currency?: unknown } | null | undefined;
  return {
    amount: Number(source?.amount ?? 0),
    currency: typeof source?.currency === 'string' && source.currency !== '' ? source.currency : 'XOF',
  };
};

/** Valeur d'un champ selon sa forme du contrat (recovery-shapes.ts). */
function presentValue(kind: string, value: unknown): unknown {
  if (kind.startsWith('[]')) {
    return (Array.isArray(value) ? value : []).map((item) => presentValue(kind.slice(2), item));
  }
  const nullable = kind.endsWith('?');
  const base = nullable ? kind.slice(0, -1) : kind;
  const absent = value === undefined || value === null;
  if (base.startsWith('#')) {
    if (absent) {
      if (nullable) return null;
      throw malformed(base.slice(1));
    }
    return present(base.slice(1) as RecoveryShapeName, value);
  }
  switch (base) {
    case 'str':
      if (nullable) return typeof value === 'string' && value !== '' ? value : null;
      return typeof value === 'string' ? value : '';
    case 'int': {
      const number = Number(value ?? 0);
      return nullable && (absent || number < 0) ? null : number;
    }
    case 'bool':
      return Boolean(value);
    case 'money':
      return nullable && absent ? null : money(value);
    case 'map':
      return absent ? {} : { ...(value as object) };
    default:
      throw malformed(`forme ${kind}`);
  }
}

/** Traduction d'un message ksp.recovery.v1 vers le JSON du contrat : seuls ses champs sortent. */
export function present(shape: RecoveryShapeName, value: unknown): Json {
  const source = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(RECOVERY_SHAPES[shape]).map(([field, kind]) => [field, presentValue(kind, source[field])]),
  );
}

/** Retire les null du corps : un champ absent garde la valeur par défaut du message gRPC. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== null && inner !== undefined)
        .map(([key, inner]) => [key, withoutNulls(inner)]),
    );
  }
  return value;
}

/** Range une valeur dans la demande gRPC (`filter.search`, `page.limit`, `statuses[]`). */
function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const list = path.endsWith('[]');
  const keys = (list ? path.slice(0, -2) : path).split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
  node[keys.at(-1)!] = list ? [value] : value;
}

type RecoveryClients = Record<RecoveryClientName, object>;
type UnaryCall = (request: unknown, metadata: Metadata) => Observable<unknown>;

/**
 * Client gRPC de recovery : délai, coupe-circuit et jeton de service par GrpcCaller. Chaque route
 * est traduite par sa ligne de RECOVERY_OPERATIONS ; seules les lectures sont rejouées. Ni le
 * jeton du lien du débiteur, ni sa session, ni ses coordonnées ne sont journalisés.
 */
export class RecoveryGrpcAdapter implements RecoveryApi {
  private readonly logger = new Logger('RecoveryGrpc');

  constructor(
    private readonly clients: {
      creditor: recoveryV1.RecoveryCreditorServiceClient;
      debtor: recoveryV1.RecoveryDebtorServiceClient;
      partner: recoveryV1.RecoveryPartnerServiceClient;
      admin: recoveryV1.RecoveryAdminServiceClient;
    },
    private readonly caller: GrpcCaller,
  ) {}

  async call(operationId: RecoveryOperationId, request: RecoveryRequest): Promise<Json> {
    const operation = RECOVERY_OPERATIONS[operationId];
    const message: Record<string, unknown> = {};
    // Corps d'abord : un champ du corps ne remplace jamais un paramètre du chemin ou de la requête.
    if (operation.body === 'spread') Object.assign(message, withoutNulls(request.body ?? {}));
    else if (operation.body) message[operation.body] = withoutNulls(request.body ?? {});
    for (const [param, field] of Object.entries(operation.path ?? {}))
      message[field] = request.params?.[param];
    for (const [name, value] of Object.entries(request.query ?? {})) {
      const target = operation.query?.[name];
      if (target && value !== undefined) assign(message, target, value);
    }
    if (operation.idempotencyKey && request.idempotencyKey)
      message['idempotencyKey'] = request.idempotencyKey;

    const client = (this.clients as RecoveryClients)[operation.client] as Record<string, UnaryCall>;
    const invoke = client[operation.method];
    if (!invoke) throw malformed(`méthode ${operation.method}`);
    const response = (await this.send(operation.method, operation.idempotent ?? false, (metadata) => {
      if (request.debtorSession) metadata.set(DEBTOR_SESSION_METADATA, request.debtorSession);
      return invoke.call(client, message, metadata);
    })) as Record<string, unknown>;

    if (operation.unwrap === 'settingsView') {
      const settings = response['settings'] as Record<string, unknown> | null | undefined;
      if (!settings) throw malformed('réglages');
      return present(operation.shape, {
        settings,
        updatedAt: settings['updatedAt'],
        updatedBy: settings['updatedBy'],
      });
    }
    const value = operation.unwrap ? response[operation.unwrap] : response;
    if (value === undefined || value === null) throw malformed(operation.unwrap ?? operation.method);
    const result = present(operation.shape, value);
    return operation.withoutInternalEntries ? this.withoutInternalEntries(operation.method, result) : result;
  }

  /** Journal du créancier : une note interne rendue par recovery est retirée et signalée. */
  private withoutInternalEntries(method: string, page: Json): Json {
    const entries = page['entries'] as Json[];
    const visible = entries.filter((entry) => entry['internal'] !== true);
    if (visible.length === entries.length) return page;
    this.logger.warn(`recovery.${method} : ${entries.length - visible.length} note(s) interne(s) retirée(s)`);
    return { ...page, entries: visible };
  }

  private async send(
    name: string,
    idempotent: boolean,
    invoke: (metadata: Metadata) => Observable<unknown>,
  ): Promise<unknown> {
    try {
      return await this.caller.call(name, invoke, { idempotent });
    } catch (error) {
      const upstream = toUpstreamError('recovery', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`recovery.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
