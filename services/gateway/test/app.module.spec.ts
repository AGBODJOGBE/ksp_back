import { loadConfig, SERVICE_TOKEN_PROVIDER, ServiceTokenClient } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AuthorizeRequestUseCase } from '../src/application/access/authorize-request.use-case';
import { configSchema } from '../src/config';
import { SigningKeysCache } from '../src/infrastructure/keys/signing-keys-cache';
import { IdentityHttpController } from '../src/interfaces/http/identity.controller';
import { RedisRateLimiter } from '../src/infrastructure/rate-limit/redis-rate-limiter';
import { JwksHttpController } from '../src/interfaces/http/jwks.controller';
import { RATE_LIMITER } from '../src/tokens';

describe('AppModule', () => {
  it('assemble la gateway en développement (sans jeton de service)', async () => {
    const config = loadConfig(configSchema, { NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(IdentityHttpController)).toBeDefined();
    expect(moduleRef.get(JwksHttpController)).toBeDefined();
    expect(moduleRef.get(AuthorizeRequestUseCase)).toBeDefined();
    expect(moduleRef.get(SigningKeysCache)).toBeDefined();
    expect(moduleRef.get(SERVICE_TOKEN_PROVIDER)).toBeNull();
    await moduleRef.close();
  });

  it('assemble la gateway en production : jetons de service obtenus auprès d’identity', async () => {
    const config = loadConfig(configSchema, {
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
      REDIS_URL: 'redis://127.0.0.1:1',
      IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
      IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
      SERVICE_CLIENT_SECRET: 'secret',
      TRUST_PROXY: 'uniquelocal',
      CORS_WEB_ORIGINS: 'https://ksp.bj',
      CORS_BACKOFFICE_ORIGINS: 'https://admin.ksp.bj',
      ...Object.fromEntries(
        ['IDENTITY', 'CLEANING', 'BILLING', 'PAYMENT', 'NOTIFICATION', 'FILE', 'WALLET', 'DOCUMENT'].map(
          (service) => [`${service}_GRPC_URL`, `dns:///${service.toLowerCase()}-headless:50051`],
        ),
      ),
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(SERVICE_TOKEN_PROVIDER)).toBeInstanceOf(ServiceTokenClient);
    // Plusieurs répliques : compteurs des limites dans Redis (ADR-051).
    expect(moduleRef.get(RATE_LIMITER)).toBeInstanceOf(RedisRateLimiter);
    await moduleRef.close();
  });
});
