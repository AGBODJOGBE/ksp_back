import { AppError } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import {
  CLEANING_PERMISSION_CATALOG,
  type PermissionCatalog,
} from '../../application/rbac/permission-catalog';
import { type PermissionCatalogRegistry } from '../../application/rbac/rbac.ports';
import {
  CATALOG_REGISTRATION_MAX_DELAY_MS,
  PermissionCatalogRegistrationService,
} from './permission-catalog-registration.service';

/** Registre qui échoue `failures` fois, puis accepte. */
function registry(failures: number, error: Error = AppError.unavailable('IDENTITY_UNAVAILABLE', 'panne')) {
  const received: PermissionCatalog[] = [];
  const port: PermissionCatalogRegistry = {
    register: async (catalog) => {
      received.push(catalog);
      if (received.length <= failures) throw error;
      return { permissionsAdded: 16, permissionsRetired: 0, rolesCreated: 0 };
    },
  };
  return { port, received };
}

/** Laisse aboutir les promesses en attente sans avancer l'horloge. */
const settle = () => jest.advanceTimersByTimeAsync(0);

describe('déclaration du catalogue au démarrage (R-RB-01)', () => {
  const logs: Record<'log' | 'warn' | 'error', string[]> = { log: [], warn: [], error: [] };

  beforeEach(() => {
    jest.useFakeTimers();
    for (const level of ['log', 'warn', 'error'] as const) {
      logs[level] = [];
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs[level].push(String(args[0]));
      });
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('déclare le catalogue du service, une seule fois quand identity répond', async () => {
    const { port, received } = registry(0);
    const service = new PermissionCatalogRegistrationService(port, 5_000);
    service.onApplicationBootstrap();
    await settle();
    expect(received).toEqual([CLEANING_PERMISSION_CATALOG]);
    expect(logs.log).toEqual([
      'Catalogue des permissions déclaré à identity (version 1) : 16 permission(s) ajoutée(s), 0 retirée(s), 0 rôle(s) créé(s)',
    ]);
    await jest.advanceTimersByTimeAsync(2 * CATALOG_REGISTRATION_MAX_DELAY_MS);
    expect(received).toHaveLength(1);
  });

  it('le démarrage n’attend pas identity : un échec est journalisé, sans erreur', async () => {
    const { port, received } = registry(Number.POSITIVE_INFINITY);
    const service = new PermissionCatalogRegistrationService(port, 5_000);
    expect(service.onApplicationBootstrap()).toBeUndefined();
    await settle();
    expect(received).toHaveLength(1);
    expect(logs.warn).toEqual([
      'Catalogue des permissions non déclaré à identity (IDENTITY_UNAVAILABLE) : nouvel essai dans 5 s',
    ]);
    service.beforeApplicationShutdown();
  });

  it('réessaie avec une attente croissante, jusqu’au succès', async () => {
    const { port, received } = registry(3);
    const service = new PermissionCatalogRegistrationService(port, 5_000);
    service.onApplicationBootstrap();
    await settle();
    // Essais suivants après 5 s, puis 10 s, puis 20 s.
    await jest.advanceTimersByTimeAsync(4_999);
    expect(received).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(received).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(19_999);
    expect(received).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(4);
    expect(logs.warn.map((line) => line.split(' : ')[1])).toEqual([
      'nouvel essai dans 5 s',
      'nouvel essai dans 10 s',
      'nouvel essai dans 20 s',
    ]);
    expect(logs.log).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2 * CATALOG_REGISTRATION_MAX_DELAY_MS);
    expect(received).toHaveLength(4);
  });

  it('l’attente est plafonnée ; un refus d’identity est signalé en erreur et réessayé aussi', async () => {
    const refusal = AppError.invalid('IDENTITY_CATALOG_INVALID', 'Le catalogue déclaré est invalide.');
    const { port, received } = registry(Number.POSITIVE_INFINITY, refusal);
    const service = new PermissionCatalogRegistrationService(port, 5_000);
    service.onApplicationBootstrap();
    // 8 essais en 635 s (attentes de 5 s à 320 s) ; l'attente suivante, 640 s, est ramenée à 600 s.
    await jest.advanceTimersByTimeAsync(635_000);
    expect(received).toHaveLength(8);
    expect(logs.warn).toEqual([]);
    expect(logs.error[0]).toBe(
      'Catalogue des permissions refusé par identity (IDENTITY_CATALOG_INVALID) : nouvel essai dans 5 s',
    );
    expect(logs.error.at(-1)).toContain(`nouvel essai dans ${CATALOG_REGISTRATION_MAX_DELAY_MS / 1000} s`);
    // Ensuite, un essai toutes les 10 minutes.
    await jest.advanceTimersByTimeAsync(1_800_000);
    expect(received).toHaveLength(11);
    expect(logs.error.at(-1)).toContain('nouvel essai dans 600 s');
    service.beforeApplicationShutdown();
  });

  it('s’arrête avec le service ; désactivée avec un délai de 0', async () => {
    const failing = registry(Number.POSITIVE_INFINITY);
    const service = new PermissionCatalogRegistrationService(failing.port, 5_000);
    service.onApplicationBootstrap();
    await settle();
    service.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(2 * CATALOG_REGISTRATION_MAX_DELAY_MS);
    expect(failing.received).toHaveLength(1);

    const disabled = registry(0);
    new PermissionCatalogRegistrationService(disabled.port, 0).onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2 * CATALOG_REGISTRATION_MAX_DELAY_MS);
    expect(disabled.received).toEqual([]);
  });
});
