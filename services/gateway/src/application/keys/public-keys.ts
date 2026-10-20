/** Clé publique de vérification des jetons d'accès, au format JWK (RFC 7517), courbe P-256. */
export interface PublicSigningKey {
  kid: string;
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg: 'ES256';
  use: 'sig';
}

/** Clés publiques d'identity, gardées en cache par la gateway (UC-ID-22, partie 4 : 10 minutes). */
export interface PublicKeysProvider {
  publicKeys(): Promise<PublicSigningKey[]>;
}

/** Publie les clés publiques sur /.well-known/jwks.json, depuis le cache de la gateway. */
export class GetPublicKeysUseCase {
  constructor(private readonly keys: PublicKeysProvider) {}

  async execute(): Promise<{ keys: PublicSigningKey[] }> {
    return { keys: await this.keys.publicKeys() };
  }
}
