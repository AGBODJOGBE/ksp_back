import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ObligationGrpcController } from '../src/interfaces/grpc/obligation.controller';
import { configSchema } from '../src/config';
import {
  RecoveryAdminGrpcController,
  RecoveryCreditorGrpcController,
  RecoveryDebtorGrpcController,
  RecoveryPartnerGrpcController,
} from '../src/interfaces/grpc/recovery.controller';

describe('AppModule', () => {
  it('assemble toutes les dépendances du service', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'recovery',
      NODE_ENV: 'test',
      GRPC_PORT: '50060',
      HTTP_PORT: '3110',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RABBITMQ_URL: 'amqp://localhost',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    expect(moduleRef.get(RecoveryCreditorGrpcController)).toBeDefined();
    expect(moduleRef.get(RecoveryDebtorGrpcController)).toBeDefined();
    expect(moduleRef.get(RecoveryPartnerGrpcController)).toBeDefined();
    expect(moduleRef.get(RecoveryAdminGrpcController)).toBeDefined();
    expect(moduleRef.get(ObligationGrpcController)).toBeDefined();
    await moduleRef.close();
  });

  it("répond « pas encore disponible » tant qu'un cas d'usage n'est pas livré", async () => {
    await expect(new RecoveryCreditorGrpcController({} as never).createCase()).rejects.toMatchObject({
      code: 'RECOVERY_NOT_IMPLEMENTED',
    });
  });
});
