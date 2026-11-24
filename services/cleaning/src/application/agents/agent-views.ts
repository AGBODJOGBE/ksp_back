import { type ExtraAvailability, type WeeklyRange } from '../../domain/planning/availability';
import { type CleaningDeps } from '../deps';
import { cleaningErrors } from '../shared/errors';
import { formatMinute, instant, minuteOfDay } from '../shared/input';
import { type AgentRecord, type AgentStatsRecord, type UnavailabilityRecord } from './agent.ports';

/**
 * Vues d'un agent et de ses disponibilités, et lecture des disponibilités reçues (contrat :
 * AvailabilityRule avec jours "mon"…"sun" et plages "HH:MM" à l'heure de Porto-Novo).
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Contextes de chiffrement : un chiffré n'est lisible que sur sa ligne et son champ. */
export const cipherContext = {
  idDocument: (agentId: string) => `agent:${agentId}:id_document`,
  emergencyContact: (agentId: string) => `agent:${agentId}:emergency_contact`,
  mobileMoney: (agentId: string) => `agent:${agentId}:mobile_money`,
  /** Piste A : numéro invité (R-AG-02). */
  invitationPhone: (invitationId: string) => `agent_invitation:${invitationId}:phone`,
};

export interface EmergencyContact {
  name: string;
  phone: string;
}

export interface AgentProfile {
  agent: AgentRecord;
  emergencyContact: EmergencyContact | null;
  mobileMoneyNumber: string | null;
  hasIdDocument: boolean;
  photoUrl: string | null;
  stats: AgentStatsRecord;
}

const NO_STATS: AgentStatsRecord = {
  sessionsCompleted: 0,
  visitsCompleted: 0,
  hoursThisWeek: 0,
  hoursThisMonth: 0,
  openClaims: 0,
};

/** Photo de l'agent chez file (lien temporaire), au mieux : absente si file ne répond pas. */
async function photoUrl(deps: CleaningDeps, agent: AgentRecord): Promise<string | null> {
  if (!agent.photoFileId) return null;
  try {
    const files = await deps.photos.list({ type: 'cleaning_agent', id: agent.id });
    return files.find((file) => file.fileId === agent.photoFileId)?.downloadUrl ?? null;
  } catch {
    return null;
  }
}

/** Fiches d'agents : données personnelles déchiffrées, activité et photo (`withPhoto`). */
export async function agentProfiles(
  deps: CleaningDeps,
  agents: readonly AgentRecord[],
  withPhoto: boolean,
): Promise<AgentProfile[]> {
  const stats = await deps.planning.agentStats(
    agents.map((a) => a.id),
    deps.clock.now(),
  );
  return Promise.all(
    agents.map(async (agent) => ({
      agent,
      emergencyContact: agent.emergencyContactEncrypted
        ? (JSON.parse(
            deps.cipher.decrypt(agent.emergencyContactEncrypted, cipherContext.emergencyContact(agent.id)),
          ) as EmergencyContact)
        : null,
      mobileMoneyNumber: agent.mobileMoneyEncrypted
        ? deps.cipher.decrypt(agent.mobileMoneyEncrypted, cipherContext.mobileMoney(agent.id))
        : null,
      hasIdDocument: agent.idDocumentEncrypted !== null,
      photoUrl: withPhoto ? await photoUrl(deps, agent) : null,
      stats: stats.get(agent.id) ?? NO_STATS,
    })),
  );
}

export async function agentProfile(deps: CleaningDeps, agent: AgentRecord): Promise<AgentProfile> {
  const [profile] = await agentProfiles(deps, [agent], true);
  return profile!;
}

export interface UnavailabilityView extends UnavailabilityRecord {
  createdByName: string | null;
}

export interface AvailabilityView {
  weekly: WeeklyRange[];
  extras: ExtraAvailability[];
  /** À venir et en cours. */
  unavailabilities: UnavailabilityView[];
  maxHoursPerDay: number;
  maxHoursPerWeek: number;
}

export async function availabilityView(deps: CleaningDeps, agent: AgentRecord): Promise<AvailabilityView> {
  const now = deps.clock.now();
  const current = agent.unavailabilities
    .filter((u) => u.end > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const names = await deps.people.userNames([...new Set(current.map((u) => u.createdBy))]);
  return {
    weekly: [...agent.weekly].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute),
    extras: [...agent.extras].sort((a, b) => a.start.getTime() - b.start.getTime()),
    unavailabilities: current.map((u) => ({ ...u, createdByName: names.get(u.createdBy) ?? null })),
    maxHoursPerDay: agent.maxHoursDay,
    maxHoursPerWeek: agent.maxHoursWeek,
  };
}

/** Modèle hebdomadaire reçu → plages du domaine ; deux plages d'un même jour ne se chevauchent pas. */
export function parseWeekly(
  rules: readonly { weekday: string; ranges: { start: string; end: string }[] }[],
): WeeklyRange[] {
  const ranges = rules.flatMap((rule, i) => {
    const weekday = WEEKDAYS.indexOf(rule.weekday as (typeof WEEKDAYS)[number]) + 1;
    if (!weekday) throw cleaningErrors.invalid(`weekly[${i}].weekday`, 'invalid_type');
    return rule.ranges.map((range, j) => {
      const startMinute = minuteOfDay(range.start, `weekly[${i}].ranges[${j}].start`);
      const endMinute = minuteOfDay(range.end, `weekly[${i}].ranges[${j}].end`);
      if (endMinute <= startMinute)
        throw cleaningErrors.invalid(`weekly[${i}].ranges[${j}].end`, 'out_of_range');
      return { weekday, startMinute, endMinute };
    });
  });
  const sorted = [...ranges].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  sorted.forEach((range, i) => {
    const previous = sorted[i - 1];
    if (previous && previous.weekday === range.weekday && previous.endMinute > range.startMinute) {
      throw cleaningErrors.invalid('weekly', 'duplicate', 'Deux plages d’un même jour se chevauchent.');
    }
  });
  return sorted;
}

/** Plages du domaine → modèle du contrat, un jour par entrée. */
export function weeklyRules(
  weekly: readonly WeeklyRange[],
): { weekday: string; ranges: { start: string; end: string }[] }[] {
  return WEEKDAYS.map((weekday, index) => ({
    weekday,
    ranges: weekly
      .filter((range) => range.weekday === index + 1)
      .map((range) => ({ start: formatMinute(range.startMinute), end: formatMinute(range.endMinute) })),
  })).filter((rule) => rule.ranges.length);
}

/** Disponibilités exceptionnelles reçues (TimeSlot ISO 8601). */
export function parseExtras(
  slots: readonly { start: string; end: string }[],
  ids: () => string,
): ExtraAvailability[] {
  return slots.map((slot, i) => {
    const start = instant(slot.start, `extraAvailabilities[${i}].start`);
    const end = instant(slot.end, `extraAvailabilities[${i}].end`);
    if (end <= start) throw cleaningErrors.invalid(`extraAvailabilities[${i}].end`, 'out_of_range');
    return { id: ids(), start, end };
  });
}
