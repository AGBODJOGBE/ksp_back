import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { refuseDevelopmentSecrets } from '../config/config';
import { BlindIndex, BlindIndexInputError, normalizeEmail, normalizePhone } from './blind-index';
import { FieldCipher, FieldDecryptionError } from './field-cipher';
import {
  DEFAULT_KEY_ID,
  FieldKeyError,
  fieldKeyringEnv,
  fieldKeyringFromConfig,
  parseFieldKeyring,
  requireFieldKeysInProduction,
} from './keyring';

const key = () => randomBytes(32).toString('base64');

/** Chiffré au format v1 tel que l'écrivait l'ancien chiffrement des secrets de double authentification. */
function legacyEncrypt(keyBase64: string, plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, body, cipher.getAuthTag()]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

describe('parseFieldKeyring', () => {
  it('lit une clé seule (identifiant default) ou une liste id:clé dont la première est active', () => {
    const single = parseFieldKeyring(key(), 'K');
    expect(single.activeId).toBe(DEFAULT_KEY_ID);
    expect(single.keys.size).toBe(1);
    const ring = parseFieldKeyring(`k2:${key()}, k1:${key()}`, 'K');
    expect(ring.activeId).toBe('k2');
    expect([...ring.keys.keys()]).toEqual(['k2', 'k1']);
  });

  it('refuse une clé de mauvaise taille, un identifiant invalide ou en double', () => {
    expect(() => parseFieldKeyring(randomBytes(16).toString('base64'), 'K')).toThrow(FieldKeyError);
    expect(() => parseFieldKeyring('pas-du-base64!', 'K')).toThrow(FieldKeyError);
    expect(() => parseFieldKeyring(`K1:${key()}`, 'K')).toThrow(/identifiant/);
    expect(() => parseFieldKeyring(`a:${key()},a:${key()}`, 'K')).toThrow(/double/);
    expect(() => parseFieldKeyring(`a:${key()}:x`, 'K')).toThrow(FieldKeyError);
  });

  it('ne recopie jamais une clé dans un message d’erreur (journaux de démarrage)', () => {
    const secret = key();
    const attempts = [
      `k1:${key()},${secret}`, // identifiant oublié sur la deuxième entrée
      `${secret}:k1`, // ordre inversé
      `k1:${secret}:k2`,
    ];
    for (const raw of attempts) {
      expect(() => parseFieldKeyring(raw, 'K')).toThrow(FieldKeyError);
      try {
        parseFieldKeyring(raw, 'K');
      } catch (error) {
        expect((error as Error).message).not.toContain(secret.slice(0, 12));
      }
    }
    const parsed = z.object({ K: fieldKeyringEnv('K') }).safeParse({ K: `${secret}:k1` });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain(secret.slice(0, 12));
  });

  it('réserve l’identifiant de la clé temporaire', () => {
    expect(() => parseFieldKeyring(`ephemeral:${key()}`, 'K')).toThrow(/réservé/);
  });

  it('clé obligatoire en production, temporaire ailleurs avec un avertissement journalisé', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => fieldKeyringFromConfig(undefined, 'production', 'K')).toThrow(/obligatoire/);
      expect(fieldKeyringFromConfig(key(), 'production', 'K').ephemeral).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(fieldKeyringFromConfig(' ', 'development', 'K').ephemeral).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^K absente : clé temporaire.*illisibles/));
    } finally {
      warn.mockRestore();
    }
  });

  it('vérifie le format dès la lecture de la configuration', () => {
    const schema = z.object({ K: fieldKeyringEnv('K') });
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ K: key() }).success).toBe(true);
    const bad = schema.safeParse({ K: 'abc' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/32 octets/);
  });
});

