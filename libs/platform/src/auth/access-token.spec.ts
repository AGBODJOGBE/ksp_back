import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { AppError } from '../errors/app-error';
import { AccessTokenVerifier } from './access-token';

describe('AccessTokenVerifier', () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let otherKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let verifier: AccessTokenVerifier;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('ES256')).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
    verifier = new AccessTokenVerifier({ keys: createLocalJWKSet({ keys: [jwk] }) });
  });

  const claims = {
    client_id: 'web',
    jti: 'j-1',
    token_use: 'access',
    sid: 's-1',
    ctx: 'personal',
    roles: [{ role: 'customer', scopeType: 'personal' }],
    mfa: false,
    auth_time: 1792400000,
  };

  const sign = (
    overrides: Record<string, unknown> = {},
    options: { typ?: string; aud?: string; exp?: string | number; key?: typeof privateKey } = {},
  ) =>
    new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: options.typ ?? 'at+jwt' })
      .setIssuer('ksp-identity')
      .setAudience(options.aud ?? 'ksp-api')
      .setSubject('u-1')
      .setIssuedAt()
      .setExpirationTime(options.exp ?? '15m')
      .sign(options.key ?? privateKey);

  it('accepte un jeton valide et en tire le contexte utilisateur', async () => {
    const verified = await verifier.verify(await sign());
    expect(verified.user).toEqual({
      userId: 'u-1',
      sessionId: 's-1',
      activeContext: 'personal',
      roles: [{ role: 'customer', scopeType: 'personal', scopeId: null }],
      mfa: false,
      authTime: 1792400000,
    });
    expect(verified.clientId).toBe('web');
    expect(verified.tokenId).toBe('j-1');
  });

  it('distingue un jeton expiré', async () => {
    const expired = await sign({}, { exp: Math.floor(Date.now() / 1000) - 120 });
    await expect(verifier.verify(expired)).rejects.toMatchObject({ code: 'GATEWAY_TOKEN_EXPIRED' });
  });

  it.each([
    ['un jeton de service', () => sign({ token_use: 'service' })],
    ['un mauvais type d’en-tête', () => sign({}, { typ: 'JWT' })],
    ['un autre destinataire', () => sign({}, { aud: 'identity' })],
    ['une signature d’une clé inconnue', () => sign({}, { key: otherKey })],
    ['un jeton sans session', () => sign({ sid: undefined })],
    ['un texte qui n’est pas un jeton', async () => 'pas-un-jeton'],
  ])('refuse %s', async (_label, make) => {
    await expect(verifier.verify(await make())).rejects.toMatchObject({
      code: 'GATEWAY_TOKEN_INVALID',
      kind: 'UNAUTHENTICATED',
    });
  });

  it('refuse un jeton non signé (alg none)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ ...claims, sub: 'u-1', iss: 'ksp-identity', aud: 'ksp-api' }),
    ).toString('base64url');
    await expect(verifier.verify(`${header}.${body}.`)).rejects.toMatchObject({
      code: 'GATEWAY_TOKEN_INVALID',
    });
  });

  it('laisse passer l’indisponibilité des clés : ce n’est pas un jeton invalide', async () => {
    const down = new AccessTokenVerifier({
      keys: async () => {
        throw AppError.unavailable('IDENTITY_UNAVAILABLE', 'Service indisponible.');
      },
    });
    await expect(down.verify(await sign())).rejects.toMatchObject({
      code: 'IDENTITY_UNAVAILABLE',
      kind: 'UNAVAILABLE',
    });
  });
});
