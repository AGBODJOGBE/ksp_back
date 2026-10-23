/**
 * Événements publiés par cleaning (cahier des charges Nettoyage, partie 6).
 * Source de vérité : contracts/events/cleaning/*.schema.json. Le test de contrat vérifie
 * que ces types et les schémas restent alignés. Identifiants seulement : jamais d'adresse
 * d'intervention ni de commentaire.
 */
export interface CleaningMoney {
  amount: number;
  currency: 'XOF';
}

export interface CleaningRecurrence {
  period: 'week' | 'month';
  visitsPerPeriod: number;
  durationMonths: number;
}

export interface CleaningEventPayloads {
  'cleaning.quote.requested': {
    requestId: string;
    customerId: string;
    organizationId: string | null;
    customerKind: 'individual' | 'business';
    serviceCode: string;
    visitRequired: boolean;
  };
  'cleaning.visit.scheduled': {
    requestId: string;
    visitId: string;
    customerId: string;
    agentId: string;
    scheduledAt: string;
  };
  'cleaning.quote.sent': {
    requestId: string;
    quoteId: string;
    customerId: string;
    total: CleaningMoney;
    validUntil: string;
  };
  'cleaning.booking.confirmed': {
    requestId: string;
    quoteId: string;
    missionId: string;
    customerId: string;
    organizationId: string | null;
    total: CleaningMoney;
    plannedInterventions: number;
    recurrence: CleaningRecurrence | null;
    paymentPlan: {
      option: 'deposit' | 'full';
      timing: 'before' | 'after';
      method: 'cash' | 'mobile_money_offline' | 'mobile_money_online';
    };
    depositAmount: CleaningMoney;
    /** Début du créneau choisi : départ des mois de facturation d'un contrat d'entreprise. */
    startsAt?: string;
  };
  'cleaning.mission.scheduled': {
    missionId: string;
    interventionId: string;
    customerId: string;
    scheduledStart: string;
    durationMinutes: number;
    agentIds: string[];
  };
  'cleaning.mission.completed': {
    missionId: string;
    customerId: string;
    completedInterventions: number;
    completedAt: string;
  };
  'cleaning.request.cancelled': {
    requestId: string;
    missionId: string | null;
    customerId: string;
    cancelledBy: 'customer' | 'supervisor';
    outcome: 'cancelled' | 'rejected' | 'declined';
  };
  'cleaning.contract.suspension_warning': {
    missionId: string;
    customerId: string;
    organizationId: string | null;
    unpaidCount: number;
    suspensionThreshold: number;
  };
  'cleaning.contract.suspended': {
    missionId: string;
    customerId: string;
    organizationId: string | null;
    cause: CleaningSuspensionCause;
    unpaidCount: number;
    threshold: number;
    cancelledInterventionIds: string[];
    releasedAgentIds: string[];
    suspendedAt: string;
  };
  'cleaning.contract.resumed': {
    missionId: string;
    customerId: string;
    organizationId: string | null;
    cause: CleaningSuspensionCause;
    unpaidCount: number;
    resumedAt: string;
    rescheduledCount: number;
    failedCount: number;
  };
  'cleaning.rescheduling.failed': {
    missionId: string;
    customerId: string;
    organizationId: string | null;
    interventionIds: string[];
    failedCount: number;
  };
}

/** Factures d'entreprise impayées, ou passages impayés d'un particulier en récurrent. */
export type CleaningSuspensionCause = 'unpaid_invoices' | 'unpaid_interventions';

export type CleaningEventType = keyof CleaningEventPayloads;
