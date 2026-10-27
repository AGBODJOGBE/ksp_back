import { normalizeCommune, PREMISES_TYPES, type ServiceDefinition } from '../../domain/catalog';
import { type Simulation, simulate, unknownOptions } from '../../domain/simulator';
import { isCovered, type Zone } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from '../shared/errors';
import { oneOf, requiredText, requirePositiveInt } from '../shared/validation';

export const SIMULATION_FREQUENCIES = ['once', 'weekly', 'monthly'] as const;
export const ESTIMATE_NOTICE =
  'Estimation non contractuelle : le prix définitif figure dans le devis établi par KSP.';
export const PRICE_NOT_SET_NOTICE =
  "Le prix de cette prestation n'est pas encore publié : demandez un devis, KSP vous répondra.";

/** Prestation active, sinon introuvable (une prestation désactivée n'existe plus pour le public). */
export async function activeService(deps: CleaningDeps, code: string): Promise<ServiceDefinition> {
  const service = await deps.catalog.findService(code);
  if (!service || !service.active) throw CleaningErrors.serviceNotFound();
  return service;
}

/** UC-CL-01 : catalogue public. */
export class ListServicesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<ServiceDefinition[]> {
    return (await this.deps.catalog.listServices()).filter((service) => service.active);
  }
}

/** Zones desservies publiques : les seules communes actives, où une demande de devis est acceptée. */
export class ListServedZonesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<Zone[]> {
    return (await this.deps.catalog.listZones()).filter((zone) => zone.active);
  }
}

export interface SimulateInput {
  serviceCode: string;
  premisesType: string;
  quantity: number;
  options: string[];
  commune: string;
  frequency: string;
}

export interface SimulationResult {
  serviceCode: string;
  simulation: Simulation;
  notice: string;
  /** Commune dans une zone desservie ; l'estimation est donnée dans tous les cas. */
  covered: boolean;
}

/** UC-CL-01 : simulateur public. Calcul local, rien n'est enregistré. */
export class SimulateUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SimulateInput): Promise<SimulationResult> {
    oneOf('premisesType', input.premisesType, PREMISES_TYPES);
    if (input.frequency) oneOf('frequency', input.frequency, SIMULATION_FREQUENCIES);
    const quantity = requirePositiveInt('quantity', input.quantity);
    const commune = requiredText('commune', input.commune, 100);
    const service = await activeService(this.deps, input.serviceCode);
    if (unknownOptions(service, input.options).length) throw CleaningErrors.invalid('options');

    const simulation = simulate(service, {
      quantity,
      options: input.options,
      commune: normalizeCommune(commune),
    });
    return {
      serviceCode: service.code,
      simulation,
      notice: simulation.priced ? ESTIMATE_NOTICE : PRICE_NOT_SET_NOTICE,
      covered: isCovered(await this.deps.catalog.listZones(), commune),
    };
  }
}
