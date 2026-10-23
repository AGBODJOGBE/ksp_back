import './tracing';
import { bootstrapService, loadConfig } from '@ksp/platform';
import { AppModule } from './app.module';
import { configSchema } from './config';

async function main(): Promise<void> {
  const config = loadConfig(configSchema);
  await bootstrapService({
    module: AppModule.forRoot(config) as never,
    config,
    grpcPackages: ['cleaning', 'obligation'],
  });
}

void main();
