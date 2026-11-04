import { type QuoteRequest } from '../../domain/quote-request';
import { type CleaningDeps } from '../deps';

/**
 * Libellés d'une demande résolus par cleaning au moment de la réponse (ADR-034), comme les noms de
 * l'ADR-029 : nom de la prestation et libellé du type de lieu (même désactivés), taille du groupe.
 */
export interface RequestLabels {
  serviceNames: Map<string, string>;
  placeTypeLabels: Map<string, string>;
  groupSizes: Map<string, number>;
}

export const NO_LABELS: RequestLabels = {
  serviceNames: new Map(),
  placeTypeLabels: new Map(),
  groupSizes: new Map(),
};

export class DescribeRequestsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(requests: readonly Pick<QuoteRequest, 'groupId'>[]): Promise<RequestLabels> {
    if (!requests.length) return NO_LABELS;
    const groupIds = [...new Set(requests.flatMap((request) => (request.groupId ? [request.groupId] : [])))];
    const [services, placeTypes, groupSizes] = await Promise.all([
      this.deps.catalog.listServices(),
      this.deps.catalog.listPlaceTypes(),
      groupIds.length ? this.deps.requests.groupSizes(groupIds) : Promise.resolve(new Map<string, number>()),
    ]);
    return {
      serviceNames: new Map(services.map((service) => [service.code, service.name])),
      placeTypeLabels: new Map(placeTypes.map((placeType) => [placeType.code, placeType.label])),
      groupSizes,
    };
  }
}
