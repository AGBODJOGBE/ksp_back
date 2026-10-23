import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { type AccessTokenClaims } from './access-token';

const schema = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', '..', '..', 'contracts', 'tokens', 'access-token.v1.schema.json'),
    'utf8',
  ),
);

const uuid = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f';

/** Un jeton complet : si le type TypeScript diverge du schéma, ce test casse. */
const example: Required<AccessTokenClaims> = {
  iss: 'ksp-identity',
  aud: 'ksp-api',
  sub: uuid,
  client_id: 'web',
  iat: 1792400000,
  exp: 1792400900,
  jti: uuid,
  token_use: 'access',
  sid: uuid,
  ctx: 'personal',
  roles: [{ role: 'customer', scopeType: 'personal' }],
  mfa: false,
  auth_time: 1792400000,
  amr: ['otp'],
};

/** Champs facultatifs : ajoutés après la première version, absents des jetons plus anciens. */
const OPTIONAL = ['amr'];

describe('Contrat du jeton d’accès', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addKeyword('x-header');
  const validate = ajv.compile(schema);

  it('l’exemple respecte le schéma', () => {
    expect(validate(example) ? [] : validate.errors).toEqual([]);
  });

  it('accepte un contexte d’organisation et un rôle de portée org', () => {
    expect(
      validate({ ...example, ctx: uuid, roles: [{ role: 'org_admin', scopeType: 'org', scopeId: uuid }] }),
    ).toBe(true);
  });

  it('les champs du type TypeScript sont exactement ceux du schéma', () => {
    expect(Object.keys(example).sort()).toEqual(Object.keys(schema.properties).sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required, ...OPTIONAL].sort());
  });

  it('accepte un jeton du lot 1, sans amr', () => {
    const { amr: _amr, ...lot1 } = example;
    expect(validate(lot1)).toBe(true);
  });

  it('accepte un jeton du back-office : rôles internes, double authentification faite', () => {
    expect(
      validate({
        ...example,
        client_id: 'backoffice',
        roles: [
          { role: 'super_admin', scopeType: 'global', scopeId: null },
          { role: 'cleaning_supervisor', scopeType: 'domain', scopeId: 'cleaning' },
        ],
        mfa: true,
        amr: ['otp', 'mfa'],
      }),
    ).toBe(true);
  });

  it.each([
    ['un jeton de service', { token_use: 'service' }],
    ['un autre destinataire', { aud: 'autre' }],
    ['un champ non documenté', { email: 'a@b.c' }],
    ['un client inconnu', { client_id: 'tv' }],
    ['une méthode d’authentification inconnue', { amr: ['pwd'] }],
    ['une méthode en double', { amr: ['otp', 'otp'] }],
  ])('refuse %s', (_label, change) => {
    expect(validate({ ...example, ...change })).toBe(false);
  });
});
