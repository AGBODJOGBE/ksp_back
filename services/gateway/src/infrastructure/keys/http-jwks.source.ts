import { type PublicSigningKey } from '../../application/keys/public-keys';
import { type JwksSource } from './signing-keys-cache';

export interface HttpJwksSourceOptions {
  /** Adresse JWKS du port HTTP interne d'identity (ADR-020), par exemple http://identity:3101/.well-known/jwks.json. */
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Garde uniquement les clés de signature ES256 complètes : rien d'autre n'est publié ni accepté. */
function toSigningKey(value: unknown): PublicSigningKey | null {
  const key = value as Partial<Record<keyof PublicSigningKey, unknown>>;
  const strings = [key.kid, key.x, key.y].every((field) => typeof field === 'string' && field.length > 0);
  if (!strings || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== 'ES256' || key.use !== 'sig') {
    return null;
  }
  return {
    kid: key.kid as string,
    kty: 'EC',
    crv: 'P-256',
    x: key.x as string,
    y: key.y as string,
    alg: 'ES256',
    use: 'sig',
  };
}

/** Lit le document JWKS publié par identity sur son port HTTP interne (ADR-020). */
export class HttpJwksSource implements JwksSource {
  constructor(private readonly options: HttpJwksSourceOptions) {}

  async fetch(): Promise<PublicSigningKey[]> {
    const response = await (this.options.fetchImpl ?? fetch)(this.options.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
    });
    if (!response.ok) throw new Error(`JWKS d'identity : HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body?.keys)) throw new Error("JWKS d'identity : document invalide");
    const keys = body.keys.map(toSigningKey).filter((key): key is PublicSigningKey => key !== null);
    if (keys.length === 0) throw new Error("JWKS d'identity : aucune clé ES256");
    return keys;
  }
}
