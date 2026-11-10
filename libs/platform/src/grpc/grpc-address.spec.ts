import { z } from 'zod';
import { loadConfig } from '../config/config';
import { requireGrpcAddressesInProduction } from './grpc-address';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    IDENTITY_GRPC_URL: z.string().min(1).default('localhost:50051'),
    GEO_GRPC_URL: z.string().optional(),
  })
  .superRefine(requireGrpcAddressesInProduction);

describe('adresses gRPC des services appelés (ADR-051)', () => {
  it('valeur locale par défaut en développement', () => {
    expect(loadConfig(schema, {}).IDENTITY_GRPC_URL).toBe('localhost:50051');
  });

  it.each(['localhost:50051', 'LOCALHOST:50051', 'dns:///localhost:50051', ' localhost:50051 '])(
    'refuse en production l’hôte localhost (%s)',
    (url) => {
      expect(() => loadConfig(schema, { NODE_ENV: 'production', IDENTITY_GRPC_URL: url })).toThrow(
        'IDENTITY_GRPC_URL',
      );
    },
  );

  it('refuse en production l’adresse par défaut (variable absente)', () => {
    expect(() => loadConfig(schema, { NODE_ENV: 'production' })).toThrow('IDENTITY_GRPC_URL');
  });

  it('accepte en production l’adresse d’un service headless ; une adresse facultative absente reste permise', () => {
    const config = loadConfig(schema, {
      NODE_ENV: 'production',
      IDENTITY_GRPC_URL: 'dns:///identity-headless.ksp.svc.cluster.local:50051',
    });
    expect(config.GEO_GRPC_URL).toBeUndefined();
    expect(() =>
      loadConfig(schema, {
        NODE_ENV: 'production',
        IDENTITY_GRPC_URL: 'identity:50051',
        GEO_GRPC_URL: 'localhost:50059',
      }),
    ).toThrow('GEO_GRPC_URL');
  });
});
