/**
 * Événements publiés par cleaning, refonte v2 (cahier des charges Nettoyage v2, partie 15.5).
 * Source de vérité : contracts/events/cleaning/*.schema.json. Le test de contrat vérifie que ces
 * types et les schémas restent alignés. Identifiants et montants seulement : jamais d'adresse, de
 * repère, de position GPS ni de texte libre.
 */
export interface CleaningMoney {
  /** Entier en XOF. */
  amount: number;
  currency: 'XOF';
}

export interface CleaningEventPayloads {
  /** Demande de devis envoyée (UC-NT-04). Frais de visite débités, ou en attente de paiement (R-FV-02). Écouté par notification (client, superviseur). */
  'cleaning.request.submitted': {
    requestId: string;
    /** DN-000124 */
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    placeTypeId: string;
    /** Types choisis ; vide pour un lieu « Autre » */
    cleaningTypeIds: string[];
    visitFee: CleaningMoney;
    visitFeeStatus: 'paid' | 'awaiting_payment';
    submittedAt: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Nom du lieu en vigueur */
    placeTypeName: string;
    /** Noms des types en vigueur, dans l’ordre de la demande */
    cleaningTypeNames: string[];
  };
  /** Demande annulée par le client (UC-NT-10) ou par le système, frais de visite non payés sous 72 h (R-FV-03, UC-NT-44). */
  'cleaning.request.cancelled': {
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    cause: 'customer' | 'visit_fee_unpaid';
    /** Frais remboursés au wallet (R-FV-06) ; null : rien à rembourser */
    visitFeeRefund: CleaningMoney | null;
    cancelledAt: string;
  };
  /** Demande refusée par KSP avant l’acceptation (R-AC-05, UC-NT-30). */
  'cleaning.request.rejected': {
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Motif dans la liste (le texte libre ne quitte pas cleaning) */
    reasonCode: 'place_inaccessible' | 'service_impossible' | 'other';
    rejectedBy: string;
    /** Remboursés s’il n’y a pas eu de visite */
    visitFeeRefund: CleaningMoney | null;
    rejectedAt: string;
  };
  /** Frais de visite payés après l’envoi (R-FV-02). */
  'cleaning.request.visit_fee_paid': {
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    visitFeeId: string;
    /** 1 à l’envoi, puis 2, 3… après chaque absence du client */
    rank: number;
    amount: CleaningMoney;
    /** Reçu (billing), si déjà émis */
    invoiceId: string | null;
    paidAt: string;
  };
  /** Réactivation d’un devis expiré demandée (R-AC-04). Écouté par notification (superviseur). */
  'cleaning.request.reactivation_requested': {
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    requestedAt: string;
  };
  /** Visite planifiée ou déplacée (UC-NT-31, R-VI-03). Écouté par notification (client, agent). */
  'cleaning.visit.scheduled': {
    visitId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Agents de la visite */
    agentIds: string[];
    scheduledAt: string;
    durationMinutes: number;
    /** Date précédente pour un déplacement ; null pour une première planification */
    previousScheduledAt: string | null;
    /** Agents retirés par ce changement ; vide sinon */
    releasedAgentIds: string[];
    /** Nom du lieu en vigueur */
    placeTypeName: string;
    /** Noms des types en vigueur, dans l’ordre de la demande */
    cleaningTypeNames: string[];
  };
  /** Agent arrivé sur le lieu de la visite (R-VI-04). */
  'cleaning.visit.arrived': {
    visitId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Distance à la position du lieu ; null : arrivée sans position */
    distanceMeters: number | null;
    /** Au-delà de arrivalAlertMeters : superviseur alerté */
    alert: boolean;
    arrivedAt: string;
  };
  /** Visite clôturée, constat saisi (UC-NT-22), par l’agent ou par le back-office pour lui (R-VI-08). */
  'cleaning.visit.completed': {
    visitId: string;
    requestId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    agentIds: string[];
    completedAt: string;
    requestNumber: string;
    /** Agent, ou back-office pour son compte (R-VI-08) */
    completedBy: 'agent' | 'ksp';
  };
  /** Visite manquée, client absent (R-VI-05) : de nouveaux frais sont créés et la demande attend leur paiement. Une absence de l’agent est une annulation (cleaning.visit.cancelled, R-FV-06). */
  'cleaning.visit.missed': {
    visitId: string;
    requestId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    missedAt: string;
    requestNumber: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Agent, ou back-office pour son compte (R-VI-08) */
    reportedBy: 'agent' | 'ksp';
    /** Nouveaux frais de visite (R-VI-05) */
    newVisitFee: CleaningMoney;
    /** Limite de paiement des nouveaux frais (R-FV-03) */
    newVisitFeePayBefore: string;
  };
  /** Visite annulée (R-VI-06). Publié si la visite n’était pas encore passée. Écouté par notification (client, agents). */
  'cleaning.visit.cancelled': {
    visitId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Agents libérés */
    releasedAgentIds: string[];
    scheduledAt: string;
    cause: 'request_cancelled' | 'request_rejected' | 'slot_changed' | 'ksp' | 'agent_no_show';
    /** null : rien de remboursé */
    visitFeeRefund: CleaningMoney | null;
    cancelledAt: string;
  };
  /** Devis envoyé ou révisé (UC-NT-33, R-DV-05, R-DV-06). Écouté par notification. */
  'cleaning.quote.sent': {
    quoteId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    kind: 'initial' | 'amendment' | 'renewal' | 'reorder';
    /** Révision */
    version: number;
    sessionPrice: CleaningMoney;
    sessionsCount: number;
    total: CleaningMoney;
    visitFeeDeduction: CleaningMoney;
    validUntil: string;
    sentAt: string;
    /** Nom du lieu en vigueur */
    placeTypeName: string;
    /** Noms des types en vigueur, dans l’ordre de la demande */
    cleaningTypeNames: string[];
  };
  /** Devis accepté : programme créé (UC-NT-08, R-AC-01). */
  'cleaning.quote.accepted': {
    quoteId: string;
    requestId: string;
    /** Programme créé, ou complété par un avenant */
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    acceptedBy: string;
    total: CleaningMoney;
    acceptedAt: string;
    requestNumber: string;
  };
  /** Devis refusé par le client (UC-NT-09, R-AC-03) : dossier clos, superviseur prévenu. */
  'cleaning.quote.declined': {
    quoteId: string;
    requestId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    declinedBy: string;
    /** Motif dans la liste ; null sans motif */
    reasonCode: 'price' | 'schedule' | 'no_longer_needed' | 'other' | null;
    declinedAt: string;
    requestNumber: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
  };
  /** Devis sans réponse à sa date de validité (R-AC-04, UC-NT-44). */
  'cleaning.quote.expired': {
    quoteId: string;
    requestId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    validUntil: string;
    expiredAt: string;
    requestNumber: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    total: CleaningMoney;
    /** Nom du lieu en vigueur */
    placeTypeName: string;
    /** Noms des types en vigueur, dans l’ordre de la demande */
    cleaningTypeNames: string[];
  };
  /** Devis envoyé retiré : nouvelle visite demandée par KSP (R-VI-07). Écouté par notification (client). */
  'cleaning.quote.withdrawn': {
    quoteId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    version: number;
    withdrawnAt: string;
  };
  /** Rappel avant l’expiration d’un devis envoyé (R-DV-04, UC-NT-44). Écouté par notification (client). */
  'cleaning.quote.expiry_reminded': {
    quoteId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    total: CleaningMoney;
    validUntil: string;
    reminderDays: number;
    remindedAt: string;
  };
  /** Devis transmis pour accord par un membre de l’organisation (R-AC-02). Écouté par notification (administrateurs de l’organisation). */
  'cleaning.quote.forwarded': {
    quoteId: string;
    requestId: string;
    requestNumber: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    forwardedBy: string;
    forwardedAt: string;
  };
  /** Programme confirmé : séances créées avec leur prix (R-AC-01, R-PG-05). */
  'cleaning.program.confirmed': {
    programId: string;
    programNumber: string;
    quoteId: string;
    requestId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    payerKind: 'individual' | 'organization';
    sessionsCount: number;
    sessionPrice: CleaningMoney;
    total: CleaningMoney;
    /** Frais de visite à déduire du premier paiement (R-FV-05) */
    visitFeeDeduction: CleaningMoney;
    firstSessionAt: string;
    lastSessionAt: string;
    confirmedAt: string;
    /** Nom du lieu en vigueur */
    placeTypeName: string;
    /** Noms des types en vigueur, dans l’ordre de la demande */
    cleaningTypeNames: string[];
  };
  /** Programme suspendu (partie 11.3) : séances à venir gelées, agents libérés. Publié au passage à « suspendu » seulement. */
  'cleaning.program.suspended': {
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Causes actives (R-SU-01) */
    causes: ('overdue_sessions' | 'unpaid_invoices' | 'ksp_decision' | 'organization_suspended')[];
    suspendedSessionIds: string[];
    releasedAgentIds: string[];
    suspendedAt: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Factures impayées de l’organisation */
    unpaidCount: number | null;
    /** Séances en retard de paiement */
    overdueCount: number | null;
    /** Seuil franchi */
    threshold: number | null;
  };
  /** Cause ajoutée ou levée sur un programme qui reste suspendu (R-SU-01). Écouté par notification. */
  'cleaning.program.suspension_updated': {
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    change: 'cause_added' | 'cause_lifted';
    /** Cause ajoutée ou levée */
    cause: 'overdue_sessions' | 'unpaid_invoices' | 'ksp_decision' | 'organization_suspended';
    /** Causes actives après le changement */
    causes: ('overdue_sessions' | 'unpaid_invoices' | 'ksp_decision' | 'organization_suspended')[];
    unpaidCount: number | null;
    overdueCount: number | null;
    updatedAt: string;
  };
  /** Programme repris : toutes les causes sont levées (R-SU-01, R-SU-03). */
  'cleaning.program.resumed': {
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Séances à venir repassées « à affecter » */
    sessionsToAssign: number;
    /** Séances dont la date est passée pendant la suspension, proposées au rattrapage */
    catchUpSessionIds: string[];
    resumedAt: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Dernière cause levée */
    liftedCause: 'overdue_sessions' | 'unpaid_invoices' | 'ksp_decision' | 'organization_suspended';
  };
  /** Programme terminé : toutes les séances sont réalisées, manquées ou annulées. Écouté par notification (client). */
  'cleaning.program.completed': {
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    sessionsCompleted: number;
    sessionsMissed: number;
    sessionsCancelled: number;
    completedAt: string;
    programNumber: string;
    /** Ponctuel : « commander à nouveau » (R-PG-08) */
    planKind: 'one_off' | 'weekly' | 'monthly';
  };
  /** Programme arrêté par le client (UC-NT-13) ou par KSP (UC-NT-39). */
  'cleaning.program.cancelled': {
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    cancelledBy: 'customer' | 'ksp';
    cancelledByUserId: string;
    cancelledSessionIds: string[];
    cancelledAt: string;
    /** Agents libérés */
    releasedAgentIds: string[];
  };
  /** Agents affectés à une séance (UC-NT-37, UC-NT-38). Écouté par notification (client, agents). */
  'cleaning.session.assigned': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    rank: number;
    scheduledStart: string;
    /** Équipe complète après l’affectation */
    agentIds: string[];
    leadAgentId: string | null;
    source: 'manual' | 'auto';
    assignedAt: string;
    programNumber: string;
    sessionsCount: number;
    /** Lot (cleaning.sessions.batch_assigned) : aucun message unitaire */
    batchId: string | null;
    /** Moins d’agents que prévu */
    teamIncomplete: boolean;
  };
  /** Agents retirés d’une séance (désaffectation, indisponibilité, désactivation, refus ou absence de réponse d’un indépendant, report). Pas d’événement unitaire quand la libération vient d’une annulation de séance (cleaning.session.cancelled), d’un arrêt de programme (cleaning.program.cancelled) ou d’une suspension (cleaning.program.suspended) : ces événements portent releasedAgentIds. */
  'cleaning.session.unassigned': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Agents retirés */
    agentIds: string[];
    cause:
      'manual' | 'unavailability' | 'agent_deactivated' | 'agent_declined' | 'no_response' | 'rescheduled';
    unassignedAt: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    /** Début au moment du retrait */
    scheduledStart: string;
    batchId: string | null;
  };
  /** Plusieurs séances d’un programme affectées par un même appel (CreateAssignments, ApproveProposals, RunAutoPlanning, passage de nuit compris). Écouté par notification : un message par destinataire et par lot ; les événements unitaires qui portent ce batchId n’envoient rien. */
  'cleaning.sessions.batch_assigned': {
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    batchId: string;
    sessionIds: string[];
    count: number;
    firstStart: string;
    lastStart: string;
    agentIds: string[];
    leadAgentId: string | null;
    source: 'manual' | 'auto';
    assignedAt: string;
  };
  /** Alerte de couverture d’une séance (R-PL-06, R-PL-10). Écouté par notification (superviseur de la zone, puis admin). */
  'cleaning.session.staffing_alert': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    scheduledStart: string;
    level: 'unassigned_48h' | 'unassigned_at_start' | 'agent_absent';
    missingAgents: number;
    alertedAt: string;
  };
  /** Séance reportée (un report n’est pas un statut, partie 8). */
  'cleaning.session.rescheduled': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    rank: number;
    previousStart: string;
    scheduledStart: string;
    scheduledEnd: string;
    rescheduledBy: 'customer' | 'ksp';
    rescheduledAt: string;
    programNumber: string;
    sessionsCount: number;
    /** Agents gardés */
    agentIds: string[];
    /** Agents retirés (aussi dans cleaning.session.unassigned, cause rescheduled) */
    releasedAgentIds: string[];
    durationMinutes: number;
  };
  /** Séance annulée par le client plus de 24 h avant, par KSP, ou faute d’agent (R-PL-10). Non publié pour un arrêt de programme (cleaning.program.cancelled) ni pour une annulation tardive (cleaning.session.missed). */
  'cleaning.session.cancelled': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    scheduledStart: string;
    cancelledBy: 'customer' | 'ksp';
    cause: 'customer' | 'ksp' | 'no_agent';
    releasedAgentIds: string[];
    cancelledAt: string;
  };
  /** Rappel la veille d’une séance (partie 10, R-PP-05). Écouté par notification (client, agents). */
  'cleaning.session.reminder': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    scheduledStart: string;
    agentIds: string[];
    /** null pour une entreprise */
    amountDue: CleaningMoney | null;
    /** null pour une entreprise */
    balanceSufficient: boolean | null;
    remindedAt: string;
  };
  /** Solde du particulier insuffisant pour une séance prévue (R-WL-06). Écouté par notification (client, lien de recharge). */
  'cleaning.session.balance_insufficient': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    scheduledStart: string;
    amountDue: CleaningMoney;
    missing: CleaningMoney;
    /** Garantie de solde activée */
    guaranteeRequired: boolean;
    trigger: 'assigned' | 'debit';
    detectedAt: string;
  };
  /** Équipe arrivée (partie 10). */
  'cleaning.session.arrived': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Distance à la position du lieu ; null : arrivée sans position */
    distanceMeters: number | null;
    /** Au-delà de arrivalAlertMeters : superviseur alerté */
    alert: boolean;
    arrivedAt: string;
  };
  /** Séance démarrée par le chef d’équipe (partie 10). Écouté par notification (client). */
  'cleaning.session.started': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    leadAgentId: string;
    startedAt: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
  };
  /** Séance interrompue par un incident (partie 10). Écouté par notification (superviseur). */
  'cleaning.session.interrupted': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    incidentId: string;
    category: 'equipment' | 'access' | 'safety' | 'out_of_scope_request' | 'other';
    interruptedAt: string;
  };
  /** Séance réalisée (partie 10). Porte le montant dû : billing construit la facture mensuelle des entreprises sans rappeler cleaning (15.5). */
  'cleaning.session.completed': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Particulier (payé séance par séance) ou entreprise (facture mensuelle) */
    payerKind: 'individual' | 'organization';
    /** Lieu, pour grouper la facture mensuelle par lieu (R-PE-01) */
    placeId: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    scheduledStart: string;
    /** Prix de la séance (prix d’une séance du devis) */
    price: CleaningMoney;
    /** Frais de visite déduits de cette séance (R-FV-05, R-PP-02) : portés par la première séance réalisée ou manquée du programme, au plus son montant dû, le reste par les suivantes ; ligne négative sur la facture mensuelle d’une entreprise ; 0 sinon */
    visitFeeDeduction: CleaningMoney;
    /** Montant dû après déduction ; billing construit la facture sans rappeler cleaning */
    amountDue: CleaningMoney;
    completedAt: string;
    /** Équipe, ou back-office pour son compte (R-EX-08) */
    completedBy: 'team' | 'ksp';
  };
  /** Séance manquée (R-EX-02) ou annulée moins de 24 h avant via le support (partie 12) : 50 % du prix dû. Porte le montant dû, comme cleaning.session.completed. */
  'cleaning.session.missed': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    /** Particulier (payé séance par séance) ou entreprise (facture mensuelle) */
    payerKind: 'individual' | 'organization';
    /** Lieu, pour grouper la facture mensuelle par lieu (R-PE-01) */
    placeId: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    scheduledStart: string;
    /** Prix de la séance (prix d’une séance du devis) */
    price: CleaningMoney;
    /** Frais de visite déduits de cette séance (R-FV-05, R-PP-02) : portés par la première séance réalisée ou manquée du programme, au plus son montant dû, le reste par les suivantes ; ligne négative sur la facture mensuelle d’une entreprise ; 0 sinon */
    visitFeeDeduction: CleaningMoney;
    /** Montant dû après déduction ; billing construit la facture sans rappeler cleaning */
    amountDue: CleaningMoney;
    /** À valider : annulation tardive publiée ici faute d’événement dédié */
    cause: 'customer_absent' | 'access_impossible' | 'late_cancellation';
    /** Part du prix due (5000 = 50 %) */
    feeBps: number;
    missedAt: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** Équipe, ou back-office pour son compte (R-EX-08) */
    reportedBy: 'team' | 'ksp';
  };
  /** Séance d’un particulier à payer : solde insuffisant au débit automatique (R-PP-03). Lien de paiement envoyé par notification. */
  'cleaning.session.payment_due': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    amountDue: CleaningMoney;
    /** Fin du délai de grâce (24 h) */
    dueBy: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
    scheduledStart: string;
  };
  /** Séance d’un particulier payée par débit du wallet (R-PP-01, R-WL-05). */
  'cleaning.session.paid': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    amountPaid: CleaningMoney;
    visitFeeDeduction: CleaningMoney;
    walletTransactionId: string;
    /** Facture de séance (billing), si déjà émise */
    invoiceId: string | null;
    paidAt: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
  };
  /** Séance d’un particulier en retard de paiement après le délai de grâce (R-PP-04) : la suivante ne peut pas démarrer. */
  'cleaning.session.overdue': {
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    amountDue: CleaningMoney;
    overdueSince: string;
    /** Séances en retard du programme */
    overdueCount: number;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
    /** PN-000057 */
    programNumber: string;
    /** Rang de la séance */
    rank: number;
    /** Nombre de séances du programme */
    sessionsCount: number;
  };
  /** Avertissement avant suspension (R-PE-06). Écouté par notification (administrateurs de l’organisation, superviseur). */
  'cleaning.organization.unpaid_warning': {
    organizationId: string;
    unpaidCount: number;
    warningThreshold: number;
    suspensionThreshold: number;
    overdueInvoiceIds: string[];
    warnedAt: string;
  };
  /** Paiement direct reçu pour un objet qui n’est plus payable : montant laissé au wallet (R-PP-07). Écouté par notification (client). */
  'cleaning.direct_payment.left_in_wallet': {
    directPaymentId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    objectType: 'visit_fee' | 'session';
    objectId: string;
    amount: CleaningMoney;
    cause: 'request_closed' | 'already_paid' | 'waived' | 'cancelled';
    leftAt: string;
  };
  /** Candidature d’agent (UC-NT-19) ou agent créé par l’admin (R-AG-02). Écouté par notification (admin). */
  'cleaning.agent.applied': {
    agentId: string;
    userId: string;
    source: 'self' | 'admin_created' | 'invited';
    appliedAt: string;
    /** Communes de travail souhaitées */
    zoneKeys: string[];
  };
  /** Agent validé (R-AG-01) : identity lui donne le rôle cleaning_agent. */
  'cleaning.agent.approved': {
    agentId: string;
    userId: string;
    approvedBy: string;
    /** Compétences validées */
    skillCodes: string[];
    employmentKind: 'employee' | 'independent';
    approvedAt: string;
  };
  /** Réclamation déposée (R-RC-01). */
  'cleaning.claim.opened': {
    claimId: string;
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    category: 'incomplete_work' | 'damage' | 'behavior' | 'missing_item' | 'other';
    openedAt: string;
    /** Commune du lieu, pour joindre le superviseur de la zone */
    communeKey: string;
  };
  /** Réclamation tranchée (R-RC-03) ; un crédit au-delà de 50 000 FCFA n’est publié qu’après la deuxième validation. */
  'cleaning.claim.resolved': {
    claimId: string;
    sessionId: string;
    programId: string;
    /** Compte du client (titulaire ou auteur de la demande) */
    customerId: string;
    /** Organisation cliente ; null pour un particulier */
    organizationId: string | null;
    outcome: 'free_redo' | 'wallet_credit' | 'rejected';
    /** Crédit au wallet (avoir pour une entreprise) ; null sinon */
    creditAmount: CleaningMoney | null;
    /** Repasse gratuite ajoutée */
    redoSessionId: string | null;
    resolvedAt: string;
  };
}

export type CleaningEventType = keyof CleaningEventPayloads;
