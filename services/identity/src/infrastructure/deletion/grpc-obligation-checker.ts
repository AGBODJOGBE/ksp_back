import { type commonV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import {
  type ObligationCheck,
  type ObligationChecker,
} from '../../application/deletion/account-deletion.ports';
import { type DeletionObstacle } from '../../domain/user/account-deletion';

/** Un service interrogé avant la suppression d'un compte (ksp.common.v1.ObligationService). */
export interface ObligationTarget {
  /** Nom du service (cleaning, billing, payment…), aussi audience du jeton de service. */
  service: string;
  client: Pick<commonV1.ObligationServiceClient, 'hasPendingObligations'>;
  caller: Pick<GrpcCaller, 'call'>;
}

/**
 * Interroge en parallèle chaque service qui peut empêcher la suppression d'un compte (UC-ID-11,
 * ADR-036). Une seule obligation suffit à bloquer ; un service qui ne répond pas (panne, délai,
 * coupe-circuit, refus) rend le contrôle « injoignable » : la suppression est alors refusée, jamais
 * accordée par défaut. Pas de nouvelle tentative : la réponse doit rester sous le délai de la gateway.
 */
export class GrpcObligationChecker implements ObligationChecker {
  private readonly logger = new Logger('ObligationChecker');

  constructor(
    private readonly targets: readonly ObligationTarget[],
    private readonly deadlineMs: number,
  ) {}

  async check(userId: string): Promise<ObligationCheck> {
    const results = await Promise.allSettled(
      this.targets.map((target) =>
        target.caller.call(
          'hasPendingObligations',
          (metadata) => target.client.hasPendingObligations({ userId, organizationId: '' }, metadata),
          { idempotent: true, retries: 0, deadlineMs: this.deadlineMs },
        ),
      ),
    );

    const unavailable: string[] = [];
    const obstacles: DeletionObstacle[] = [];
    results.forEach((result, index) => {
      const service = this.targets[index]!.service;
      if (result.status === 'rejected') {
        const code = (result.reason as { code?: string })?.code ?? 'erreur';
        this.logger.warn(`${service}.HasPendingObligations injoignable (${code}).`);
        unavailable.push(service);
        return;
      }
      const response = result.value;
      const found = response.obligations.map((obligation) => ({
        service,
        kind: obligation.kind,
        reference: obligation.reference,
        description: obligation.description,
      }));
      if (response.hasPending && found.length === 0) {
        // Réponse positive sans détail : elle bloque quand même, avec une raison générique.
        found.push({
          service,
          kind: 'pending_obligation',
          reference: '',
          description: 'Une opération est encore en cours.',
        });
      }
      obstacles.push(...found);
    });

    if (unavailable.length > 0) return { status: 'unavailable', services: unavailable };
    if (obstacles.length > 0) return { status: 'blocked', obstacles };
    return { status: 'clear' };
  }
}

/**
 * Services interrogés, lus dans la configuration : « nom=hôte:port » séparés par des virgules,
 * par exemple « cleaning=localhost:50053,billing=localhost:50054 ».
 */
export function parseObligationServices(value: string): { service: string; url: string }[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [service, url] = entry.split('=').map((part) => part.trim());
      if (!service || !url || !/^[a-z][a-z0-9-]*$/.test(service)) {
        throw new Error(`OBLIGATION_SERVICES : entrée invalide « ${entry} » (nom=hôte:port attendu).`);
      }
      return { service, url };
    });
}
