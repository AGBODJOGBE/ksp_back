import { exportJWK, generateKeyPair, importPKCS8, type KeyLike, SignJWT } from 'jose';
import { z } from 'zod';
import { type PublicSigningKey, type TokenSigner } from '../../application/token/token.ports';

/**
 * Format de IDENTITY_SIGNING_KEYS (ADR-020) : liste JSON des clés, fournie par le coffre à secrets.
 *   [{ "kid": "2026-10-a", "status": "active", "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n…" }]
 * - next    : publiée, ne signe pas encore (rotation à venir) ;
 * - active  : signe les nouveaux jetons, exactement une ;
 * - retired : publiée jusqu'à l'expiration des jetons qu'elle a signés, puis retirée de la liste.
 */
const keyEntries = z
  .array(
    z.object({
      kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'kid : lettres, chiffres, point, tiret ou souligné'),
      status: z.enum(['next', 'active', 'retired']),
      privateKeyPem: z.string().includes('PRIVATE KEY', { message: 'clé privée PKCS#8 attendue' }),
    }),
  )
  .min(1)
  .refine((keys) => keys.filter((key) => key.status === 'active').length === 1, {
    message: 'exactement une clé doit être active',
  })
  .refine((keys) => new Set(keys.map((key) => key.kid)).size === keys.length, {
    message: 'chaque kid doit être unique',
  });

export class SigningKeysError extends Error {
  override readonly name = 'SigningKeysError';
}

interface LoadedKey {
  kid: string;
  status: 'next' | 'active' | 'retired';
  privateKey: KeyLike;
  publicJwk: PublicSigningKey;
}

async function load(kid: string, status: LoadedKey['status'], privateKey: KeyLike): Promise<LoadedKey> {
  const jwk = await exportJWK(privateKey);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new SigningKeysError(`La clé ${kid} doit être une clé EC P-256 (ES256).`);
  }
  return {
    kid,
    status,
    privateKey,
    publicJwk: { kid, kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, alg: 'ES256', use: 'sig' },
  };
}

/** Signataire qui détient les clés privées en mémoire, chargées depuis le coffre à secrets. */
export class KeyRingSigner implements TokenSigner {
  private constructor(
    private readonly keys: LoadedKey[],
    readonly ephemeral: boolean,
  ) {}

  /**
   * Charge les clés de IDENTITY_SIGNING_KEYS. Sans clé configurée, génère une clé temporaire,
   * sauf en production où le service refuse de démarrer.
   */
  static async fromConfig(raw: string | undefined, nodeEnv: string): Promise<KeyRingSigner> {
    if (!raw?.trim()) {
      if (nodeEnv === 'production') {
        throw new SigningKeysError('IDENTITY_SIGNING_KEYS est obligatoire en production.');
      }
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      return new KeyRingSigner([await load(`ephemeral-${Date.now()}`, 'active', privateKey)], true);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SigningKeysError("IDENTITY_SIGNING_KEYS n'est pas un JSON valide.");
    }
    const result = keyEntries.safeParse(parsed);
    if (!result.success) {
      throw new SigningKeysError(
        `IDENTITY_SIGNING_KEYS invalide : ${result.error.issues.map((issue) => issue.message).join(' ; ')}`,
      );
    }
    const keys = await Promise.all(
      result.data.map(async (entry) => {
        let privateKey: KeyLike;
        try {
          privateKey = await importPKCS8(entry.privateKeyPem, 'ES256');
        } catch {
          throw new SigningKeysError(`La clé ${entry.kid} n'est pas une clé privée ES256 lisible.`);
        }
        return load(entry.kid, entry.status, privateKey);
      }),
    );
    return new KeyRingSigner(keys, false);
  }

  get activeKid(): string {
    return this.active().kid;
  }

  async sign(payload: Record<string, unknown>, typ: string): Promise<string> {
    const key = this.active();
    return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: key.kid, typ }).sign(key.privateKey);
  }

  publicKeys(): PublicSigningKey[] {
    // Suivante d'abord : les vérificateurs l'ont déjà en cache quand elle devient active.
    const order = { next: 0, active: 1, retired: 2 };
    return [...this.keys].sort((a, b) => order[a.status] - order[b.status]).map((key) => key.publicJwk);
  }

  private active(): LoadedKey {
    return this.keys.find((key) => key.status === 'active') as LoadedKey;
  }
}
