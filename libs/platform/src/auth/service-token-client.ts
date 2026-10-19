import { SERVICE_TOKEN_ENDPOINT, type ServiceTokenResponse } from '@ksp/contracts';
import { AppError } from '../errors/app-error';
import { type ServiceTokenProvider } from './service-token';

export interface ServiceTokenClientOptions {
  /** Adresse de la route d'émission d'identity, par exemple http://identity:3101/oauth/token. */
  tokenUrl: string;
  /** Nom du service appelant (client_id). */
  clientId: string;
  clientSecret: string;
  /** Marge avant expiration à partir de laquelle un nouveau jeton est demandé. */
  refreshMarginSeconds?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export const SERVICE_TOKEN_PROVIDER = Symbol('SERVICE_TOKEN_PROVIDER');

/**
 * Obtient les jetons de service auprès d'identity (OAuth 2.0 client credentials, ADR-022) et les garde
 * en cache par service appelé : identity n'est sollicité qu'une fois toutes les quelques minutes.
 * Deux demandes simultanées pour le même destinataire partagent la même requête.
 */
export class ServiceTokenClient implements ServiceTokenProvider {
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly options: ServiceTokenClientOptions) {}

  async getToken(audience: string): Promise<string> {
    const cached = this.cache.get(audience);
    const margin = (this.options.refreshMarginSeconds ?? 60) * 1000;
    if (cached && cached.expiresAt - margin > this.now()) return cached.token;

    const inFlight = this.pending.get(audience);
    if (inFlight) return inFlight;
    const request = this.fetchToken(audience).finally(() => this.pending.delete(audience));
    this.pending.set(audience, request);
    return request;
  }

  private async fetchToken(audience: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: SERVICE_TOKEN_ENDPOINT.grantType,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      audience,
    });
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      });
    } catch {
      throw unavailable(audience);
    }
    if (!response.ok) {
      // Mauvais secret ou appel non prévu par la carte des services : erreur de configuration, pas une panne.
      const error = (await response.json().catch(() => ({}))) as { error?: string };
      throw new AppError(
        'INTERNAL',
        'SERVICE_TOKEN_REFUSED',
        `identity refuse le jeton de service pour ${audience} (${error.error ?? response.status}).`,
      );
    }
    const payload = (await response.json()) as ServiceTokenResponse;
    this.cache.set(audience, {
      token: payload.access_token,
      expiresAt: this.now() + payload.expires_in * 1000,
    });
    return payload.access_token;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function unavailable(audience: string): AppError {
  return AppError.unavailable(
    'SERVICE_TOKEN_UNAVAILABLE',
    `Jeton de service indisponible pour ${audience} : identity ne répond pas.`,
  );
}
