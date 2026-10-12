import { ReadinessRegistry } from './readiness';

describe('ReadinessRegistry', () => {
  it('est prêt quand toutes les dépendances répondent', async () => {
    const registry = new ReadinessRegistry();
    registry.register('database', async () => 'ok');
    registry.register('rabbitmq', async () => 'ok');
    await expect(registry.run()).resolves.toEqual({
      ready: true,
      checks: { database: 'ok', rabbitmq: 'ok' },
    });
  });

  it('n’est pas prêt si une dépendance échoue ou ne répond pas à temps', async () => {
    const registry = new ReadinessRegistry();
    registry.register('database', async () => {
      throw new Error('down');
    });
    registry.register('rabbitmq', () => new Promise(() => undefined));
    const report = await registry.run(20);
    expect(report).toEqual({ ready: false, checks: { database: 'failed', rabbitmq: 'failed' } });
  });
});
