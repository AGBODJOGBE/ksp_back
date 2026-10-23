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
}

export type CleaningEventType = keyof CleaningEventPayloads;
