import { type ServiceDefinition } from '../../domain/catalog';
import { calculatePrice, type PriceCalculation } from '../../domain/simulator';
import { isCovered, type Zone } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from '../shared/errors';
import { requiredText } from '../shared/validation';
import { type PricingInput, resolveAnswers } from './pricing-input';

export const ESTIMATE_NOTICE =
  'Estimation non contractuelle : le prix définitif figure dans le devis établi par KSP.';
export const PRICE_NOT_SET_NOTICE =
  "Le prix de cette prestation n'est pas encore publié : demandez un devis, KSP vous répondra.";
export const ANSWERS_INCOMPLETE_NOTICE =
  'Précisez votre besoin pour obtenir une estimation, ou demandez un devis : KSP vous répondra.';

/** Mention affichée avec un calcul. */
export function calculationNotice(calculation: PriceCalculation): string {
  if (calculation.priced) return ESTIMATE_NOTICE;
  return calculation.reason === 'answers_incomplete' ? ANSWERS_INCOMPLETE_NOTICE : PRICE_NOT_SET_NOTICE;
}

/** Prestation active, sinon introuvable (une prestation désactivée n'existe plus pour le public). */
export async function activeService(deps: CleaningDeps, code: string): Promise<ServiceDefinition> {
  const service = await deps.catalog.findService(code);
  if (!service || !service.active) throw CleaningErrors.serviceNotFound();
  return service;
}

/** UC-CL-01 : catalogue public (le formulaire public est construit sans prix par l'interface). */
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

export interface SimulateInput extends PricingInput {
  serviceCode: string;
  commune: string;
}

export interface SimulationResult {
  serviceCode: string;
  calculation: PriceCalculation;
  notice: string;
  /** Commune dans une zone desservie ; l'estimation est donnée dans tous les cas. */
  covered: boolean;
}

/** UC-CL-01 : simulateur public. Calcul local, rien n'est enregistré. */
export class SimulateUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SimulateInput): Promise<SimulationResult> {
    const commune = requiredText('commune', input.commune, 100);
    const service = await activeService(this.deps, input.serviceCode);
    const { value, incomplete } = resolveAnswers(service, input);
    const calculation = calculatePrice(service, { ...value, commune, incomplete });
    return {
      serviceCode: service.code,
      calculation,
      notice: calculationNotice(calculation),
      covered: isCovered(await this.deps.catalog.listZones(), commune),
    };
  }
}
