import { Controller, Get, Header, HttpCode, Res } from '@nestjs/common';
import { register } from 'prom-client';
import { ReadinessRegistry } from './readiness';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

/** Sondes k3s et métriques Prometheus, exposées sur le port HTTP interne du service. */
@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessRegistry) {}

  @Get('health/live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res() response: HttpResponse): Promise<void> {
    const report = await this.readiness.run();
    response.status(report.ready ? 200 : 503).json(report);
  }

  @Get('metrics')
  @Header('Content-Type', register.contentType)
  metrics(): Promise<string> {
    return register.metrics();
  }
}
