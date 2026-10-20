import { AccessTokenVerifier } from '@ksp/platform';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { type PublicSigningKey } from '../../application/keys/public-keys';
import { HttpJwksSource } from './http-jwks.source';
import { type JwksSource, SigningKeysCache } from './signing-keys-cache';

async function keyPair(kid: string): Promise<{ privateKey: KeyLike; jwk: PublicSigningKey }> {
  const pair = await generateKeyPair('ES256');
  const jwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwk: { kid, kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, alg: 'ES256', use: 'sig' },
  };
}

function sign(privateKey: KeyLike, kid: string): Promise<string> {
  return new SignJWT({
    client_id: 'web',
    jti: 'j-1',
    token_use: 'access',
    sid: 's-1',
    ctx: 'personal',
    roles: [],
    mfa: false,
    auth_time: 1,
  })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
    .setIssuer('ksp-identity')
    .setAudience('ksp-api')
    .setSubject('u-1')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(privateKey);
}

class ScriptedSource implements JwksSource {
  calls = 0;
  keys: PublicSigningKey[] = [];
  down = false;

  async fetch(): Promise<PublicSigningKey[]> {
    this.calls += 1;
    if (this.down) throw new Error('connect ECONNREFUSED 10.0.3.12:3101');
    return this.keys;
  }
}

function setup() {
  let now = new Date('2026-10-20T10:00:00Z').getTime();
  const source = new ScriptedSource();
  const cache = new SigningKeysCache(
    source,
    { ttlSeconds: 600, reloadCooldownSeconds: 30 },
    { now: () => new Date(now) },
  );
  const advance = (seconds: number) => {
    now += seconds * 1000;
  };
  return { source, cache, advance, verifier: new AccessTokenVerifier({ keys: cache.resolveKey }) };
}

describe('SigningKeysCache', () => {
  it('garde les clés 10 minutes, puis les recharge', async () => {
    const { source, cache, advance } = setup();
    const k1 = await keyPair('k1');
    source.keys = [k1.jwk];
    await cache.publicKeys();
    advance(599);
    await cache.publicKeys();
    expect(source.calls).toBe(1);
    advance(1);
    await cache.publicKeys();
    expect(source.calls).toBe(2);
  });

  it('vérifie un jeton avec une clé en cache, sans appeler identity à chaque requête', async () => {
    const { source, cache, verifier } = setup();
    const k1 = await keyPair('k1');
    source.keys = [k1.jwk];
    await cache.ensureLoaded();
    for (let i = 0; i < 3; i += 1) {
      await expect(verifier.verify(await sign(k1.privateKey, 'k1'))).resolves.toMatchObject({
        user: { userId: 'u-1' },
      });
    }
    expect(source.calls).toBe(1);
  });

  it('clé inconnue : rechargement immédiat (rotation), au plus une fois par délai minimum', async () => {
    const { source, cache, advance, verifier } = setup();
    const k1 = await keyPair('k1');
    const k2 = await keyPair('k2');
    source.keys = [k1.jwk];
    await cache.ensureLoaded();
    advance(31);
    source.keys = [k1.jwk, k2.jwk];
    await expect(verifier.verify(await sign(k2.privateKey, 'k2'))).resolves.toBeDefined();
    expect(source.calls).toBe(2);

    // Rafale de jetons forgés avec une clé inconnue : pas de nouvel appel avant le délai minimum.
    const forged = await keyPair('k9');
    for (let i = 0; i < 5; i += 1) {
      await expect(verifier.verify(await sign(forged.privateKey, 'k9'))).rejects.toMatchObject({
        code: 'GATEWAY_TOKEN_INVALID',
      });
    }
    expect(source.calls).toBe(2);
    advance(30);
    await expect(verifier.verify(await sign(forged.privateKey, 'k9'))).rejects.toMatchObject({
      code: 'GATEWAY_TOKEN_INVALID',
    });
    expect(source.calls).toBe(3);
  });

  it('identity injoignable : les dernières clés connues restent utilisées', async () => {
    const { source, cache, advance, verifier } = setup();
    const k1 = await keyPair('k1');
    source.keys = [k1.jwk];
    await cache.ensureLoaded();
    advance(601);
    source.down = true;
    await expect(verifier.verify(await sign(k1.privateKey, 'k1'))).resolves.toBeDefined();
    expect(await cache.publicKeys()).toEqual([k1.jwk]);
    // Pas de nouvel essai avant le délai minimum.
    expect(source.calls).toBe(2);
  });

  it('aucune clé et identity injoignable : 503 IDENTITY_UNAVAILABLE, jamais un 401', async () => {
    const { source, cache, advance, verifier } = setup();
    source.down = true;
    const k1 = await keyPair('k1');
    await expect(cache.ensureLoaded()).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
      code: 'IDENTITY_UNAVAILABLE',
    });
    await expect(verifier.verify(await sign(k1.privateKey, 'k1'))).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
    });
    expect(source.calls).toBe(1);
    advance(30);
    source.down = false;
    source.keys = [k1.jwk];
    await expect(verifier.verify(await sign(k1.privateKey, 'k1'))).resolves.toBeDefined();
  });

  it('deux demandes simultanées partagent le même chargement', async () => {
    const { source, cache } = setup();
    source.keys = [(await keyPair('k1')).jwk];
    await Promise.all([cache.publicKeys(), cache.publicKeys(), cache.publicKeys()]);
    expect(source.calls).toBe(1);
  });
});

describe('HttpJwksSource', () => {
  const key = {
    kid: 'k1',
    kty: 'EC',
    crv: 'P-256',
    x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    alg: 'ES256',
    use: 'sig',
  };
  const source = (response: Response) =>
    new HttpJwksSource({
      url: 'http://identity:3101/.well-known/jwks.json',
      fetchImpl: async () => response,
    });

  it('lit les clés ES256 et écarte tout le reste', async () => {
    const body = {
      keys: [key, { ...key, kid: 'rsa', kty: 'RSA' }, { ...key, kid: 'k2', d: 'secret', extra: 1 }],
    };
    await expect(source(Response.json(body)).fetch()).resolves.toEqual([key, { ...key, kid: 'k2' }]);
  });

  it.each([
    ['une erreur HTTP', new Response('oops', { status: 500 })],
    ['un document sans clés', Response.json({ nope: true })],
    ['aucune clé utilisable', Response.json({ keys: [{ ...key, alg: 'RS256' }] })],
  ])('échoue sur %s', async (_label, response) => {
    await expect(source(response).fetch()).rejects.toThrow(/JWKS d'identity/);
  });
});
