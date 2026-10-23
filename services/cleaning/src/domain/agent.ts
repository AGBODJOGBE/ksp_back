import { type BusyPeriod, type Slot } from './schedule';

/**
 * Agents et équipes (UC-CL-12). Un agent est un compte KSP existant, rattaché par l'admin
 * Nettoyage ; une équipe sert à affecter plusieurs agents d'un coup à un passage.
 */
export interface Unavailability {
  id: string;
  slot: Slot;
  reason: string | null;
}

export interface Agent {
  agentId: string;
  displayName: string;
  active: boolean;
  unavailabilities: Unavailability[];
}

export interface Team {
  id: string;
  name: string;
  memberIds: string[];
}

export const DISPLAY_NAME_MAX_LENGTH = 100;

export function normalizeDisplayName(value: string): string | null {
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= DISPLAY_NAME_MAX_LENGTH ? name : null;
}

/** Indisponibilités déclarées, vues comme des périodes occupées. */
export function unavailabilityPeriods(agents: Agent[]): BusyPeriod[] {
  return agents.flatMap((agent) =>
    agent.unavailabilities.map((unavailability) => ({ agentId: agent.agentId, slot: unavailability.slot })),
  );
}
