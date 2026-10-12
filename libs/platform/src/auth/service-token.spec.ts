import { Metadata } from '@grpc/grpc-js';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { ServiceTokenVerifier } from './service-token';

describe('ServiceTokenVerifier', () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let verifier: ServiceTokenVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
    verifier = new ServiceTokenVerifier({
      audience: 'identity',
      issuer: 'ksp-identity',
      keys: createLocalJWKSet({ keys: [jwk] }),
    });
  });

  const sign = (claims: Record<string, unknown>, audience = 'identity') =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer('ksp-identity')
      .setAudience(audience)
      .setSubject('gateway')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  const metadataWith = (token?: string) => {
    const metadata = new Metadata();
    if (token) metadata.set('authorization', `Bearer ${token}`);
    return metadata;
  };

  it('accepte un jeton de service valide et renvoie le service appelant', async () => {
    await expect(verifier.verify(metadataWith(await sign({ token_use: 'service' })))).resolves.toBe(
      'gateway',
    );
  });

  it('refuse un appel sans jeton', async () => {
    await expect(verifier.verify(metadataWith())).rejects.toMatchObject({ code: 'SERVICE_TOKEN_MISSING' });
  });

  it('refuse un jeton émis pour un autre service', async () => {
    const token = await sign({ token_use: 'service' }, 'wallet');
    await expect(verifier.verify(metadataWith(token))).rejects.toMatchObject({
      code: 'SERVICE_TOKEN_INVALID',
    });
  });

  it('refuse un jeton d’utilisateur présenté comme jeton de service', async () => {
    const token = await sign({ token_use: 'access' });
    await expect(verifier.verify(metadataWith(token))).rejects.toMatchObject({ kind: 'UNAUTHENTICATED' });
  });
});
