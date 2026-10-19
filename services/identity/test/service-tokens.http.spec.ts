import { type AddressInfo } from 'node:net';
import { Metadata } from '@grpc/grpc-js';
import { ServiceTokenClient, ServiceTokenVerifier } from '@ksp/platform';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IssueServiceTokenUseCase } from '../src/application/service-token/issue-service-token.use-case';
import { GetSigningKeysUseCase } from '../src/application/token/get-signing-keys.use-case';
import {
  ConfigServiceClientRegistry,
  sha256Hex,
} from '../src/infrastructure/service-token/config-service-client-registry';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import { KeyRingSigner } from '../src/infrastructure/token/key-ring-signer';
import { JwksHttpController } from '../src/interfaces/http/jwks.controller';
import { OAuthTokenHttpController } from '../src/interfaces/http/oauth-token.controller';

/**
 * Bout en bout sur un vrai serveur HTTP (sans base de données) : le client du kit obtient un jeton
 * sur /oauth/token, et le vérificateur du kit le valide avec les clés publiées sur /.well-known/jwks.json.
 */
describe('Jetons de service : identity en HTTP, client et vérificateur du kit', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const signer = await KeyRingSigner.fromConfig(undefined, 'test');
    const issue = new IssueServiceTokenUseCase(
      ConfigServiceClientRegistry.fromConfig(
        JSON.stringify({ gateway: { secretSha256: sha256Hex('secret-gateway'), audiences: ['identity'] } }),
      ),
      signer,
      new UuidV7Generator(),
      new SystemClock(),
      300,
    );

    @Module({
      controllers: [OAuthTokenHttpController, JwksHttpController],
      providers: [
        { provide: IssueServiceTokenUseCase, useValue: issue },
        { provide: GetSigningKeysUseCase, useValue: new GetSigningKeysUseCase(signer) },
      ],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const client = (secret: string) =>
    new ServiceTokenClient({ tokenUrl: `${baseUrl}/oauth/token`, clientId: 'gateway', clientSecret: secret });

  it('le jeton obtenu par le formulaire OAuth est accepté par le service appelé', async () => {
    const token = await client('secret-gateway').getToken('identity');
    const verifier = ServiceTokenVerifier.fromJwksUrl(
      `${baseUrl}/.well-known/jwks.json`,
      'identity',
      'ksp-identity',
    );
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${token}`);
    await expect(verifier.verify(metadata)).resolves.toBe('gateway');
  });

  it('un mauvais secret est refusé avec le code OAuth invalid_client', async () => {
    await expect(client('mauvais').getToken('identity')).rejects.toMatchObject({
      code: 'SERVICE_TOKEN_REFUSED',
      message: expect.stringContaining('invalid_client'),
    });
  });

  it('un appel non prévu par la carte des services est refusé', async () => {
    await expect(client('secret-gateway').getToken('payment')).rejects.toMatchObject({
      message: expect.stringContaining('invalid_target'),
    });
  });

  it('la réponse interdit toute mise en cache', async () => {
    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'gateway',
        client_secret: 'secret-gateway',
        audience: 'identity',
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
