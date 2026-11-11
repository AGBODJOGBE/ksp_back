import { Controller, Get, Header, HttpCode, Optional, Res } from '@nestjs/common';
import { register } from 'prom-client';
import { ReadinessRegistry } from './readiness';
import { ShutdownState } from './shutdown';

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

/** Sondes k3s et métriques Prometheus, exposées sur le port HTTP interne du service. */
@Controller()
export class HealthController {
  constructor(
    private readonly readiness: ReadinessRegistry,
    @Optional() private readonly shutdown?: ShutdownState,
  ) {}

  @Get('health/live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res() response: HttpResponse): Promise<void> {
    // Arrêt en cours (ADR-051) : retirée de la répartition, même si ses dépendances répondent.
    if (this.shutdown?.draining) {
      response.status(503).json({ ready: false, checks: { shutdown: 'failed' } });
      return;
    }
    const report = await this.readiness.run();
    response.status(report.ready ? 200 : 503).json(report);
  }

  @Get('metrics')
  @Header('Content-Type', register.contentType)
  metrics(): Promise<string> {
    return register.metrics();
  }
}
