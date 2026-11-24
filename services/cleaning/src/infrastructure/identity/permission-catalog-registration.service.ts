import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { CLEANING_PERMISSION_CATALOG } from '../../application/rbac/permission-catalog';
import { type PermissionCatalogRegistry } from '../../application/rbac/rbac.ports';

export const PERMISSION_CATALOG_REGISTRY = Symbol('PERMISSION_CATALOG_REGISTRY');
export const CATALOG_REGISTRATION_RETRY_MS = Symbol('CATALOG_REGISTRATION_RETRY_MS');
/** Attente la plus longue entre deux essais : 10 minutes. */
export const CATALOG_REGISTRATION_MAX_DELAY_MS = 600_000;

/** Pannes d'identity (injoignable, trop lent) : elles passent d'elles-mêmes. */
const OUTAGE_KINDS = ['UNAVAILABLE', 'DEADLINE_EXCEEDED'];

/**
 * Déclare à identity le catalogue des permissions du Nettoyage à chaque démarrage (R-RB-01), hors du
 * chemin critique : le service démarre et répond sans attendre identity. Un échec est journalisé
 * (code de l'erreur seulement) puis réessayé avec une attente qui double à chaque essai, plafonnée à
 * 10 minutes, jusqu'au succès ou à l'arrêt du service. Une panne est un avertissement ; un refus
 * d'identity (catalogue invalide, appelant refusé) une erreur à corriger, réessayée quand même : il
 * peut être levé du côté d'identity. Délai initial 0 : déclaration désactivée.
 */
@Injectable()
export class PermissionCatalogRegistrationService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PermissionCatalogRegistrationService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;

  constructor(
    @Inject(PERMISSION_CATALOG_REGISTRY) private readonly registry: PermissionCatalogRegistry,
    @Inject(CATALOG_REGISTRATION_RETRY_MS) private readonly retryMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.retryMs <= 0) return;
    void this.attempt();
  }

  beforeApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    const catalog = CLEANING_PERMISSION_CATALOG;
    try {
      const result = await this.registry.register(catalog);
      this.logger.log(
        `Catalogue des permissions déclaré à identity (version ${catalog.version}) : ` +
          `${result.permissionsAdded} permission(s) ajoutée(s), ${result.permissionsRetired} retirée(s), ` +
          `${result.rolesCreated} rôle(s) créé(s)`,
      );
    } catch (error) {
      const delayMs = Math.min(this.retryMs * 2 ** this.failures, CATALOG_REGISTRATION_MAX_DELAY_MS);
      this.failures += 1;
      const { kind, code } = (error ?? {}) as { kind?: unknown; code?: unknown };
      const reason = typeof code === 'string' ? code : 'erreur';
      const retry = `nouvel essai dans ${Math.round(delayMs / 1000)} s`;
      if (typeof kind === 'string' && OUTAGE_KINDS.includes(kind)) {
        this.logger.warn(`Catalogue des permissions non déclaré à identity (${reason}) : ${retry}`);
      } else {
        this.logger.error(`Catalogue des permissions refusé par identity (${reason}) : ${retry}`);
      }
      if (this.stopped) return;
      this.timer = setTimeout(() => void this.attempt(), delayMs);
      this.timer.unref();
    }
  }
}
