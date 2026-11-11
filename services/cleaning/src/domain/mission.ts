import { type ChecklistTemplateItem } from './catalog';
import { type GeoLocation } from './location';
import { paidAmount, type PaymentState } from './payment';
import { type Recurrence } from './recurrence';
import { type Slot } from './schedule';

/**
 * Mission (UC-CL-09, 10) : créée par l'acceptation d'un devis, réalisée en un ou plusieurs
 * passages. Chaque passage a sa date, sa durée, ses agents et sa liste de contrôle ; pour un
 * contrat récurrent, le superviseur peut affecter d'autres agents à chaque passage.
 *
 * Passage : planifié → en cours → terminé ; un incident le met en attente ; annulable tant
 * qu'il n'est pas commencé ou s'il est en attente. L'état de la mission se déduit de ses passages.
 */
export type InterventionStatus = 'planned' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';
export type MissionStatus =
  'to_schedule' | 'scheduled' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';

const INTERVENTION_TRANSITIONS: Record<InterventionStatus, readonly InterventionStatus[]> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['on_hold', 'completed'],
  on_hold: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransitionIntervention(from: InterventionStatus, to: InterventionStatus): boolean {
  return INTERVENTION_TRANSITIONS[from].includes(to);
}

export interface ChecklistItem extends ChecklistTemplateItem {
  done: boolean;
}

export interface Intervention {
  id: string;
  status: InterventionStatus;
  scheduledStart: Date;
  durationMinutes: number;
  agentIds: string[];
  checklist: ChecklistItem[];
  incidentNote: string | null;
  /** Références du service file : aucun stockage de photo dans cleaning. */
  beforePhotoFileIds: string[];
  afterPhotoFileIds: string[];
  startedAt: Date | null;
  completedAt: Date | null;
  /** Passage annulé par une suspension (reprogrammable au déblocage) ou à la main. */
  cancellationCause: InterventionCancellationCause | null;
  cancelledAt: Date | null;
  /** Motif du dernier report, ou de l'annulation pour replanifier (ADR-053) ; absent ou null sinon. */
  changeReason?: string | null;
}

/**
 * Suspension (reprogrammable au déblocage), annulation à la main, ou annulation pour replanifier
 * (`unscheduled`, ADR-053 : la mission a de nouveau un passage à planifier).
 */
export type InterventionCancellationCause = 'suspension' | 'manual' | 'unscheduled';

/**
 * Factures d'entreprise impayées, passages impayés d'un particulier en récurrent, ou organisation
 * suspendue par KSP (ADR-030).
 */
export type SuspensionCause = 'unpaid_invoices' | 'unpaid_interventions' | 'organization_suspended';

/**
 * Suspension en cours (CDC Nettoyage, partie 10 ; ADR-030). Les causes se cumulent : la mission
 * ne reprend que lorsque la dernière est levée.
 */
export interface Suspension {
  /** Causes actives, la plus ancienne d'abord ; jamais vide. */
  causes: SuspensionCause[];
  since: Date;
  /** Impayés connus à la dernière décision (0 possible pour une organisation suspendue). */
  unpaidCount: number;
}

