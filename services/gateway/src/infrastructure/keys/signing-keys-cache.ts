import { AppError } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { type Clock } from '../../application/access/access.ports';
import { type PublicKeysProvider, type PublicSigningKey } from '../../application/keys/public-keys';

/** Source des clés publiques d'identity. */
export interface JwksSource {
  fetch(): Promise<PublicSigningKey[]>;
}

export interface SigningKeysCacheOptions {
  /** Durée de vie du cache (cahier des charges Gateway, partie 4 : 10 minutes). */
  ttlSeconds: number;
  /** Délai minimum entre deux rechargements provoqués par une clé inconnue. */
  reloadCooldownSeconds: number;
}

interface Snapshot {
  keys: PublicSigningKey[];
  loadedAt: number;
}

/**
 * Cache des clés publiques d'identity, partagé par la vérification des jetons (UC-GW-02) et par la
 * publication de /.well-known/jwks.json (UC-ID-22) :
 * - rechargé toutes les 10 minutes, ou aussitôt qu'un jeton porte une clé inconnue (rotation, ADR-020),
 *   avec un délai minimum pour qu'une rafale de jetons forgés ne sollicite pas identity ;
 * - identity injoignable : les dernières clés connues restent utilisées ; sans aucune clé, 503.
 */
export class SigningKeysCache implements PublicKeysProvider {
  private readonly logger = new Logger(SigningKeysCache.name);
  private snapshot: Snapshot | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<PublicSigningKey[]> | null = null;

  constructor(
    private readonly source: JwksSource,
    private readonly options: SigningKeysCacheOptions,
    private readonly clock: Clock,
  ) {}

  /** Fonction de résolution des clés pour jose (AccessTokenVerifier). */
  readonly resolveKey: JWTVerifyGetKey = async (header, token) => {
    let keys = await this.publicKeys();
    if (header.kid && !keys.some((key) => key.kid === header.kid) && this.cooldownElapsed()) {
      keys = await this.load();
    }
    return createLocalJWKSet({ keys } as unknown as JSONWebKeySet)(header, token);
  };

  async publicKeys(): Promise<PublicSigningKey[]> {
    if (this.snapshot && this.now() - this.snapshot.loadedAt < this.options.ttlSeconds * 1000) {
      return this.snapshot.keys;
    }
    // Dernier chargement en échec il y a peu : on n'insiste pas auprès d'identity.
    if (!this.pending && !this.cooldownElapsed()) {
      if (this.snapshot) return this.snapshot.keys;
      throw unavailable();
    }
    return this.load();
  }

  /** Clés présentes en cache (sonde « prêt »). */
  async ensureLoaded(): Promise<void> {
    await this.publicKeys();
  }

  private cooldownElapsed(): boolean {
    return this.now() - this.lastAttemptAt >= this.options.reloadCooldownSeconds * 1000;
  }

  private load(): Promise<PublicSigningKey[]> {
    this.pending ??= this.fetchKeys().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async fetchKeys(): Promise<PublicSigningKey[]> {
    this.lastAttemptAt = this.now();
    try {
      const keys = await this.source.fetch();
      this.snapshot = { keys, loadedAt: this.now() };
      return keys;
    } catch (error) {
      this.logger.warn(
        `Clés publiques d'identity impossibles à charger : ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.snapshot) return this.snapshot.keys;
      throw unavailable();
    }
  }

  private now(): number {
    return this.clock.now().getTime();
  }
}

function unavailable(): AppError {
  return AppError.unavailable(
    'IDENTITY_UNAVAILABLE',
    'Le service est momentanément indisponible, réessayez dans quelques instants.',
  );
}
