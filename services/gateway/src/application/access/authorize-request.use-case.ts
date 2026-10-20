import { AppError, type VerifiedAccessToken } from '@ksp/platform';
import { checkAccess } from '../../domain/access/access-policy';
import { type ClientKind, type ClientOrigins, resolveClientKind } from '../../domain/client/client-kind';
import { rateLimitKey, type RateLimitTable } from '../../domain/rate-limit/rate-limits';
import { type RouteDefinition } from '../../domain/routing/route-manifest';
import { type AccessTokenVerifierPort, type Clock, type RateLimiter } from './access.ports';

export interface IncomingRequest {
  ip: string;
  /** En-tête Authorization brut. */
  authorization?: string | undefined;
  origin?: string | undefined;
  appVersion?: string | undefined;
}

export interface AuthorizedRequest {
  clientKind: ClientKind | null;
  /** Jeton d'accès vérifié, pour les routes connectées. */
  caller: VerifiedAccessToken | null;
}

/**
 * Contrôles de la gateway avant tout appel à un service (UC-GW-02, 03, 04) :
 * limite par adresse IP, type de client, jeton d'accès, exigence d'accès, limite par utilisateur.
 */
export class AuthorizeRequestUseCase {
  constructor(
    private readonly verifier: AccessTokenVerifierPort,
    private readonly limiter: RateLimiter,
    private readonly origins: ClientOrigins,
    private readonly limits: RateLimitTable,
    private readonly clock: Clock,
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
      caller = await this.verifier.verify(bearerToken(request.authorization));
      const decision = checkAccess(route.access, caller.user, Math.floor(this.clock.now().getTime() / 1000));
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

function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match?.[1]) {
    throw AppError.unauthenticated('GATEWAY_TOKEN_MISSING', 'Vous devez être connecté.');
  }
  return match[1];
}
