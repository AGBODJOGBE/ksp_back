import { isInForce } from '../../domain/planning/assignment-status';
import { type CleaningDeps } from '../deps';

/**
 * Agenda des agents d'une visite (lot D). R-VI-06, RV-65 : quand une visite prend fin (annulée,
 * manquée), ses affectations en vigueur sont retirées et l'agenda des agents est libéré. Le retrait
 * suit l'écriture du dossier, dans la transaction de la planification (verrou de l'agenda).
 */
export async function visitAgents(deps: CleaningDeps, visitId: string, now: Date): Promise<string[]> {
  const [target] = await deps.planning.targets([{ kind: 'visit', id: visitId }]);
  return (target?.assignments ?? []).filter((item) => isInForce(item, now)).map((item) => item.agentId);
}

/** Retire les affectations en vigueur de la visite ; rend les agents libérés. */
export async function releaseVisitAgents(
  deps: CleaningDeps,
  visitId: string,
  removal: { by: string | null; reason: string; at: Date },
): Promise<string[]> {
  const [target] = await deps.planning.targets([{ kind: 'visit', id: visitId }]);
  const live = (target?.assignments ?? []).filter((item) => isInForce(item, removal.at));
  if (!live.length) return [];
  await deps.planning.transaction(async (tx) => {
    await tx.lockAgents(live.map((item) => item.agentId));
    await tx.removeAssignments(
      live.map((item) => item.id),
      removal,
    );
  });
  return live.map((item) => item.agentId);
}
