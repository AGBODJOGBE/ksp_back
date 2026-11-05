import {
  type AnswerSummary,
  summarizeAnswers,
  summarizeLegacy,
  UNKNOWN_DEFINITION,
} from '../../domain/answer-summary';
import { type ServiceDefinition } from '../../domain/catalog';
import { type QuoteRequest } from '../../domain/quote-request';
import { type CleaningDeps } from '../deps';

/** Résumés lisibles d'une demande (ADR-037) : réponses du client et, au back-office, mesures constatées. */
export interface RequestSummaries {
  answers: AnswerSummary;
  measured: AnswerSummary | null;
}

/**
 * Destinataire de la réponse : les mesures constatées (ADR-037) ne sont montrées qu'au back-office ;
 * le client voit ses réponses et, une fois envoyé, le devis.
 */
export type Audience = 'backoffice' | 'customer';

/**
 * Libellés d'une demande résolus par cleaning au moment de la réponse (ADR-034), comme les noms de
 * l'ADR-029 : nom de la prestation et libellé du type de lieu (même désactivés), taille du groupe,
 * résumés lisibles des réponses (ADR-037).
 */
export interface RequestLabels {
  audience: Audience;
  serviceNames: Map<string, string>;
  placeTypeLabels: Map<string, string>;
  groupSizes: Map<string, number>;
  summaries: Map<string, RequestSummaries>;
}

export const NO_LABELS: RequestLabels = {
  audience: 'customer',
  serviceNames: new Map(),
  placeTypeLabels: new Map(),
  groupSizes: new Map(),
  summaries: new Map(),
};

export class DescribeRequestsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(requests: readonly QuoteRequest[], audience: Audience = 'customer'): Promise<RequestLabels> {
    if (!requests.length) return { ...NO_LABELS, audience };
    const groupIds = [...new Set(requests.flatMap((request) => (request.groupId ? [request.groupId] : [])))];
    const [services, placeTypes, groupSizes] = await Promise.all([
      this.deps.catalog.listServices(),
      this.deps.catalog.listPlaceTypes(),
      groupIds.length ? this.deps.requests.groupSizes(groupIds) : Promise.resolve(new Map<string, number>()),
    ]);
    const current = new Map(services.map((service) => [service.code, service]));

    // Une lecture par (prestation, version) : la version utilisée par le calcul, sinon celle en vigueur.
    const versions = new Map<string, Promise<ServiceDefinition | null>>();
    const definition = (code: string, version: number | null): Promise<ServiceDefinition | null> => {
      const latest = current.get(code) ?? null;
      if (version === null || latest?.pricing.version === version) return Promise.resolve(latest);
      const key = `${code}@${version}`;
      if (!versions.has(key)) {
        versions.set(
          key,
          this.deps.catalog.findServiceVersion(code, version).then((found) => found ?? latest),
        );
      }
      return versions.get(key)!;
    };

    const summaries = new Map<string, RequestSummaries>();
    await Promise.all(
      requests.map(async (request) => {
        const used = await definition(request.serviceCode, request.pricingVersion);
        const answers = request.answers
          ? summarizeAnswers(used ?? UNKNOWN_DEFINITION, {
              answers: request.answers,
              optionSelections: request.optionSelections,
              frequency: request.frequency,
            })
          : summarizeLegacy(used, {
              premisesType: request.premisesType,
              quantity: request.quantity,
              options: request.options,
              frequency: request.frequency,
            });
        const measurement = audience === 'backoffice' ? request.measurement : null;
        const measured = measurement
          ? summarizeAnswers(
              (await definition(request.serviceCode, measurement.pricingVersion)) ?? UNKNOWN_DEFINITION,
              measurement,
            )
          : null;
        summaries.set(request.id, { answers, measured });
      }),
    );
    return {
      audience,
      serviceNames: new Map(services.map((service) => [service.code, service.name])),
      placeTypeLabels: new Map(placeTypes.map((placeType) => [placeType.code, placeType.label])),
      groupSizes,
      summaries,
    };
  }
}
