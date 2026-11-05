import { type Answers, type FormAnswers, type OptionSelection } from '../../domain/answers';
import { type ServiceDefinition } from '../../domain/catalog';
import {
  canRecordMeasurements,
  effectiveRequestStatus,
  type Measurement,
  type QuoteRequest,
} from '../../domain/quote-request';
import { calculatePrice, type PriceCalculation } from '../../domain/simulator';
import { resolveNewFormat } from '../catalog/pricing-input';
import { type CleaningDeps, presentRequest } from '../deps';
import { requestForStaff } from '../groups/group-support';
import { type AuditEntry } from '../ports';
import { FIELD_WORK, requireStaff, seesEverything, type Staff } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { requireUuid } from '../shared/validation';
import { saveRequest } from './customer-requests.use-cases';

/**
 * Mesures constatées sur le terrain et recalcul du prix d'une demande (ADR-037). Après la visite,
 * l'agent ou le superviseur saisit les dimensions réelles dans le formulaire du client (au nouveau
 * format, validé comme une simulation) ; le prix est calculé avec la grille en vigueur et la commune
 * de la demande. Les réponses du client ne sont jamais remplacées : les mesures sont à part, et le
 * devis est prérempli depuis leur calcul.
 */
export interface MeasurementInput {
  /** Obligatoire, même vide : nouveau format seulement. */
  answers?: Answers | undefined;
  optionSelections?: OptionSelection[] | undefined;
  /** Code de fréquence ; vide : aucune. */
  frequency?: string | undefined;
}

export interface MeasuredPrice {
  service: ServiceDefinition;
  value: FormAnswers;
  calculation: PriceCalculation;
}

/**
 * Calcul de réponses pour une demande : grille en vigueur (même si la prestation est désactivée),
 * commune et taille d'équipe demandée de la demande. `prefix` précède le champ des erreurs
 * (« measurements. », « measurements[1]. »).
 */
export async function priceForRequest(
  deps: CleaningDeps,
  request: QuoteRequest,
  input: MeasurementInput,
  prefix = '',
): Promise<MeasuredPrice> {
  if (input.answers === undefined) throw CleaningErrors.answerRefused(`${prefix}answers`, 'required');
  const service = await deps.catalog.findService(request.serviceCode);
  if (!service) throw CleaningErrors.serviceNotFound();
  const { value } = resolveNewFormat(service, input, prefix);
  const calculation = calculatePrice(service, {
    ...value,
    commune: request.commune,
    requestedTeamSize: request.requestedTeamSize,
  });
  return { service, value, calculation };
}

export type MeasurementSource = 'visit' | 'correction';

/**
 * Mesures d'une demande et leur trace (rien n'est enregistré ici). Refusées une fois un devis
 * envoyé ou la demande close (CLEANING_MEASUREMENTS_LOCKED).
 */
export async function measure(
  deps: CleaningDeps,
  request: QuoteRequest,
  input: MeasurementInput,
  staff: Staff,
  source: MeasurementSource,
  prefix = '',
): Promise<{ request: QuoteRequest; audit: AuditEntry }> {
  const now = deps.clock.now();
  if (!canRecordMeasurements(request, now)) {
    throw CleaningErrors.measurementsLocked(effectiveRequestStatus(request, now));
  }
  const { service, value, calculation } = await priceForRequest(deps, request, input, prefix);
  const measurement: Measurement = {
    answers: value.answers,
    optionSelections: value.options,
    frequency: value.frequency,
    calculation,
    pricingVersion: service.pricing.version,
    measuredAt: now,
    measuredBy: staff.userId,
  };
  return {
    request: { ...request, measurement, updatedAt: now },
    audit: {
      actorId: staff.userId,
      action: 'request.measured',
      entityType: 'quote_request',
      entityId: request.id,
      at: now,
      // Montants et versions seulement : jamais d'adresse ni de commentaire.
      details: {
        source,
        replaced: Boolean(request.measurement),
        pricingVersion: service.pricing.version,
        priced: calculation.priced,
        computedPrice: calculation.computedPrice,
        byAgent: !seesEverything(staff),
      },
    },
  };
}

/** Demande vue par la supervision, ou par l'agent de sa visite (planifiée ou faite) ; sinon introuvable. */
async function requestForMeasurement(deps: CleaningDeps, staff: Staff, requestId: string) {
  const request = await deps.requests.findById(requireUuid('requestId', requestId));
  if (!request) throw CleaningErrors.requestNotFound();
  const assigned =
    request.visit !== null && request.visit.status !== 'cancelled' && request.visit.agentId === staff.userId;
  if (!seesEverything(staff) && !assigned) throw CleaningErrors.requestNotFound();
  return request;
}

export interface RequestEstimate {
  requestId: string;
  serviceCode: string;
  commune: string;
  calculation: PriceCalculation;
}

/**
 * Recalcul sans enregistrement (ADR-037) : même calcul que la simulation, avec la commune de la
 * demande et la grille en vigueur. Supervision, ou agent de la visite de la demande.
 */
export class EstimateRequestPriceUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: MeasurementInput & { requestId: string }): Promise<RequestEstimate> {
    const staff = requireStaff(FIELD_WORK);
    const request = await requestForMeasurement(this.deps, staff, input.requestId);
    const { calculation } = await priceForRequest(this.deps, request, input);
    return { requestId: request.id, serviceCode: request.serviceCode, commune: request.commune, calculation };
  }
}

/**
 * Correction des mesures après la visite, avant l'envoi du devis (ADR-037) : supervision, ou agent
 * de la visite tant qu'aucun devis n'est envoyé. Les mesures précédentes sont remplacées (la trace
 * d'audit garde chaque saisie) ; les réponses du client restent intactes.
 */
export class SaveMeasurementsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: MeasurementInput & { requestId: string }): Promise<QuoteRequest> {
    const staff = requireStaff(FIELD_WORK);
    const request = await requestForMeasurement(this.deps, staff, input.requestId);
    const measured = await measure(this.deps, request, input, staff, 'correction');
    const saved = await saveRequest(this.deps, measured.request, { events: [], audit: [measured.audit] });
    return requestForStaff(staff, presentRequest(saved, this.deps.clock.now()));
  }
}
