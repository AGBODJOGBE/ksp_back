/**
 * Vue de la gateway sur le service cleaning, indépendante de gRPC : l'adaptateur traduit les
 * corps REST en messages protobuf et les réponses en JSON du contrat OpenAPI (montants
 * { amount, currency }, chaînes vides ↔ null). L'utilisateur voyage dans le contexte de la requête.
 */
export type Json = Record<string, unknown>;

export interface Page {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface Slot {
  start: string;
  end: string;
}

export interface RecurrenceInput {
  period: 'week' | 'month';
  visitsPerPeriod: number;
  durationMonths: number;
}

export interface SimulationInput {
  serviceCode: string;
  premisesType: string;
  quantity: number;
  options?: string[] | undefined;
  commune: string;
  frequency?: string | undefined;
}

export interface QuoteRequestInput {
  serviceCode: string;
  premisesType: string;
  quantity: number;
  options?: string[] | undefined;
  commune: string;
  address: string;
  preferredSlots: Slot[];
  comment?: string | undefined;
  recurrence?: RecurrenceInput | undefined;
  requestedTeamSize?: number | undefined;
  daysPerWeek?: number | undefined;
}

/** Acceptation du devis : plan de paiement obligatoire pour un particulier, ignoré pour une entreprise. */
export interface AcceptQuoteInput {
  slotStart: string;
  paymentPlan?: { option: string; timing: string; method: string } | undefined;
}

export interface QuoteInput {
  lines?: { label: string; quantity: number; unitPrice: number }[] | undefined;
  proposedSlots: Slot[];
  validityDays?: number | undefined;
  recurrence?: RecurrenceInput | undefined;
  teamSize?: number | undefined;
  durationMinutes: number;
}

export interface ServiceInput {
  name: string;
  description?: string | undefined;
  unit: string;
  active: boolean;
  pricing: {
    unitPrice: number | null;
    minimumPrice: number | null;
    options?: { code: string; label: string; price: number | null }[] | undefined;
    communeCoefficients?: { commune: string; coefficientBp: number }[] | undefined;
    defaultCoefficientBp?: number | undefined;
    teamSize?: { unitsPerAgent: number; minAgents: number; maxAgents: number } | undefined;
    checklist?: { code: string; label: string }[] | undefined;
  };
}

export interface SettingsInput {
  quoteValidityDays: number;
  minimumLeadHours: number;
  freeCancellationHours: number;
  visitThresholdSquareMeters: number;
  maxOpenRequests: number;
  depositPercent: number;
  /** Réglages de la partie 10 : absents, ils gardent leur valeur en vigueur. */
  businessWarningUnpaidInvoices?: number | undefined;
  businessSuspensionUnpaidInvoices?: number | undefined;
  individualSuspensionUnpaidInterventions?: number | undefined;
  individualPaymentGraceHours?: number | undefined;
}

/** Filtres facultatifs et cumulables de la liste des demandes du back-office. */
export interface QuoteRequestFilters {
  status?: string | undefined;
  /** Code de zone, par exemple « abomey-calavi ». */
  commune?: string | undefined;
  customerKind?: 'individual' | 'business' | undefined;
}

/** Un appel par méthode du contrat ksp.cleaning.v1 exposée en REST. */
export interface CleaningApi {
  listServices(): Promise<Json>;
  simulate(input: SimulationInput): Promise<Json>;
  listServedZones(): Promise<Json>;
  requestQuote(input: QuoteRequestInput, idempotencyKey: string): Promise<Json>;
  listMyRequests(page: Page): Promise<Json>;
  getMyRequest(id: string): Promise<Json>;
  acceptQuote(id: string, input: AcceptQuoteInput, idempotencyKey: string): Promise<Json>;
  declineQuote(id: string, reason: string | undefined): Promise<Json>;
  cancelRequest(id: string, reason: string | undefined): Promise<Json>;
  listMyMissions(page: Page): Promise<Json>;
  getMyMission(id: string): Promise<Json>;
  cancelMyMission(id: string, reason: string | undefined): Promise<Json>;

  listQuoteRequests(page: Page, filters: QuoteRequestFilters): Promise<Json>;
  getQuoteRequest(id: string): Promise<Json>;
  rejectQuoteRequest(id: string, reason: string): Promise<Json>;
  scheduleVisit(id: string, input: { scheduledAt: string; agentId: string }): Promise<Json>;
  completeVisit(visitId: string, report: string): Promise<Json>;
  sendQuote(id: string, input: QuoteInput): Promise<Json>;
  listMissions(page: Page, status: string | undefined): Promise<Json>;
  getMission(id: string): Promise<Json>;
  scheduleIntervention(
    id: string,
    input: {
      scheduledStart: string;
      durationMinutes: number;
      agentIds?: string[] | undefined;
      teamId?: string | undefined;
    },
  ): Promise<Json>;
  /** Idempotency-Key facultative : vide, aucun contrôle de rejeu. */
  recordPayment(
    id: string,
    input: { amount: number; method: string; reference?: string | undefined },
    idempotencyKey: string | undefined,
  ): Promise<Json>;
  cancelMission(id: string, reason: string): Promise<Json>;
  startIntervention(id: string): Promise<Json>;
  updateChecklist(id: string, doneCodes: string[]): Promise<Json>;
  reportIncident(id: string, note: string): Promise<Json>;
  resumeIntervention(id: string): Promise<Json>;
  completeIntervention(id: string): Promise<Json>;
  getCatalog(): Promise<Json>;
  saveService(code: string, input: ServiceInput): Promise<Json>;
  updateSettings(input: SettingsInput): Promise<Json>;
  listZones(): Promise<Json>;
  saveZone(commune: string): Promise<Json>;
  deactivateZone(code: string): Promise<Json>;
  listAgents(): Promise<Json>;
  registerAgent(input: { agentId: string; displayName: string }): Promise<Json>;
  declareUnavailability(
    agentId: string,
    input: { start: string; end: string; reason?: string | undefined },
  ): Promise<Json>;
  listTeams(): Promise<Json>;
  createTeam(input: { name: string; memberIds: string[] }): Promise<Json>;
  updateTeam(id: string, input: { name: string; memberIds: string[] }): Promise<Json>;
}
