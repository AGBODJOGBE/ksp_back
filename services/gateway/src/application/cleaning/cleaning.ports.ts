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

/** Réponse à un champ du formulaire d'une prestation (ADR-033). */
export type Answers = Record<string, number | string | boolean>;

export interface OptionSelectionInput {
  code: string;
  answers?: Answers | undefined;
}

/**
 * Réponses d'une simulation ou d'une demande (ADR-033) : nouveau format avec `answers` (options en
 * objets), ou ancien format déprécié (`premisesType`, `quantity`, options en codes).
 */
export interface FormAnswersInput {
  answers?: Answers | undefined;
  options?: (string | OptionSelectionInput)[] | undefined;
  frequency?: string | undefined;
  premisesType?: string | undefined;
  quantity?: number | undefined;
}

export interface SimulationInput extends FormAnswersInput {
  serviceCode: string;
  /** Facultative (ADR-034) : absente, coefficient de commune neutre. */
  commune?: string | undefined;
}

/** Une prestation d'un lieu (ADR-034) : réponses au nouveau format seulement. */
export interface PlaceItemInput {
  serviceCode: string;
  answers: Answers;
  options?: OptionSelectionInput[] | undefined;
  frequency?: string | undefined;
}

export interface EstimateInput {
  placeType: string;
  commune?: string | undefined;
  items: PlaceItemInput[];
}

export interface LocationInput {
  latitude: number;
  longitude: number;
}

export interface QuoteGroupInput {
  placeType: string;
  location: LocationInput & { accuracyMeters?: number | undefined };
  landmark: string;
  /** Repli si le géocodage ne trouve pas la commune. */
  commune?: string | undefined;
  items: (PlaceItemInput & { requestedTeamSize?: number | undefined })[];
  preferredSlots: Slot[];
  comment?: string | undefined;
  recurrence?: RecurrenceInput | undefined;
}

export interface PlaceTypeInput {
  label: string;
  description?: string | undefined;
  icon: string;
  displayOrder: number;
  active: boolean;
  serviceCodes: string[];
}

/** Filtres facultatifs et cumulables de la liste des missions du back-office. */
export interface MissionFilters {
  status?: string | undefined;
  groupId?: string | undefined;
  serviceCode?: string | undefined;
}

