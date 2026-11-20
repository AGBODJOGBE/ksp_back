import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EPHEMERAL_KEY_ID, fieldKeyringFromConfig, type FieldKeyring, isFieldKeyId } from './keyring';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** Étiquette complète exigée : une étiquette tronquée affaiblirait l'authentification. */
const TAG_BYTES = 16;
const LEGACY_VERSION = 'v1';
const VERSION = 'v2';

/** Chiffré illisible : format inconnu, clé inconnue, contexte différent ou contenu altéré. */
export class FieldDecryptionError extends Error {
  override readonly name = 'FieldDecryptionError';
}

/**
 * Chiffrement de champs en base (coordonnées, pièces, secrets) : AES-256-GCM, vecteur d'initialisation
 * aléatoire de 12 octets, **contexte en données associées** (identifiant du propriétaire, de la ligne ou
 * du champ : un chiffré recopié ailleurs ne se déchiffre pas).
 *
 * Formats, en base64url :
 * - `v2.<id de clé>.<iv>.<chiffré>.<étiquette>` : format écrit ; l'identifiant de clé permet la rotation ;
 *   la version et l'identifiant sont aussi liés au chiffré par les données associées ;
 * - `v1.<iv>.<chiffré>.<étiquette>` : ancien format des secrets de double authentification d'identity,
 *   relu seulement (essayé avec chaque clé du trousseau ; l'étiquette désigne la bonne).
 */
export class FieldCipher {
  private constructor(private readonly keyring: FieldKeyring) {}

  static fromKeyring(keyring: FieldKeyring): FieldCipher {
    return new FieldCipher(keyring);
  }

  /** Voir `fieldKeyringFromConfig` : clé obligatoire en production, temporaire ailleurs. */
  static fromConfig(raw: string | undefined, nodeEnv: string, variable: string): FieldCipher {
    return new FieldCipher(fieldKeyringFromConfig(raw, nodeEnv, variable));
  }

  /** Clé temporaire : les données chiffrées ne survivront pas au redémarrage. */
  get ephemeral(): boolean {
    return this.keyring.ephemeral;
  }

  get activeKeyId(): string {
    return this.keyring.activeId;
  }

  encrypt(plaintext: string, context: string): string {
    const keyId = this.keyring.activeId;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keyring.keys.get(keyId)!, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(VERSION, keyId, context));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      keyId,
      iv.toString('base64url'),
      encrypted.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  decrypt(ciphertext: string, context: string): string {
    const parts = ciphertext.split('.');
    if (parts[0] === VERSION && parts.length === 5 && isFieldKeyId(parts[1]!)) {
      const [, keyId, iv, encrypted, tag] = parts as [string, string, string, string, string];
      const key = this.keyring.keys.get(keyId);
      if (!key) {
        if (keyId === EPHEMERAL_KEY_ID) throw lostEphemeralKey();
        throw new FieldDecryptionError(`Chiffré illisible : clé « ${keyId} » absente du trousseau.`);
      }
      try {
        return open(key, iv, encrypted, tag, associatedData(VERSION, keyId, context));
      } catch (error) {
        throw keyId === EPHEMERAL_KEY_ID ? lostEphemeralKey() : error;
      }
    }
    if (parts[0] === LEGACY_VERSION && parts.length === 4) {
      const [, iv, encrypted, tag] = parts as [string, string, string, string];
      const aad = Buffer.from(context, 'utf8');
      for (const key of this.keyring.keys.values()) {
        try {
          return open(key, iv, encrypted, tag, aad);
        } catch {
          // Clé suivante : seule la bonne clé authentifie le chiffré.
        }
      }
      throw new FieldDecryptionError('Chiffré illisible (aucune clé ne correspond, ou contenu altéré).');
    }
    throw new FieldDecryptionError('Chiffré illisible (format inconnu).');
  }

  /** Vrai si le chiffré doit être réécrit avec la clé active (ancien format ou ancienne clé). */
  needsReencryption(ciphertext: string): boolean {
    const [version, keyId] = ciphertext.split('.');
    return version !== VERSION || keyId !== this.keyring.activeId;
  }
}

/** Clé temporaire d'un démarrage précédent : message explicite plutôt qu'un simple échec d'authentification. */
function lostEphemeralKey(): FieldDecryptionError {
  return new FieldDecryptionError(
    'Chiffré illisible : écrit avec une clé temporaire, perdue au redémarrage, ou altéré (configurer la clé).',
  );
}

function associatedData(version: string, keyId: string, context: string): Buffer {
  return Buffer.from(`${version}.${keyId}.${context}`, 'utf8');
}

function open(key: Buffer, iv: string, encrypted: string, tag: string, aad: Buffer): string {
  const authTag = Buffer.from(tag, 'base64url');
  const nonce = Buffer.from(iv, 'base64url');
  if (authTag.length !== TAG_BYTES || nonce.length !== IV_BYTES) {
    throw new FieldDecryptionError('Chiffré illisible (étiquette ou vecteur de taille inattendue).');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new FieldDecryptionError('Chiffré illisible (clé, contexte ou contenu différents).');
  }
}