describe('FieldCipher', () => {
  const k1 = key();

  it('chiffre puis déchiffre, avec un chiffré différent à chaque fois et l’identifiant de clé', () => {
    const cipher = FieldCipher.fromConfig(k1, 'production', 'K');
    const first = cipher.encrypt('+22997000101', 'debtor:1:phone');
    const second = cipher.encrypt('+22997000101', 'debtor:1:phone');
    expect(first).toMatch(/^v2\.default\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('97000101');
    expect(FieldCipher.fromConfig(k1, 'production', 'K').decrypt(second, 'debtor:1:phone')).toBe(
      '+22997000101',
    );
    expect(cipher.encrypt('', 'ctx')).toMatch(/^v2\./);
    expect(cipher.decrypt(cipher.encrypt('', 'ctx'), 'ctx')).toBe('');
  });

  it('refuse un autre contexte, une autre clé, un contenu ou un en-tête altéré', () => {
    const cipher = FieldCipher.fromConfig(k1, 'production', 'K');
    const encrypted = cipher.encrypt('secret', 'user-1');
    expect(() => cipher.decrypt(encrypted, 'user-2')).toThrow(FieldDecryptionError);
    expect(() => FieldCipher.fromConfig(key(), 'production', 'K').decrypt(encrypted, 'user-1')).toThrow(
      FieldDecryptionError,
    );
    const [v, id, iv, body, tag] = encrypted.split('.') as [string, string, string, string, string];
    const altered = Buffer.from(body, 'base64url');
    altered[0] = altered[0]! ^ 1;
    expect(() => cipher.decrypt([v, id, iv, altered.toString('base64url'), tag].join('.'), 'user-1')).toThrow(
      FieldDecryptionError,
    );
    expect(() => cipher.decrypt([v, id, iv, body, tag.slice(0, 8)].join('.'), 'user-1')).toThrow(
      FieldDecryptionError,
    );
    expect(() => cipher.decrypt([v, 'other', iv, body, tag].join('.'), 'user-1')).toThrow(/absente/);
    expect(() => cipher.decrypt('v3.a.b.c.d', 'user-1')).toThrow(/format/);
    expect(() => cipher.decrypt('texte en clair', 'user-1')).toThrow(FieldDecryptionError);
  });

  it('tire un vecteur de 12 octets à chaque chiffrement et écrit une étiquette de 16 octets', () => {
    const cipher = FieldCipher.fromConfig(k1, 'production', 'K');
    const ivs = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const [, , iv, , tag] = cipher.encrypt('x', 'ctx').split('.') as [
        string,
        string,
        string,
        string,
        string,
      ];
      expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
      expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
      ivs.add(iv);
    }
    expect(ivs.size).toBe(1000);
  });

  it('lie la version et l’identifiant de clé au chiffré (données associées)', () => {
    const material = key();
    // Même clé sous deux identifiants : seul l'en-tête change, l'authentification doit échouer.
    const ring = FieldCipher.fromConfig(`a:${material},b:${material}`, 'production', 'K');
    const encrypted = ring.encrypt('valeur', 'ctx');
    const [v, , iv, body, tag] = encrypted.split('.') as [string, string, string, string, string];
    expect(() => ring.decrypt([v, 'b', iv, body, tag].join('.'), 'ctx')).toThrow(FieldDecryptionError);
    // Rétrogradation vers v1 refusée : les données associées v1 n'ont pas d'en-tête.
    expect(() => ring.decrypt(['v1', iv, body, tag].join('.'), 'ctx')).toThrow(FieldDecryptionError);
    expect(() => ring.decrypt([v, 'A B', iv, body, tag].join('.'), 'ctx')).toThrow(/format/);
  });

  it('signale clairement un chiffré écrit avec la clé temporaire d’un démarrage précédent', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const encrypted = FieldCipher.fromConfig(undefined, 'development', 'K').encrypt('valeur', 'ctx');
      expect(encrypted).toMatch(/^v2\.ephemeral\./);
      // Redémarrage : nouvelle clé temporaire, ou clé enfin configurée.
      expect(() => FieldCipher.fromConfig(undefined, 'development', 'K').decrypt(encrypted, 'ctx')).toThrow(
        /clé temporaire/,
      );
      expect(() => FieldCipher.fromConfig(k1, 'development', 'K').decrypt(encrypted, 'ctx')).toThrow(
        /clé temporaire/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rotation : la nouvelle clé chiffre, les anciennes relisent, needsReencryption le signale', () => {
    const k2 = key();
    const before = FieldCipher.fromConfig(`k1:${k1}`, 'production', 'K');
    const old = before.encrypt('valeur', 'ctx');
    const after = FieldCipher.fromConfig(`k2:${k2},k1:${k1}`, 'production', 'K');
    expect(after.activeKeyId).toBe('k2');
    expect(after.decrypt(old, 'ctx')).toBe('valeur');
    expect(after.needsReencryption(old)).toBe(true);
    const fresh = after.encrypt('valeur', 'ctx');
    expect(fresh.split('.')[1]).toBe('k2');
    expect(after.needsReencryption(fresh)).toBe(false);
    expect(() => before.decrypt(fresh, 'ctx')).toThrow(FieldDecryptionError);
  });

  it('relit l’ancien format v1 avec n’importe quelle clé du trousseau, jamais avec une clé absente', () => {
    const legacy = legacyEncrypt(k1, 'JBSWY3DPEHPK3PXP', 'user-1');
    const ring = FieldCipher.fromConfig(`new:${key()},default:${k1}`, 'production', 'K');
    expect(ring.decrypt(legacy, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(ring.needsReencryption(legacy)).toBe(true);
    expect(() => ring.decrypt(legacy, 'user-2')).toThrow(FieldDecryptionError);
    expect(() => FieldCipher.fromConfig(key(), 'production', 'K').decrypt(legacy, 'user-1')).toThrow(
      FieldDecryptionError,
    );
  });
});

describe('BlindIndex', () => {
  const k1 = key();

  it('donne une empreinte stable, normalisée, propre à la finalité et à la clé', () => {
    const index = BlindIndex.fromConfig(k1, 'production', 'K');
    const a = index.phone('debtor_phone', '+229 97 00 01 01');
    expect(a).toBe(BlindIndex.fromConfig(k1, 'production', 'K').phone('debtor_phone', '0022997000101'));
    expect(a).toMatch(/^default\.[\w-]{43}$/);
    expect(index.phone('tenant_phone', '+22997000101')).not.toBe(a);
    expect(BlindIndex.fromConfig(key(), 'production', 'K').phone('debtor_phone', '+22997000101')).not.toBe(a);
    expect(index.email('debtor_email', '  Awa.Doe@Example.BJ ')).toBe(
      index.email('debtor_email', 'awa.doe@example.bj'),
    );
  });

  it('n’utilise jamais la clé configurée telle quelle (clé HMAC dérivée, distincte de la clé AES)', () => {
    const raw = createHmac('sha256', Buffer.from(k1, 'base64'))
      .update('debtor_phone\u0000+2290197000101', 'utf8')
      .digest('base64url');
    const index = BlindIndex.fromConfig(k1, 'production', 'K').phone('debtor_phone', '+2290197000101');
    expect(index).not.toBe(`default.${raw}`);
    expect(index).not.toContain(raw);
  });

  it('calcule avec une ancienne clé du trousseau pour les recherches pendant une rotation', () => {
    const old = BlindIndex.fromConfig(`k1:${k1}`, 'production', 'K').compute('p', 'x');
    const ring = BlindIndex.fromConfig(`k2:${key()},k1:${k1}`, 'production', 'K');
    expect(ring.compute('p', 'x', 'k1')).toBe(old);
    expect(ring.compute('p', 'x')).not.toBe(old);
    expect(() => ring.compute('p', 'x', 'k9')).toThrow(BlindIndexInputError);
    expect(() => ring.compute('Bad Purpose', 'x')).toThrow(BlindIndexInputError);
  });

  it('normalise téléphones et e-mails, refuse ce qui ne se normalise pas', () => {
    const index = BlindIndex.fromConfig(k1, 'production', 'K');
    // Bénin : un numéro à 8 chiffres prend le préfixe 01 du plan à 10 chiffres (ADR-063).
    expect(normalizePhone('+229 (97) 00-01.01')).toBe('+2290197000101');
    expect(normalizePhone('00229 97 00 01 01')).toBe('+2290197000101');
    // Un numéro à 10 chiffres reste tel quel.
    expect(normalizePhone('+229 01 97 00 01 01')).toBe('+2290197000101');
    expect(normalizePhone('+229 01 01 02 03 04')).toBe('+2290101020304');
    expect(normalizePhone('\uFF0B\uFF12\uFF12\uFF19 0197000101')).toBe('+2290197000101');
    // Les deux formes d'un même numéro donnent la même empreinte.
    expect(index.phone('debtor_phone', '+22997000101')).toBe(index.phone('debtor_phone', '+2290197000101'));
    // Les numéros d'autres pays sont inchangés, même à 8 chiffres après l'indicatif.
    expect(normalizePhone('+228 90 00 01 01')).toBe('+22890000101');
    expect(normalizePhone('+33 6 12 34 56 78')).toBe('+33612345678');
    // +229 suivi d'un nombre de chiffres autre que 8 : inchangé.
    expect(normalizePhone('+2297000101')).toBe('+2297000101');
    expect(() => normalizePhone('22997000101')).toThrow(BlindIndexInputError);
    expect(() => normalizePhone('0197000101')).toThrow(BlindIndexInputError);
    expect(() => normalizePhone('+229 97 00 01 01 ext 2')).toThrow(BlindIndexInputError);
    expect(() => normalizePhone('+2290197000101234567')).toThrow(BlindIndexInputError);
    expect(() => normalizePhone('')).toThrow(BlindIndexInputError);
    expect(() => normalizePhone('97000101')).toThrow(BlindIndexInputError);
    expect(() => normalizePhone('+0123')).toThrow(BlindIndexInputError);
    expect(normalizeEmail('A+b@X.bj')).toBe('a+b@x.bj');
    expect(() => normalizeEmail('pas-un-email')).toThrow(BlindIndexInputError);
    expect(() => normalizeEmail('a@b@c')).toThrow(BlindIndexInputError);
    expect(() => normalizeEmail('@x.bj')).toThrow(BlindIndexInputError);
    expect(() => normalizeEmail('a@')).toThrow(BlindIndexInputError);
    expect(() => normalizeEmail('a b@x.bj')).toThrow(BlindIndexInputError);
    expect(() => normalizeEmail('')).toThrow(BlindIndexInputError);
  });
});

describe('refuseDevelopmentSecrets', () => {
  const devKey = key();
  const schema = z
    .object({ NODE_ENV: z.string(), K: z.string().optional(), S: z.string().optional() })
    .superRefine((cfg, ctx) => refuseDevelopmentSecrets(cfg, ctx, { K: devKey, S: 'dev-secret' }));

  it('refuse en production un secret de développement, même recopié sous un autre identifiant', () => {
    expect(schema.safeParse({ NODE_ENV: 'production', S: 'dev-secret' }).success).toBe(false);
    expect(schema.safeParse({ NODE_ENV: 'production', K: devKey }).success).toBe(false);
    const copied = schema.safeParse({ NODE_ENV: 'production', K: `new:${key()},old:${devKey}` });
    expect(copied.success).toBe(false);
    expect(copied.error?.issues[0]?.path).toEqual(['K']);
  });

  it('accepte des secrets propres en production et tout hors production', () => {
    expect(schema.safeParse({ NODE_ENV: 'production', K: key(), S: 'autre' }).success).toBe(true);
    expect(schema.safeParse({ NODE_ENV: 'development', K: devKey, S: 'dev-secret' }).success).toBe(true);
  });
});

describe('requireFieldKeysInProduction', () => {
  const schema = z
    .object({ NODE_ENV: z.string(), K: fieldKeyringEnv('K') })
    .superRefine((cfg, ctx) => requireFieldKeysInProduction(cfg, ctx, ['K']));

  it('refuse un trousseau absent ou vide en production, dès la lecture de la configuration', () => {
    const missing = schema.safeParse({ NODE_ENV: 'production' });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.path).toEqual(['K']);
    expect(missing.error?.issues[0]?.message).toMatch(/obligatoire en production/);
    expect(schema.safeParse({ NODE_ENV: 'production', K: '  ' }).success).toBe(false);
  });

  it('accepte un trousseau en production et son absence ailleurs', () => {
    expect(schema.safeParse({ NODE_ENV: 'production', K: key() }).success).toBe(true);
    expect(schema.safeParse({ NODE_ENV: 'development' }).success).toBe(true);
    expect(schema.safeParse({ NODE_ENV: 'test' }).success).toBe(true);
  });
});
