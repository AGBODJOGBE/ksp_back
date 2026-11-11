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

/** Demande d'un groupe et sa prestation (ADR-035 point 14). */
export interface CleaningGroupRequestRef {
  requestId: string;
  serviceCode: string;
  /** Nom de la prestation au moment de l'événement ; absent si la prestation n'existe plus. */
  serviceName?: string;
}

export interface CleaningEventPayloads {
  'cleaning.quote.requested': {
    requestId: string;
    customerId: string;
    organizationId: string | null;
    customerKind: 'individual' | 'business';
    serviceCode: string;
    visitRequired: boolean;
    /** Facultatif (ADR-034) : groupe des demandes créées ensemble pour un même lieu. */
    groupId?: string;
    /** Facultatif (ADR-035 point 14) : nom de la prestation. */
    serviceName?: string;
    /**
     * Facultatif (ADR-035 point 14) : true quand cleaning.quote_group.requested résume l'envoi
     * groupé dans la même transaction ; absent sinon.
     */
    summarizedByGroup?: boolean;
  };
  'cleaning.visit.scheduled': {
    requestId: string;
    visitId: string;
    customerId: string;
    agentId: string;
    scheduledAt: string;
    /** Facultatifs (ADR-034) : prestation, son nom et groupe de la demande. */
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
    /**
     * Facultatifs (ADR-035) : visite commune à plusieurs demandes du groupe, un seul événement pour
     * toutes (requestId est la première de requestIds).
     */
    groupVisitId?: string;
    requestIds?: string[];
    /** Facultatif (ADR-035 point 14) : demandes de la visite commune avec leur prestation. */
    requests?: CleaningGroupRequestRef[];
  };
  'cleaning.quote.sent': {
    requestId: string;
    quoteId: string;
    customerId: string;
    total: CleaningMoney;
    validUntil: string;
    /** Facultatifs (ADR-034) : prestation, son nom et groupe de la demande. */
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
    /**
     * Facultatif (ADR-035 point 14) : true quand cleaning.quote_group.sent résume l'envoi groupé
     * des devis dans la même transaction ; absent sinon.
     */
    summarizedByGroup?: boolean;
  };
  /** Envoi groupé reçu (ADR-035 point 14) : un événement pour toutes les demandes créées ensemble. */
  'cleaning.quote_group.requested': {
    groupId: string;
    customerId: string;
    organizationId: string | null;
    customerKind: 'individual' | 'business';
    visitRequired: boolean;
    requests: CleaningGroupRequestRef[];
  };
  /** Devis d'un groupe envoyés ensemble (ADR-035 point 14) : total et validité communs. */
  'cleaning.quote_group.sent': {
    groupId: string;
    customerId: string;
    total: CleaningMoney;
    validUntil: string;
    quotes: (CleaningGroupRequestRef & { quoteId: string; total: CleaningMoney })[];
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
    /** Facultatifs (ADR-034) : prestation, son nom et groupe de la demande. */
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
  };
  'cleaning.mission.scheduled': {
    missionId: string;
    interventionId: string;
    customerId: string;
    scheduledStart: string;
    durationMinutes: number;
    agentIds: string[];
    /**
     * Facultatif (ADR-049) : paiement « avant » encore dû (acompte, ou totalité) ; le passage ne
     * démarre pas sans lui. Absent sinon.
     */
    amountDueBeforeStart?: CleaningMoney;
    /** Facultatifs (ADR-034) : prestation, son nom et groupe de la demande. */
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
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
    /**
     * Organisation cliente, null pour un particulier (ADR-032). Toujours renseigné par cleaning ;
     * absent des événements publiés avant son ajout.
     */
    organizationId?: string | null;
    cancelledBy: 'customer' | 'supervisor';
    outcome: 'cancelled' | 'rejected' | 'declined';
    /** Facultatifs (ADR-034) : prestation, son nom et groupe de la demande. */
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
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
  'cleaning.contract.suspension_updated': {
    missionId: string;
    customerId: string;
    organizationId: string | null;
    change: CleaningSuspensionChange;
    cause: CleaningSuspensionCause;
    causes: CleaningSuspensionCause[];
    unpaidCount: number;
    updatedAt: string;
  };
  'cleaning.rescheduling.failed': {
    missionId: string;
    customerId: string;
    organizationId: string | null;
    interventionIds: string[];
    failedCount: number;
  };
  /**
   * Paiements par portefeuille d'une mission annulée, remboursés dans le portefeuille du client
   * (ADR-046) : wallet rembourse chaque débit cité, une seule fois.
   */
  'cleaning.mission.refunded': {
    missionId: string;
    customerId: string;
    refunds: { paymentRecordId: string; walletTransactionId: string; amount: CleaningMoney }[];
    reason: 'mission_cancelled';
    refundedAt: string;
  };
  /**
   * Montant payé pour des passages non faits d'une mission récurrente arrêtée par le client, crédité
   * au prorata dans son portefeuille prépayé (ADR-049) : wallet crédite une seule fois par creditId.
   */
  'cleaning.mission.credited': {
    missionId: string;
    customerId: string;
    creditId: string;
    amount: CleaningMoney;
    reason: 'recurring_cancelled';
    creditedAt: string;
  };
  /**
   * Devis expirés sans réponse (ADR-053), enregistrés par la tâche planifiée : un événement par client
   * et par groupe (ou demande seule) traités ensemble.
   */
  'cleaning.quote.expired': {
    customerId: string;
    organizationId: string | null;
    groupId?: string;
    quotes: CleaningQuoteRef[];
    expiredAt: string;
  };
  /** Rappel avant l'expiration des devis (ADR-053), une seule fois par devis. */
  'cleaning.quote.expiry_reminded': {
    customerId: string;
    organizationId: string | null;
    groupId?: string;
    quotes: CleaningQuoteRef[];
    /** Fin de validité la plus proche des devis cités. */
    validUntil: string;
    reminderDays: number;
  };
  /** Passage planifié reporté par la supervision (ADR-053) ; le motif reste dans cleaning. */
  'cleaning.intervention.rescheduled': {
    missionId: string;
    interventionId: string;
    customerId: string;
    previousStart: string;
    scheduledStart: string;
    durationMinutes: number;
    agentIds: string[];
    /** Agents qui n'interviennent plus sur ce passage. */
    releasedAgentIds: string[];
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
  };
  /** Passage annulé pour être replanifié (ADR-053) : aucun effet sur l'argent. */
  'cleaning.intervention.unscheduled': {
    missionId: string;
    interventionId: string;
    customerId: string;
    previousStart: string;
    releasedAgentIds: string[];
    serviceCode?: string;
    serviceName?: string;
    groupId?: string;
  };
  /** Visite planifiée annulée avec sa demande (ou toutes celles de la visite commune), ADR-053. */
  'cleaning.visit.cancelled': {
    /** Visite seule, ou identifiant de la visite commune. */
    visitId: string;
    requestIds: string[];
    customerId: string;
    agentId: string;
    scheduledAt: string;
    outcome: 'rejected' | 'cancelled' | 'declined' | 'expired';
    cancelledAt: string;
    groupId?: string;
    requests?: CleaningGroupRequestRef[];
  };
}

/** Devis cité par l'expiration ou son rappel (ADR-053). */
export interface CleaningQuoteRef extends CleaningGroupRequestRef {
  quoteId: string;
  total: CleaningMoney;
  validUntil: string;
}

/**
 * Factures d'entreprise impayées, passages impayés d'un particulier en récurrent, ou organisation
 * suspendue par KSP (ADR-030).
 */
export type CleaningSuspensionCause = 'unpaid_invoices' | 'unpaid_interventions' | 'organization_suspended';

/** Cause ajoutée à une suspension en cours, ou levée alors qu'une autre reste active (ADR-030). */
export type CleaningSuspensionChange = 'cause_added' | 'cause_lifted';

export type CleaningEventType = keyof CleaningEventPayloads;
