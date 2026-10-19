import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { AccountGrpcController } from '../src/interfaces/grpc/account.controller';
import { AuthGrpcController } from '../src/interfaces/grpc/auth.controller';
import { IdentityGrpcController } from '../src/interfaces/grpc/identity.controller';
import { JwksHttpController } from '../src/interfaces/http/jwks.controller';
import { OAuthTokenHttpController } from '../src/interfaces/http/oauth-token.controller';

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'identity',
      NODE_ENV: 'test',
      GRPC_PORT: '50051',
      HTTP_PORT: '3101',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
      OTP_HMAC_SECRET: 'test-secret-test-secret-test-secret-00',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(IdentityGrpcController)).toBeDefined();
    expect(moduleRef.get(AuthGrpcController)).toBeDefined();
    expect(moduleRef.get(AccountGrpcController)).toBeDefined();
    expect(moduleRef.get(JwksHttpController).jwks().keys).toHaveLength(1);
    expect(moduleRef.get(OAuthTokenHttpController)).toBeDefined();
    await moduleRef.close();
  });
});
