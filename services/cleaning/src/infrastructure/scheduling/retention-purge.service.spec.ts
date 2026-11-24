import { Logger } from '@nestjs/common';
import { type CleaningDeps } from '../../application/deps';
import { type PersonalDataRepository } from '../../application/privacy/privacy.ports';
import { RetentionPurgeService } from './retention-purge.service';

const NOW = new Date('2030-06-03T08:00:00Z');

/** Dépôt espion : un passage efface `places` lieux, ou échoue. */
function setup(options: {
  places?: number;
  settingsFail?: boolean;
  placesFail?: boolean;
  slow?: Promise<void>;
}) {
  const passes = { count: 0 };
  const personalData = {
    withPurgeLock: async (work: () => Promise<void>) => {
      passes.count += 1;
      if (options.slow) await options.slow;
      await work();
      return true;
    },
    purgeRequestLocations: async () => ({ taken: 0, requests: 0, visitArrivals: 0 }),
    purgeSessionArrivals: async () => ({ taken: 0, sessionArrivals: 0 }),
    purgePlaceLocations: async () => {
      if (options.placesFail) throw new Error('verrou perdu');
      return options.places ?? 0;
    },
    expiredVisitPhotos: async () => [],
    expiredSessionPhotos: async () => [],
    purgeIdempotencyRecords: async () => 0,
  } as unknown as PersonalDataRepository;
  const deps = {
    personalData,
    moduleSettings: {
      read: async () => {
        if (options.settingsFail) throw new Error('base injoignable');
        return { settings: { retentionMonths: 12 } };
      },
    },
    clock: { now: () => NOW },
  } as unknown as CleaningDeps;
  return { deps, passes };
}

describe('RetentionPurgeService : tâche planifiée de conservation (UC-NT-48, RV-13)', () => {
  let logs: Record<'log' | 'warn' | 'error', string[]>;

  beforeEach(() => {
    logs = { log: [], warn: [], error: [] };
    const capture = (level: 'log' | 'warn' | 'error') => (message: unknown) => {
      logs[level].push(String(message));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture('log'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture('warn'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture('error'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('intervalle 0 : tâche désactivée, aucun passage', () => {
    jest.useFakeTimers();
    const { deps, passes } = setup({});
    const service = new RetentionPurgeService(deps, 0);
    service.onApplicationBootstrap();
    jest.advanceTimersByTime(24 * 3_600_000);
    expect(passes.count).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    service.beforeApplicationShutdown();
  });

  it('un passage par intervalle, arrêté à la fermeture', async () => {
    jest.useFakeTimers();
    const { deps, passes } = setup({});
    const service = new RetentionPurgeService(deps, 21_600_000);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(21_600_000);
    expect(passes.count).toBe(1);
    await jest.advanceTimersByTimeAsync(21_600_000);
    expect(passes.count).toBe(2);
    service.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(3 * 21_600_000);
    expect(passes.count).toBe(2);
  });

  it('un seul passage à la fois dans l’instance', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, passes } = setup({ slow });
    const service = new RetentionPurgeService(deps, 0);
    const first = service.tick();
    await service.tick();
    expect(passes.count).toBe(1);
    release();
    await first;
    await service.tick();
    expect(passes.count).toBe(2);
  });

  it('journalise des nombres ; rien quand rien n’est effacé', async () => {
    const quiet = new RetentionPurgeService(setup({}).deps, 0);
    await quiet.tick();
    expect(logs).toEqual({ log: [], warn: [], error: [] });

    const busy = new RetentionPurgeService(setup({ places: 3 }).deps, 0);
    await busy.tick();
    expect(logs.log).toEqual([
      "Conservation : 0 demande(s), 3 lieu(x), 0 position(s) d'arrivée et 0 photo(s) effacés ; " +
        "0 clé(s) d'idempotence supprimée(s)",
    ]);
  });

  it('étape en échec : signalée et comptée, le passage continue ; passage en échec : journalisé', async () => {
    const partial = new RetentionPurgeService(setup({ placesFail: true }).deps, 0);
    await partial.tick();
    expect(logs.warn).toEqual([
      'Conservation, étape place_locations en échec : verrou perdu',
      'Conservation : 1 élément(s) repris au prochain passage',
    ]);

    const broken = new RetentionPurgeService(setup({ settingsFail: true }).deps, 0);
    await expect(broken.tick()).resolves.toBeUndefined();
    expect(logs.error).toEqual(['Conservation en échec : base injoignable']);
    // La tâche reste utilisable après un échec.
    await broken.tick();
    expect(logs.error).toHaveLength(2);
  });
});
