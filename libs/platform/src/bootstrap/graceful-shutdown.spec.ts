import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from '../health/health.controller';
import { ReadinessRegistry } from '../health/readiness';
import { ShutdownState } from '../health/shutdown';
import { gracefulShutdown } from './graceful-shutdown';

@Module({ controllers: [HealthController], providers: [ReadinessRegistry, ShutdownState] })
class HealthOnlyModule {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('arrêt en douceur (ADR-051)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthOnlyModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close().catch(() => undefined);
  });

  it('au SIGTERM, la sonde « prêt » répond 503 aussitôt, puis l’application se ferme après le délai', async () => {
    const http = request(app.getHttpServer());
    await http.get('/health/ready').expect(200);

    const exits: number[] = [];
    let drained = false;
    const close = jest.spyOn(app, 'close');
    const shutdown = gracefulShutdown(app, app.get(ShutdownState), {
      delayMs: 150,
      onDrain: () => {
        drained = true;
      },
      exit: (code) => exits.push(code),
    });

    const done = shutdown('SIGTERM');
    // Pendant le délai : toujours en service, mais retirée de la répartition.
    const ready = await http.get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ ready: false, checks: { shutdown: 'failed' } });
    await http.get('/health/live').expect(200);
    expect(drained).toBe(true);
    expect(close).not.toHaveBeenCalled();

    await done;
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });

  it('Ctrl+C (SIGINT) en développement : fermeture sans délai ; un second signal est ignoré', async () => {
    const exits: number[] = [];
    const close = jest.spyOn(app, 'close');
    const shutdown = gracefulShutdown(app, app.get(ShutdownState), {
      delayMs: 10_000,
      exit: (code) => exits.push(code),
    });
    const started = Date.now();
    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM')]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });

  it('échec de la fermeture : sortie en erreur', async () => {
    const exits: number[] = [];
    jest.spyOn(app, 'close').mockRejectedValueOnce(new Error('broker'));
    const shutdown = gracefulShutdown(app, app.get(ShutdownState), {
      delayMs: 0,
      exit: (code) => exits.push(code),
    });
    await shutdown('SIGTERM');
    await sleep(0);
    expect(exits).toEqual([1]);
  });
});