export interface Mission {
  id: string;
  requestId: string;
  quoteId: string;
  customerId: string;
  organizationId: string | null;
  status: MissionStatus;
  serviceCode: string;
  commune: string;
  address: string;
  /** Position GPS et point de repère copiés de la demande (ADR-034), pour aller sur place ; null sinon. */
  location: GeoLocation | null;
  landmark: string | null;
  /** Groupe et type de lieu de la demande d'origine (ADR-034), null sinon. */
  groupId: string | null;
  placeType: string | null;
  chosenSlot: Slot;
  recurrence: Recurrence | null;
  plannedInterventions: number;
  interventions: Intervention[];
  payment: PaymentState;
  cancellationReason: string | null;
  /** Entreprise : jours d'intervention par semaine indiqués à la demande, null si non précisés. */
  daysPerWeek: number | null;
  suspension: Suspension | null;
  /** Nombre d'impayés au dernier avertissement envoyé (0 : aucun) : un avertissement n'est pas répété. */
  warningLevel: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = ['completed', 'cancelled'];
/** Statuts d'un passage qui occupent l'agenda de ses agents. */
export const ACTIVE_INTERVENTION_STATUSES: readonly InterventionStatus[] = [
  'planned',
  'in_progress',
  'on_hold',
];

export function isTerminalMission(status: MissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.includes(status);
}

export function completedCount(mission: Pick<Mission, 'interventions'>): number {
  return mission.interventions.filter((intervention) => intervention.status === 'completed').length;
}

/** Passages encore à planifier : prévus moins ceux déjà planifiés, en cours ou terminés. */
export function remainingToSchedule(
  mission: Pick<Mission, 'interventions' | 'plannedInterventions'>,
): number {
  const used = mission.interventions.filter((intervention) => intervention.status !== 'cancelled').length;
  return Math.max(0, mission.plannedInterventions - used);
}

/** État de la mission déduit de ses passages (une mission annulée le reste). */
export function deriveMissionStatus(
  mission: Pick<Mission, 'status' | 'interventions' | 'plannedInterventions'>,
): MissionStatus {
  if (mission.status === 'cancelled') return 'cancelled';
  const statuses = mission.interventions.map((intervention) => intervention.status);
  if (completedCount(mission) >= mission.plannedInterventions) return 'completed';
  if (statuses.includes('on_hold')) return 'on_hold';
  if (statuses.includes('in_progress')) return 'in_progress';
  if (statuses.includes('planned')) return 'scheduled';
  return 'to_schedule';
}

/**
 * Premier passage planifié : base du délai d'annulation. Null sans passage planifié : rien n'est
 * engagé, l'annulation est sans frais même si le créneau choisi au devis est passé (ADR-049).
 */
export function nextStart(mission: Pick<Mission, 'interventions'>): Date | null {
  const planned = mission.interventions
    .filter((intervention) => intervention.status === 'planned')
    .map((intervention) => intervention.scheduledStart.getTime());
  return planned.length ? new Date(Math.min(...planned)) : null;
}

/**
 * Arrêt de la suite d'une mission récurrente d'un particulier, après au moins un passage fait
 * (décision du responsable, ADR-049) : les passages faits restent dus, les suivants sont annulés.
 */
export function isRecurringStop(
  mission: Pick<Mission, 'organizationId' | 'recurrence' | 'interventions'>,
): boolean {
  return mission.organizationId === null && mission.recurrence !== null && completedCount(mission) > 0;
}

/**
 * Règlement de cet arrêt : montant dû pour les passages faits (prix d'un passage = total / passages
 * prévus, arrondi à l'entier XOF), et montant déjà payé au-delà, à créditer au portefeuille du client.
 */
export function stopSettlement(
  mission: Pick<Mission, 'interventions' | 'plannedInterventions' | 'payment'>,
): { dueTotal: number; credit: number } {
  const dueTotal = Math.round(
    (mission.payment.total * completedCount(mission)) / Math.max(1, mission.plannedInterventions),
  );
  return { dueTotal, credit: Math.max(0, paidAmount(mission.payment) - dueTotal) };
}

/** Le client ne peut annuler qu'une mission pas encore commencée. */
export function isCancellableByCustomer(mission: Pick<Mission, 'status'>): boolean {
  return mission.status === 'to_schedule' || mission.status === 'scheduled';
}

export function isChecklistComplete(intervention: Pick<Intervention, 'checklist'>): boolean {
  return intervention.checklist.every((item) => item.done);
}

/** Pour un agent : seulement les missions où il est affecté à au moins un passage. */
export function isAssignedAgent(mission: Pick<Mission, 'interventions'>, agentId: string): boolean {
  return mission.interventions.some((intervention) => intervention.agentIds.includes(agentId));
}
