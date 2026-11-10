import { AppError, type VerifiedAccessToken } from '@ksp/platform';
import { checkAccess } from '../../domain/access/access-policy';
import { type ClientKind, type ClientOrigins, resolveClientKind } from '../../domain/client/client-kind';
import {
  authenticatedIpKey,
  DEFAULT_AUTHENTICATED_IP_LIMIT,
  rateLimitKey,
  type RateLimitTable,
} from '../../domain/rate-limit/rate-limits';
import { type RouteDefinition } from '../../domain/routing/route-manifest';
import { type AccessTokenVerifierPort, type Clock, type RateLimiter } from './access.ports';

export interface IncomingRequest {
  ip: string;
  /** En-tête Authorization brut. */
  authorization?: string | undefined;
  origin?: string | undefined;
  appVersion?: string | undefined;
  /** En-tête Idempotency-Key brut. */
  idempotencyKey?: string | undefined;
}

export interface AuthorizedRequest {
  clientKind: ClientKind | null;
  /** Jeton d'accès vérifié, pour les routes connectées. */
  caller: VerifiedAccessToken | null;
}

/** Format d'une clé d'idempotence, le même pour toutes les routes. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Contrôles de la gateway avant tout appel à un service (UC-GW-02, 03, 04) :
 * limite par adresse IP, type de client, limite par adresse IP des routes connectées, jeton d'accès,
 * exigence d'accès, limite par utilisateur, clé d'idempotence exigée par le manifeste (ADR-051).
 */
export class AuthorizeRequestUseCase {
  constructor(
    private readonly verifier: AccessTokenVerifierPort,
    private readonly limiter: RateLimiter,
    private readonly origins: ClientOrigins,
    private readonly limits: RateLimitTable,
    private readonly clock: Clock,
    private readonly authenticatedIpLimit: {
      limit: number;
      windowSeconds: number;
    } = DEFAULT_AUTHENTICATED_IP_LIMIT,
  ) {}

  async execute(route: RouteDefinition, request: IncomingRequest): Promise<AuthorizedRequest> {
    const rule = this.limits[route.rateLimit];
    // Limite par adresse IP d'abord : un appel refusé plus loin compte quand même.
    if (rule.key === 'ip') await this.consume(rateLimitKey(route.rateLimit, rule, { ip: request.ip }), rule);

    const clientKind = resolveClientKind(request, this.origins);
    if (route.requiresKnownClient && !clientKind) {
      throw AppError.invalid('GATEWAY_CLIENT_UNKNOWN', "Ce client n'est pas autorisé à se connecter.");
    }

    let caller: VerifiedAccessToken | null = null;
    if (route.access.level === 'authenticated') {
      // Avant le jeton : un jeton invalide compte aussi (ADR-051).
      await this.consume(authenticatedIpKey(request.ip), this.authenticatedIpLimit);
      caller = await this.verifier.verify(bearerToken(request.authorization));
      const decision = checkAccess(route.access, caller.user, Math.floor(this.clock.now().getTime() / 1000));
      if (!decision.allowed && decision.reason === 'account_deletion_pending') {
        throw AppError.forbidden(
          'GATEWAY_ACCOUNT_DELETION_PENDING',
          'Votre compte est en cours de suppression : vous pouvez seulement annuler la suppression.',
        );
      }
      if (!decision.allowed && decision.reason === 'mfa_required') {
        throw AppError.forbidden(
          'GATEWAY_MFA_REQUIRED',
          'Confirmez votre identité avec la double authentification.',
        );
      }
      if (!decision.allowed) {
        throw AppError.forbidden('GATEWAY_FORBIDDEN', "Vous n'avez pas les droits nécessaires.");
      }
      if (rule.key === 'user') {
        await this.consume(
          rateLimitKey(route.rateLimit, rule, { ip: request.ip, userId: caller.user.userId }),
          rule,
        );
      }
    }
    checkIdempotencyKey(route.idempotencyKey, request.idempotencyKey);
    return { clientKind, caller };
  }

  private async consume(key: string | null, rule: { limit: number; windowSeconds: number }): Promise<void> {
    if (!key) return;
    const result = await this.limiter.consume(key, rule);
    if (!result.allowed) {
      throw AppError.rateLimited(
        'GATEWAY_RATE_LIMITED',
        'Trop de requêtes, réessayez dans quelques instants.',
        { retryAfterSeconds: result.retryAfterSeconds },
      );
    }
  }
}

/**
 * Clé d'idempotence d'après la ligne du manifeste : obligatoire (écriture sensible) ou facultative ;
 * présente, elle a toujours le même format. Sans exigence au manifeste, l'en-tête est ignoré.
 */
function checkIdempotencyKey(requirement: RouteDefinition['idempotencyKey'], key: string | undefined): void {
  if (!requirement || (requirement === 'optional' && key === undefined)) return;
  if (key !== undefined && IDEMPOTENCY_KEY.test(key)) return;
  throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'La requête est invalide.', {
    fields: [{ field: 'Idempotency-Key', reason: key === undefined ? 'invalid_type' : 'invalid_format' }],
  });
}

function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match?.[1]) {
    throw AppError.unauthenticated('GATEWAY_TOKEN_MISSING', 'Vous devez être connecté.');
  }
  return match[1];
}
