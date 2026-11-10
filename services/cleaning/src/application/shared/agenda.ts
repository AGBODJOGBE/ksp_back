import { visitSlot } from '../../domain/agenda';
import { conflictingAgents } from '../../domain/schedule';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from './errors';

/**
 * Visite technique (ADR-053) : même règle que les passages. L'agent ne doit avoir ni passage, ni
 * autre visite, ni indisponibilité sur la durée réglée d'une visite ; sinon CLEANING_TEAM_UNAVAILABLE.
 * Les visites remplacées par cette planification (`replacedVisitIds`) ne comptent pas ; comme pour
 * les passages (ADR-035), ce qui est déjà prévu au même lieu (groupe `groupId`) n'est pas un conflit.
 *
 * Contrôle fait avant l'enregistrement, sans verrou : deux planifications simultanées du même agent
 * au même moment restent possibles (volume du back-office faible, à revoir si besoin).
 */
export async function assertVisitAgentFree(
  deps: CleaningDeps,
  agentId: string,
  scheduledAt: Date,
  replacedVisitIds: readonly string[],
  groupId: string | null,
): Promise<void> {
  const { visitDurationMinutes } = await deps.catalog.getSettings();
  const busy = await deps.agents.busyPeriods([agentId], {
    visitDurationMinutes,
    excludedVisitIds: replacedVisitIds,
  });
  const conflicts = conflictingAgents([agentId], visitSlot(scheduledAt, visitDurationMinutes), busy, groupId);
  if (conflicts.length) throw CleaningErrors.teamUnavailable(conflicts);
}
