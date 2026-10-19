import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AccessTokenVerifier } from '@ksp/platform';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import { AccessTokenIssuer } from '../../application/token/access-token-issuer';
import { KeyRingSigner } from './key-ring-signer';

async function pem(): Promise<string> {
  return exportPKCS8((await generateKeyPair('ES256', { extractable: true })).privateKey);
}

const config = async (keys: { kid: string; status: string; privateKeyPem?: string }[]) =>
  JSON.stringify(await Promise.all(keys.map(async (key) => ({ privateKeyPem: await pem(), ...key }))));

describe('KeyRingSigner', () => {
  it('génère une clé temporaire en développement si aucune n’est configurée', async () => {
    const signer = await KeyRingSigner.fromConfig(undefined, 'development');
    expect(signer.ephemeral).toBe(true);
    expect(signer.publicKeys()).toHaveLength(1);
  });

  it('refuse de démarrer sans clé en production', async () => {
    await expect(KeyRingSigner.fromConfig('', 'production')).rejects.toThrow(/obligatoire en production/);
  });

  it.each([
    ['un JSON illisible', async () => '{pas du json', /JSON valide/],
    [
      'aucune clé active',
      () => config([{ kid: 'a', status: 'next' }]),
      /exactement une clé doit être active/,
    ],
    [
      'deux clés actives',
      () =>
        config([
          { kid: 'a', status: 'active' },
          { kid: 'b', status: 'active' },
        ]),
      /exactement une clé doit être active/,
    ],
    [
      'deux fois le même kid',
      () =>
        config([
          { kid: 'a', status: 'active' },
          { kid: 'a', status: 'retired' },
        ]),
      /unique/,
    ],
    [
      'une clé illisible',
      () =>
        config([
          {
            kid: 'a',
            status: 'active',
            privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
          },
        ]),
      /n'est pas une clé privée ES256/,
    ],
  ])('refuse %s', async (_label, raw, message) => {
    await expect(KeyRingSigner.fromConfig(await raw(), 'production')).rejects.toThrow(message);
  });

  it('publie la clé suivante, l’active et la retirée, mais signe avec l’active', async () => {
    const signer = await KeyRingSigner.fromConfig(
      await config([
        { kid: 'old', status: 'retired' },
        { kid: 'current', status: 'active' },
        { kid: 'upcoming', status: 'next' },
      ]),
      'production',
    );
    expect(signer.ephemeral).toBe(false);
    expect(signer.publicKeys().map((key) => key.kid)).toEqual(['upcoming', 'current', 'old']);
    for (const key of signer.publicKeys()) {
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      expect(key).not.toHaveProperty('d');
    }
    const token = await signer.sign({ sub: 'u-1' }, 'at+jwt');
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'current', typ: 'at+jwt' });
  });
});

describe('Chaîne complète : émission par identity, vérification par le kit, contrat du jeton', () => {
  const schema = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../contracts/tokens/access-token.v1.schema.json'), 'utf8'),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-header');
  const validateClaims = ajv.compile(schema);

  const userId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
  const sessionId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e10';

  it('un jeton émis est accepté par AccessTokenVerifier et respecte le contrat', async () => {
    const signer = await KeyRingSigner.fromConfig(undefined, 'test');
    const issuer = new AccessTokenIssuer(
      signer,
      { next: () => '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99' },
      { now: () => new Date() },
      900,
    );
    const issued = await issuer.issue({
      userId,
      sessionId,
      clientId: 'mobile',
      activeContext: 'personal',
      roles: [{ role: 'customer', scopeType: 'personal' }],
      mfa: false,
      authTime: new Date(),
    });

    expect(validateClaims(decodeJwt(issued.token)) ? [] : validateClaims.errors).toEqual([]);

    const verifier = new AccessTokenVerifier({ keys: createLocalJWKSet({ keys: signer.publicKeys() }) });
    const verified = await verifier.verify(issued.token);
    expect(verified.user).toMatchObject({ userId, sessionId, activeContext: 'personal', mfa: false });
    expect(verified.clientId).toBe('mobile');
    expect(verified.tokenId).toBe(issued.tokenId);
    expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan(890_000);
  });
});