export interface QuoteRequestInput extends FormAnswersInput {
  serviceCode: string;
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

export interface FieldInput {
  code: string;
  label: string;
  type: string;
  required: boolean;
  helpText?: string | null | undefined;
  active: boolean;
  unitLabel?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
  pricePerUnit?: number | null | undefined;
  choices?:
    | {
        code: string;
        label: string;
        supplement: number | null;
        coefficientBp?: number | null | undefined;
        active: boolean;
      }[]
    | undefined;
  supplementIfYes?: number | null | undefined;
  coefficientBpIfYes?: number | null | undefined;
}

/** Prestation complète au nouveau format (ADR-033) : champs, options, grille. */
export interface ServiceInput {
  name: string;
  description?: string | undefined;
  active: boolean;
  fields: FieldInput[];
  options?:
    | {
        code: string;
        label: string;
        description?: string | null | undefined;
        active: boolean;
        flatPrice: number | null;
        fields?: FieldInput[] | undefined;
      }[]
    | undefined;
  pricing: {
    minimumPrice: number | null;
    communeCoefficients?: { commune: string; coefficientBp: number }[] | undefined;
    defaultCoefficientBp?: number | undefined;
    frequencies?: { code: string; label: string; coefficientBp: number; active: boolean }[] | undefined;
    teamSize?:
      | { fieldCode?: string | null | undefined; unitsPerAgent: number; minAgents: number; maxAgents: number }
      | undefined;
    checklist?: { code: string; label: string }[] | undefined;
  };
}

/** Essai d'une grille : définition envoyée (non enregistrée) ou version en vigueur. */
/** Mesures constatées ou réponses à recalculer (ADR-037) : nouveau format seulement. */
export interface MeasurementBody {
  answers: Answers;
  options?: OptionSelectionInput[] | undefined;
  frequency?: string | undefined;
}

/** Mesures d'une demande de la visite commune (ADR-037). */
export interface GroupMeasurementBody extends MeasurementBody {
  requestId: string;
}

export interface PreviewInput {
  definition?: ServiceInput | undefined;
  answers: Answers;
  options?: OptionSelectionInput[] | undefined;
  commune: string;
  frequency?: string | undefined;
  requestedTeamSize?: number | undefined;
}

export interface SettingsInput {
  quoteValidityDays: number;
  minimumLeadHours: number;
  freeCancellationHours: number;
  /** Déprécié (ADR-033) : ignoré par cleaning. */
  visitThresholdSquareMeters?: number | undefined;
  maxOpenRequests: number;
  depositPercent: number;
  /** Réglages de la partie 10 : absents, ils gardent leur valeur en vigueur. */
  businessWarningUnpaidInvoices?: number | undefined;
  businessSuspensionUnpaidInvoices?: number | undefined;
  individualSuspensionUnpaidInterventions?: number | undefined;
  individualPaymentGraceHours?: number | undefined;
  /** Conservation de la position (ADR-035) : absente, valeur en vigueur gardée. */
  locationRetentionMonths?: number | undefined;
}

/** Filtres facultatifs et cumulables de la liste des demandes du back-office. */
export interface QuoteRequestFilters {
  status?: string | undefined;
  /** Code de zone, par exemple « abomey-calavi ». */
  commune?: string | undefined;
  customerKind?: 'individual' | 'business' | undefined;
  /** Parcours par lieu (ADR-034). */
  groupId?: string | undefined;
  placeType?: string | undefined;
  serviceCode?: string | undefined;
}

/** Devis d'une demande d'un groupe (ADR-035) : mêmes règles qu'un devis seul. */
export interface GroupQuotesInput {
  proposedSlots: Slot[];
  validityDays?: number | undefined;
  quotes: (Omit<QuoteInput, 'proposedSlots' | 'validityDays'> & { requestId: string })[];
}

export interface GroupInterventionsInput {
  missionIds?: string[] | undefined;
  scheduledStart: string;
  durationMinutes: number;
  agentIds?: string[] | undefined;
  teamId?: string | undefined;
}

export interface LocationCorrectionInput {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | undefined;
  landmark?: string | undefined;
  commune?: string | undefined;
}

/** Filtres facultatifs de la liste des visites (ADR-035). */
export interface VisitFilters {
  agentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: string | undefined;
  groupId?: string | undefined;
}

/** Un appel par méthode du contrat ksp.cleaning.v1 exposée en REST. */
export interface CleaningApi {
  listServices(): Promise<Json>;
  simulate(input: SimulationInput): Promise<Json>;
  listServedZones(): Promise<Json>;
  getPlaceCatalog(): Promise<Json>;
  estimate(input: EstimateInput): Promise<Json>;
  resolveLocation(input: LocationInput): Promise<Json>;
  requestQuoteGroup(input: QuoteGroupInput, idempotencyKey: string): Promise<Json>;
  getMyQuoteRequestGroup(id: string): Promise<Json>;
  cancelQuoteRequestGroup(id: string, reason: string | undefined, idempotencyKey: string): Promise<Json>;
  acceptQuoteGroup(id: string, input: AcceptQuoteInput, idempotencyKey: string): Promise<Json>;
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
  /** Mesures constatées facultatives (ADR-037). */
  completeVisit(visitId: string, report: string, measurements?: MeasurementBody | undefined): Promise<Json>;
  /** Recalcul sans enregistrement et mesures constatées (ADR-037). */
  estimateRequestPrice(id: string, input: MeasurementBody): Promise<Json>;
  saveRequestMeasurements(id: string, input: MeasurementBody): Promise<Json>;
  sendQuote(id: string, input: QuoteInput): Promise<Json>;
  /** Opérations de groupe (ADR-035) : Idempotency-Key facultative. */
  scheduleGroupVisit(
    id: string,
    input: { scheduledAt: string; agentId: string; excludeRequestIds?: string[] | undefined },
    idempotencyKey: string | undefined,
  ): Promise<Json>;
  completeGroupVisit(
    id: string,
    report: string,
    idempotencyKey: string | undefined,
    measurements?: GroupMeasurementBody[] | undefined,
  ): Promise<Json>;
  rejectRequestGroup(id: string, reason: string, idempotencyKey: string | undefined): Promise<Json>;
  sendGroupQuotes(id: string, input: GroupQuotesInput, idempotencyKey: string | undefined): Promise<Json>;
  scheduleGroupInterventions(
    id: string,
    input: GroupInterventionsInput,
    idempotencyKey: string | undefined,
  ): Promise<Json>;
  correctRequestLocation(id: string, input: LocationCorrectionInput): Promise<Json>;
  listVisits(page: Page, filters: VisitFilters): Promise<Json>;
  listMissions(page: Page, filters: MissionFilters): Promise<Json>;
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
  previewService(code: string, input: PreviewInput): Promise<Json>;
  updateSettings(input: SettingsInput): Promise<Json>;
  listZones(): Promise<Json>;
  /** Noms alternatifs : absents, ceux en vigueur sont gardés (ADR-034). */
  saveZone(commune: string, aliases?: string[] | undefined): Promise<Json>;
  listPlaceTypes(): Promise<Json>;
  savePlaceType(code: string, input: PlaceTypeInput): Promise<Json>;
  deactivateZone(code: string, confirm?: boolean | undefined): Promise<Json>;
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
