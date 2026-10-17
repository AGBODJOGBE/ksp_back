import { AsyncLocalStorage } from 'node:async_hooks';
import { Metadata } from '@grpc/grpc-js';
import { v7 as uuidv7 } from 'uuid';

export type ScopeKind = 'global' | 'domain' | 'org' | 'personal';

export interface RoleClaim {
  role: string;
  scopeType: ScopeKind;
  scopeId?: string | null;
}

/** Contexte de l'utilisateur, posé par la gateway à partir du jeton d'accès vérifié. */
export interface UserContext {
  userId: string;
  sessionId: string;
  /** "personal" ou identifiant de l'organisation au nom de laquelle l'utilisateur agit (UC-ID-15). */
  activeContext: string;
  roles: RoleClaim[];
  mfa: boolean;
  /** Date de la dernière authentification forte, en secondes depuis 1970. */
  authTime?: number;
}

/** Client à l'origine de la requête, posé par la gateway (limites d'appels, sessions, historique). */
export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

export interface RequestContext {
  correlationId: string;
  /** Identifiant de l'événement qui a déclenché le traitement, s'il y en a un. */
  causationId?: string;
  user?: UserContext;
  client?: ClientInfo;
  /** Service appelant, connu après vérification de son jeton de service. */
  callerService?: string;
}

/** Noms des métadonnées gRPC transmises entre services. */
export const METADATA_KEYS = {
  correlationId: 'x-correlation-id',
  causationId: 'x-causation-id',
  userId: 'x-user-id',
  sessionId: 'x-session-id',
  activeContext: 'x-active-context',
  roles: 'x-user-roles',
  mfa: 'x-user-mfa',
  authTime: 'x-auth-time',
  clientIp: 'x-client-ip',
  userAgent: 'x-user-agent',
  authorization: 'authorization',
} as const;

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function newCorrelationId(): string {
  return uuidv7();
}

function first(metadata: Metadata, key: string): string | undefined {
  const value = metadata.get(key)[0];
  return value === undefined ? undefined : value.toString();
}

function parseRoles(raw: string | undefined): RoleClaim[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RoleClaim[]) : [];
  } catch {
    return [];
  }
}

/** Lit le contexte transmis par l'appelant. Crée un identifiant de corrélation s'il manque. */
export function contextFromMetadata(metadata: Metadata): RequestContext {
  const context: RequestContext = {
    correlationId: first(metadata, METADATA_KEYS.correlationId) ?? newCorrelationId(),
  };
  const causationId = first(metadata, METADATA_KEYS.causationId);
  if (causationId) context.causationId = causationId;

  const userId = first(metadata, METADATA_KEYS.userId);
  if (userId) {
    const authTime = first(metadata, METADATA_KEYS.authTime);
    context.user = {
      userId,
      sessionId: first(metadata, METADATA_KEYS.sessionId) ?? '',
      activeContext: first(metadata, METADATA_KEYS.activeContext) ?? 'personal',
      roles: parseRoles(first(metadata, METADATA_KEYS.roles)),
      mfa: first(metadata, METADATA_KEYS.mfa) === 'true',
      ...(authTime ? { authTime: Number(authTime) } : {}),
    };
  }

  const ip = first(metadata, METADATA_KEYS.clientIp);
  const userAgent = first(metadata, METADATA_KEYS.userAgent);
  if (ip || userAgent) {
    context.client = { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) };
  }
  return context;
}

/** Construit les métadonnées à transmettre au service appelé, à partir du contexte courant. */
export function metadataFromContext(context: RequestContext | undefined = currentContext()): Metadata {
  const metadata = new Metadata();
  metadata.set(METADATA_KEYS.correlationId, context?.correlationId ?? newCorrelationId());
  if (context?.causationId) metadata.set(METADATA_KEYS.causationId, context.causationId);
  const user = context?.user;
  if (user) {
    metadata.set(METADATA_KEYS.userId, user.userId);
    metadata.set(METADATA_KEYS.sessionId, user.sessionId);
    metadata.set(METADATA_KEYS.activeContext, user.activeContext);
    metadata.set(METADATA_KEYS.roles, JSON.stringify(user.roles));
    metadata.set(METADATA_KEYS.mfa, String(user.mfa));
    if (user.authTime !== undefined) metadata.set(METADATA_KEYS.authTime, String(user.authTime));
  }
  if (context?.client?.ip) metadata.set(METADATA_KEYS.clientIp, context.client.ip);
  if (context?.client?.userAgent) metadata.set(METADATA_KEYS.userAgent, context.client.userAgent);
  return metadata;
}
