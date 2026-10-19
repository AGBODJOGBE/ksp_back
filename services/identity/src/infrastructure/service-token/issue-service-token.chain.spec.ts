import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Metadata } from '@grpc/grpc-js';
import { ServiceTokenVerifier } from '@ksp/platform';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createLocalJWKSet, decodeJwt } from 'jose';
import { ConfigServiceClientRegistry, sha256Hex } from './config-service-client-registry';
import { KeyRingSigner } from '../token/key-ring-signer';
import {
  IssueServiceTokenUseCase,
  ServiceTokenError,
} from '../../application/service-token/issue-service-token.use-case';

async function setup() {
  const signer = await KeyRingSigner.fromConfig(undefined, 'test');
  const registry = ConfigServiceClientRegistry.fromConfig(
    JSON.stringify({ gateway: { secretSha256: sha256Hex('secret-gateway'), audiences: ['identity'] } }),
  );
  const useCase = new IssueServiceTokenUseCase(
    registry,
    signer,
    { next: () => '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f' },
    { now: () => new Date() },
    300,
  );
  return { signer, useCase };
}

const valid = {
  grantType: 'client_credentials',
  clientId: 'gateway',
  clientSecret: 'secret-gateway',
  audience: 'identity',
};

function bearer(token: string): Metadata {
  const metadata = new Metadata();
  metadata.set('authorization', `Bearer ${token}`);
  return metadata;
}

describe('IssueServiceTokenUseCase avec le registre et le trousseau réels', () => {
  it.each([
    ['un autre flux que client_credentials', { grantType: 'password' }, 'unsupported_grant_type'],
    ['une demande incomplète', { audience: undefined }, 'invalid_request'],
    ['un mauvais secret', { clientSecret: 'mauvais' }, 'invalid_client'],
    ['un service inconnu', { clientId: 'inconnu' }, 'invalid_client'],
    ['un appel non prévu par la carte des services', { audience: 'payment' }, 'invalid_target'],
  ])('refuse %s', async (_label, change, code) => {
    const { useCase } = await setup();
    const error = await useCase.execute({ ...valid, ...change }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceTokenError);
    expect((error as ServiceTokenError).code).toBe(code);
  });

  it('émet un jeton de 5 minutes accepté par le service appelé et conforme au contrat', async () => {
    const { signer, useCase } = await setup();
    const issued = await useCase.execute(valid);
    expect(issued.expiresIn).toBe(300);

    const schema = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../../../../contracts/tokens/service-token.v1.schema.json'),
        'utf8',
      ),
    );
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addKeyword('x-header');
    const validate = ajv.compile(schema);
    expect(validate(decodeJwt(issued.accessToken)) ? [] : validate.errors).toEqual([]);

    const verifier = new ServiceTokenVerifier({
      audience: 'identity',
      issuer: 'ksp-identity',
      keys: createLocalJWKSet({ keys: signer.publicKeys() }),
    });
    await expect(verifier.verify(bearer(issued.accessToken))).resolves.toBe('gateway');
  });

  it("n'est jamais accepté par un autre service que son destinataire", async () => {
    const { signer, useCase } = await setup();
    const issued = await useCase.execute(valid);
    const verifier = new ServiceTokenVerifier({
      audience: 'notification',
      issuer: 'ksp-identity',
      keys: createLocalJWKSet({ keys: signer.publicKeys() }),
    });
    await expect(verifier.verify(bearer(issued.accessToken))).rejects.toMatchObject({
      code: 'SERVICE_TOKEN_INVALID',
    });
  });

  it('identity signe ses propres jetons sur place, en son nom', async () => {
    const { useCase } = await setup();
    const issued = await useCase.issueForIdentity('notification');
    expect(decodeJwt(issued.accessToken)).toMatchObject({
      sub: 'identity',
      aud: 'notification',
      token_use: 'service',
    });
  });
});
