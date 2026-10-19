import { type ServiceTokenClaims, type ServiceTokenErrorCode } from '@ksp/contracts';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type TokenSigner } from '../token/token.ports';
import { type ServiceClientRegistry } from './service-token.ports';

/** Refus de la route /oauth/token, avec son code normalisé (RFC 6749, section 5.2). */
export class ServiceTokenError extends Error {
  override readonly name = 'ServiceTokenError';

  constructor(
    readonly code: ServiceTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface IssueServiceTokenInput {
  grantType: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  audience: string | undefined;
}

export interface IssuedServiceToken {
  accessToken: string;
  expiresIn: number;
}

/**
 * Émet un jeton de service court (ADR-013, ADR-022) : le service appelant prouve son identité par son
 * secret, et n'obtient un jeton que pour un service qu'il a le droit d'appeler.
 */
export class IssueServiceTokenUseCase {
  constructor(
    private readonly clients: ServiceClientRegistry,
    private readonly signer: TokenSigner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {}

  async execute(input: IssueServiceTokenInput): Promise<IssuedServiceToken> {
    if (input.grantType !== 'client_credentials') {
      throw new ServiceTokenError('unsupported_grant_type', 'Seul le flux client_credentials est accepté.');
    }
    if (!input.clientId || !input.clientSecret || !input.audience) {
      throw new ServiceTokenError(
        'invalid_request',
        'client_id, client_secret et audience sont obligatoires.',
      );
    }
    const client = this.clients.authenticate(input.clientId, input.clientSecret);
    if (!client) {
      throw new ServiceTokenError('invalid_client', 'Service appelant inconnu ou secret incorrect.');
    }
    if (!client.audiences.includes(input.audience)) {
      throw new ServiceTokenError(
        'invalid_target',
        `${client.clientId} n'est pas autorisé à appeler ${input.audience} (carte des services).`,
      );
    }
    return this.sign(client.clientId, input.audience);
  }

  /** Jeton d'identity pour ses propres appels : signé sur place, sans secret. */
  issueForIdentity(audience: string): Promise<IssuedServiceToken> {
    return this.sign('identity', audience);
  }

  private async sign(subject: string, audience: string): Promise<IssuedServiceToken> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const claims: ServiceTokenClaims = {
      iss: 'ksp-identity',
      sub: subject,
      aud: audience,
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
      jti: this.ids.next(),
      token_use: 'service',
    };
    return { accessToken: await this.signer.sign({ ...claims }, 'JWT'), expiresIn: this.ttlSeconds };
  }
}
