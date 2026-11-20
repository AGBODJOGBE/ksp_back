import { randomBytes } from 'node:crypto';
import { AesGcmFieldCipher, FieldEncryptionKeyError } from './aes-gcm-field-cipher';

const KEY = randomBytes(32).toString('base64');

describe('chiffrement des données personnelles (partie 16.3)', () => {
  it('déchiffre ce qu’il chiffre, dans le même contexte seulement', () => {
    const cipher = AesGcmFieldCipher.fromConfig(KEY, 'production');
    const encrypted = cipher.encrypt('+22997000000', 'agent:a1:mobile_money');
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain('22997');
    expect(cipher.decrypt(encrypted, 'agent:a1:mobile_money')).toBe('+22997000000');
    expect(() => cipher.decrypt(encrypted, 'agent:a2:mobile_money')).toThrow();
    expect(() => cipher.decrypt('v2.a.b.c', 'agent:a1:mobile_money')).toThrow('illisible');
  });

  it('clé obligatoire en production, 32 octets en base64 ; temporaire ailleurs', () => {
    expect(() => AesGcmFieldCipher.fromConfig(undefined, 'production')).toThrow(FieldEncryptionKeyError);
    expect(() => AesGcmFieldCipher.fromConfig('court', 'development')).toThrow(FieldEncryptionKeyError);
    expect(AesGcmFieldCipher.fromConfig(undefined, 'development').ephemeral).toBe(true);
  });
});
