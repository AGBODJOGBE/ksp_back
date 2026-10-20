import { type ClientInfo, type VerifiedAccessToken } from '@ksp/platform';
import { type ClientKind } from '../../domain/client/client-kind';
import { type RouteDefinition } from '../../domain/routing/route-manifest';

/** Requête HTTP telle que la gateway la lit (sous-ensemble de la requête Express). */
export interface GatewayRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  body?: unknown;
  socket?: { remoteAddress?: string };
  /** Posé par le premier middleware, pour toute la durée de la requête. */
  correlationId?: string;
  /** Résultat des contrôles d'accès de la route (RouteGuard). */
  gateway?: {
    route: RouteDefinition;
    clientKind: ClientKind | null;
    caller: VerifiedAccessToken | null;
  };
}

/** Réponse HTTP telle que la gateway l'écrit (sous-ensemble de la réponse Express). */
export interface GatewayResponse {
  headersSent: boolean;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  status(code: number): GatewayResponse;
  json(body: unknown): unknown;
}

export type Next = (error?: unknown) => void;

/** Première valeur d'un en-tête. */
export function header(request: GatewayRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const MAX_USER_AGENT = 512;

/**
 * Adresse IP et appareil du client, transmis à identity (x-client-ip, x-user-agent).
 * L'adresse vient du réglage « trust proxy » : seuls les mandataires de confiance sont crus.
 */
export function clientInfo(request: GatewayRequest): ClientInfo & { ip: string } {
  const userAgent = header(request, 'user-agent')?.slice(0, MAX_USER_AGENT);
  return {
    ip: request.ip ?? request.socket?.remoteAddress ?? 'unknown',
    ...(userAgent ? { userAgent } : {}),
  };
}
