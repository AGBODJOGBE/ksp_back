import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { type ServiceTokenClaims } from './service-token';

const schema = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', '..', '..', 'contracts', 'tokens', 'service-token.v1.schema.json'),
    'utf8',
  ),
);

const example: ServiceTokenClaims = {
  iss: 'ksp-identity',
  sub: 'gateway',
  aud: 'identity',
  iat: 1792400000,
  exp: 1792400300,
  jti: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
  token_use: 'service',
};

describe('Contrat du jeton de service', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-header');
  const validate = ajv.compile(schema);

  it('l’exemple respecte le schéma', () => {
    expect(validate(example) ? [] : validate.errors).toEqual([]);
  });

  it('les champs du type TypeScript sont exactement ceux du schéma', () => {
    expect(Object.keys(example).sort()).toEqual([...schema.required].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
  });

  it.each([
    ['un jeton d’accès', { token_use: 'access' }],
    ['un champ utilisateur', { sid: 's-1' }],
    ['un nom de service invalide', { sub: 'Gateway' }],
  ])('refuse %s', (_label, change) => {
    expect(validate({ ...example, ...change })).toBe(false);
  });
});
