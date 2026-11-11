import { type Assignment, visitSlot } from '../../domain/agenda';
import { ACTIVE_INTERVENTION_STATUSES } from '../../domain/mission';
import { OPEN_REQUEST_STATUSES } from '../../domain/quote-request';
import { type BusyPeriod } from '../../domain/schedule';
import { DEFAULT_SETTINGS } from '../../domain/settings';
import { type Tx } from './changes';

/**
 * Agenda des agents (ADR-053), lu dans la transaction de l'appelant : visites techniques planifiées
 * des demandes encore ouvertes (une visite d'une demande close ne compte plus, même avant sa
 * clôture par la tâche des échéances) et passages actifs.
 */
export async function visitDurationMinutes(tx: Tx): Promise<number> {
  const row = await tx.cleaningSettings.findUnique({
    where: { id: 1 },
    select: { visitDurationMinutes: true },
  });
  return row?.visitDurationMinutes ?? DEFAULT_SETTINGS.visitDurationMinutes;
}

export async function scheduledVisits(
  tx: Tx,
  agentIds: readonly string[],
  excludedVisitIds: readonly string[] = [],
) {
  return tx.siteVisit.findMany({
    where: {
      status: 'scheduled',
      agentId: { in: [...agentIds] },
      ...(excludedVisitIds.length ? { id: { notIn: [...excludedVisitIds] } } : {}),
      request: { status: { in: [...OPEN_REQUEST_STATUSES] } },
    },
    select: {
      id: true,
      agentId: true,
      requestId: true,
      scheduledAt: true,
      request: { select: { groupId: true } },
    },
  });
}

/** Visites planifiées vues comme des périodes occupées. */
export async function visitBusyPeriods(
  tx: Tx,
  agentIds: readonly string[],
  durationMinutes: number,
  excludedVisitIds: readonly string[] = [],
): Promise<BusyPeriod[]> {
  const visits = await scheduledVisits(tx, agentIds, excludedVisitIds);
  return visits.map((visit) => ({
    agentId: visit.agentId,
    slot: visitSlot(visit.scheduledAt, durationMinutes),
    groupId: visit.request.groupId,
  }));
}

/** Passages actifs et visites planifiées d'un agent, sur la période (fin exclue, `to` facultatif). */
export async function agentAssignments(
  tx: Tx,
  agentId: string,
  period: { from: Date; to: Date | null },
  durationMinutes: number,
): Promise<Assignment[]> {
  const [interventions, visits] = await Promise.all([
    tx.intervention.findMany({
      where: {
        status: { in: [...ACTIVE_INTERVENTION_STATUSES] },
        agentIds: { has: agentId },
        scheduledEnd: { gt: period.from },
        ...(period.to ? { scheduledStart: { lt: period.to } } : {}),
      },
      select: { id: true, missionId: true, scheduledStart: true, scheduledEnd: true },
      orderBy: { scheduledStart: 'asc' },
    }),
    scheduledVisits(tx, [agentId]),
  ]);
  const passages = interventions.map((row): Assignment => ({
    kind: 'intervention',
    id: row.id,
    missionId: row.missionId,
    requestId: null,
    slot: { start: row.scheduledStart, end: row.scheduledEnd },
  }));
  const planned = visits
    .map((row): Assignment => ({
      kind: 'visit',
      id: row.id,
      missionId: null,
      requestId: row.requestId,
      slot: visitSlot(row.scheduledAt, durationMinutes),
    }))
    .filter((visit) => visit.slot.end > period.from && (!period.to || visit.slot.start < period.to));
  return [...passages, ...planned];
}
