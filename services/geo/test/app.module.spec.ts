import { loadConfig } from '@ksp/platform';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configSchema } from '../src/config';
import { GeoGrpcController } from '../src/interfaces/grpc/geo.controller';

describe('AppModule', () => {
  it('assemble le service sans base, sans RabbitMQ ni OSRM', async () => {
    const config = loadConfig(configSchema, {
      SERVICE_NAME: 'geo',
      NODE_ENV: 'test',
      GRPC_PORT: '50059',
      HTTP_PORT: '3109',
      OSRM_URL: '',
    });
    expect(config.OSRM_URL).toBeUndefined();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    const controller = moduleRef.get(GeoGrpcController);
    await expect(controller.reverseGeocode({ point: { latitude: 6.37, longitude: 2.39 } })).resolves.toEqual({
      communes: [],
      displayAddress: '',
      provider: '',
    });
    await expect(
      controller.route({
        points: [
          { latitude: 6.37, longitude: 2.39 },
          { latitude: 6.45, longitude: 2.36 },
        ],
        profile: '',
      }),
    ).rejects.toMatchObject({ code: 'GEO_ROUTING_UNAVAILABLE' });
    await moduleRef.close();
  });
});
