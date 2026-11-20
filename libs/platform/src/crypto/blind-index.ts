import { createHmac, hkdfSync } from 'node:crypto';
import { fieldKeyringFromConfig, type FieldKeyring } from './keyring';

/** Valeur impossible à normaliser (téléphone hors E.164, e-mail sans @…). */
export class BlindIndexInputError extends Error {
  override readonly name = 'BlindIndexInputError';
}

const E164 = /^\+[1-9]\d{6,14}$/;
const PURPOSE = /^[a-z0-9_]{1,50}$/;
/** Ancien plan béninois : +229 suivi de 8 chiffres exactement. */
const BENIN_EIGHT_DIGITS = /^\+229\d{8}$/;
/**
 * Étiquette de dérivation (HKDF-SHA256) de la clé HMAC : même si un service configurait par erreur la
 * même clé pour `FieldCipher` et `BlindIndex`, la clé AES et la clé HMAC resteraient distinctes.
 */
const HKDF_INFO = Buffer.from('ksp/platform/blind-index/hmac-sha256', 'utf8');

/**
 * Empreinte de recherche (« index aveugle ») : HMAC-SHA256 d'une valeur normalisée, pour retrouver un
 * téléphone ou un e-mail chiffré en base sans le déchiffrer (doublons, recherche exacte).
 * Trousseau dans **sa propre variable**, distincte de celle de `FieldCipher` ; la clé HMAC est en plus
 * dérivée (HKDF) de la clé configurée, pour qu'une clé partagée par erreur ne serve jamais aux deux usages.
 *
 * - Déterministe : même clé, même finalité, même valeur normalisée → même empreinte.
 * - **Finalité** (`purpose`, par exemple `debtor_phone`) mêlée au calcul : deux colonnes n'ont jamais
 *   la même empreinte pour la même valeur, une empreinte ne se compare qu'à sa colonne.
 * - Format : `<id de clé>.<empreinte en base64url>` ; changer de clé active demande de recalculer les
 *   empreintes (`compute` avec l'ancienne clé reste possible tant qu'elle est dans le trousseau).
 */
export class BlindIndex {
  /** Clés HMAC dérivées de chaque clé du trousseau, jamais les clés brutes. */
  private readonly macKeys: ReadonlyMap<string, Buffer>;

  private constructor(private readonly keyring: FieldKeyring) {
    this.macKeys = new Map(
      [...keyring.keys].map(([id, key]) => [
        id,
        Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), HKDF_INFO, 32)),
      ]),
    );
  }

  static fromKeyring(keyring: FieldKeyring): BlindIndex {
    return new BlindIndex(keyring);
  }

  /** Voir `fieldKeyringFromConfig` : clé obligatoire en production, temporaire ailleurs. */
  static fromConfig(raw: string | undefined, nodeEnv: string, variable: string): BlindIndex {
    return new BlindIndex(fieldKeyringFromConfig(raw, nodeEnv, variable));
  }

  /** Clé temporaire : les empreintes changent à chaque redémarrage. */
  get ephemeral(): boolean {
    return this.keyring.ephemeral;
  }

  /** Empreinte d'une valeur déjà normalisée par l'appelant. */
  compute(purpose: string, normalized: string, keyId = this.keyring.activeId): string {
    if (!PURPOSE.test(purpose)) throw new BlindIndexInputError(`Finalité « ${purpose} » invalide.`);
    const key = this.macKeys.get(keyId);
    if (!key) throw new BlindIndexInputError(`Clé « ${keyId} » absente du trousseau.`);
    const digest = createHmac('sha256', key)
      .update(`${purpose}\u0000${normalized}`, 'utf8')
      .digest('base64url');
    return `${keyId}.${digest}`;
  }

  phone(purpose: string, value: string): string {
    return this.compute(purpose, normalizePhone(value));
  }

  email(purpose: string, value: string): string {
    return this.compute(purpose, normalizeEmail(value));
  }
}

/**
 * Téléphone au format E.164 : espaces, points, tirets et parenthèses retirés, préfixe `00` lu comme `+`.
 * Aucun indicatif n'est deviné : un numéro sans indicatif est refusé.
 * Bénin (ADR-063, validé le 2026-11-20) : la numérotation est passée à 10 chiffres fin 2024 en
 * ajoutant `01` devant les 8 chiffres ; un numéro `+229` à 8 chiffres devient donc `+229 01` suivi des
 * 8 chiffres, et les deux formes d'un même numéro donnent la même empreinte. Les autres pays sont inchangés.
 */
export function normalizePhone(value: string): string {
  let phone = value.normalize('NFKC').replace(/[\s.\-()]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (!E164.test(phone)) throw new BlindIndexInputError('Téléphone attendu au format E.164 (+229…).');
  if (BENIN_EIGHT_DIGITS.test(phone)) phone = `+22901${phone.slice(4)}`;
  return phone;
}

/** E-mail : espaces retirés, minuscules. Les points et les « + » de la partie locale sont gardés. */
export function normalizeEmail(value: string): string {
  const email = value.normalize('NFKC').trim().toLowerCase();
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1 || /\s/.test(email)) {
    throw new BlindIndexInputError('Adresse e-mail illisible.');
  }
  return email;
}
