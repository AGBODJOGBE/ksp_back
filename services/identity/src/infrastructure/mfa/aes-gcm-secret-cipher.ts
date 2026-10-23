import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type SecretCipher } from '../../application/mfa/mfa.ports';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
/** Étiquette complète exigée : une étiquette tronquée affaiblirait l'authentification. */
const TAG_BYTES = 16;

export class MfaEncryptionKeyError extends Error {
  override readonly name = 'MfaEncryptionKeyError';
}

/**
 * Chiffrement des secrets de double authentification (cahier des charges Identité, partie 9) :
 * AES-256-GCM, vecteur d'initialisation aléatoire de 12 octets, propriétaire du secret en données
 * associées (un chiffré recopié sur un autre compte ne se déchiffre pas).
 * Format stocké : v1.<iv>.<chiffré>.<étiquette>, en base64url.
 */
export class AesGcmSecretCipher implements SecretCipher {
  private constructor(
    private readonly key: Buffer,
    readonly ephemeral: boolean,
  ) {}

  /**
   * Clé IDENTITY_MFA_ENCRYPTION_KEY : 32 octets en base64, fournis par le coffre à secrets.
   * Absente hors production : clé temporaire (les secrets enregistrés ne survivent pas au
   * redémarrage) ; absente en production : le service refuse de démarrer.
   */
  static fromConfig(raw: string | undefined, nodeEnv: string): AesGcmSecretCipher {
    const value = raw?.trim();
    if (!value) {
      if (nodeEnv === 'production') {
        throw new MfaEncryptionKeyError('IDENTITY_MFA_ENCRYPTION_KEY est obligatoire en production.');
      }
      return new AesGcmSecretCipher(randomBytes(32), true);
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32 || key.toString('base64') !== value) {
      throw new MfaEncryptionKeyError('IDENTITY_MFA_ENCRYPTION_KEY doit contenir 32 octets en base64.');
    }
    return new AesGcmSecretCipher(key, false);
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv, encrypted, cipher.getAuthTag()]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  /** Lève une erreur si le chiffré a été modifié, recopié sur un autre compte ou chiffré avec une autre clé. */
  decrypt(ciphertext: string, context: string): string {
    const [version, iv, encrypted, tag, ...rest] = ciphertext.split('.');
    if (version !== VERSION || !iv || !encrypted || !tag || rest.length > 0) {
      throw new Error('Secret de double authentification illisible (format inconnu).');
    }
    const authTag = Buffer.from(tag, 'base64url');
    if (authTag.length !== TAG_BYTES)
      throw new Error('Secret de double authentification illisible (étiquette).');
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }
}
