import { ConfigServiceClientRegistry, sha256Hex } from './config-service-client-registry';

const config = JSON.stringify({
  gateway: { secretSha256: sha256Hex('secret-gateway'), audiences: ['identity', 'notification'] },
});

describe('ConfigServiceClientRegistry', () => {
  const registry = ConfigServiceClientRegistry.fromConfig(config);

  it('reconnaît un service et son secret', () => {
    expect(registry.authenticate('gateway', 'secret-gateway')).toEqual({
      clientId: 'gateway',
      audiences: ['identity', 'notification'],
    });
  });

  it('refuse un mauvais secret ou un service inconnu', () => {
    expect(registry.authenticate('gateway', 'mauvais')).toBeNull();
    expect(registry.authenticate('inconnu', 'secret-gateway')).toBeNull();
  });

  it('sans configuration, ne reconnaît aucun service', () => {
    expect(ConfigServiceClientRegistry.fromConfig(undefined).size).toBe(0);
  });

  it.each([
    ['un JSON illisible', '{pas du json', /JSON valide/],
    [
      'une empreinte mal formée',
      JSON.stringify({ gateway: { secretSha256: 'abc', audiences: ['identity'] } }),
      /SHA-256/,
    ],
    [
      'aucun service appelé',
      JSON.stringify({ gateway: { secretSha256: sha256Hex('s'), audiences: [] } }),
      /audiences/,
    ],
    [
      'un nom en majuscules',
      JSON.stringify({ Gateway: { secretSha256: sha256Hex('s'), audiences: ['identity'] } }),
      /minuscules/,
    ],
  ])('refuse %s au démarrage', (_label, raw, message) => {
    expect(() => ConfigServiceClientRegistry.fromConfig(raw)).toThrow(message);
  });
});
