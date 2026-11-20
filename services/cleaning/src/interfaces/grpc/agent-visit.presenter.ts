import { type cleaningV1 } from '@ksp/contracts';
import { type AgentVisit } from '../../application/requests/agent-visits.use-cases';
import { type CleaningDeps } from '../../application/deps';
import { decryptLocation } from '../../application/requests/locations';
import { type CaseRecord } from '../../application/requests/requests.ports';
import { presentPublicParameter } from './catalog.presenters';
import { CasePresenter } from './case.presenters';
import { parameterValues, placeLocation } from './case-values.presenters';

/**
 * Visite vue par l'agent affecté (UC-NT-22) : constat prérempli avec le déclaré, sans montants
 * (R-EX-04) ; position et adresses seulement pendant la visite en cours (R-EX-06, RV-43).
 */
export async function presentAgentVisit(
  deps: CleaningDeps,
  view: Pick<AgentVisit, 'record' | 'visit' | 'showLocation'> & { isLead: boolean },
): Promise<cleaningV1.AgentVisitView> {
  const { record, visit } = view;
  const [base, placeType, types, parameters, communes] = await Promise.all([
    new CasePresenter(deps).visit(record, visit, { kind: 'agent', amounts: false }),
    deps.places.getPlaceType(record.request.placeTypeId),
    deps.cleaningTypes.listCleaningTypes(),
    deps.parameters.listParameters(),
    deps.communes.listCommunes().catch(() => []),
  ]);
  const asked = new Set(Object.keys(record.request.declaredValues));
  return {
    id: visit.id,
    requestNumber: record.request.number,
    status: base.status,
    scheduledAt: base.scheduledAt,
    durationMinutes: base.durationMinutes,
    isLead: view.isLead,
    place: {
      name: '',
      placeTypeName: placeType?.name ?? '',
      communeName:
        communes.find((commune) => commune.key === record.request.communeKey)?.name ??
        record.request.communeKey,
      location: view.showLocation
        ? placeLocation(decryptLocation(deps.cipher, 'request', record.request.id, record.request))
        : undefined,
      customerFirstName: '',
    },
    cleaningTypes: record.request.cleaningTypeIds.map((id) => {
      const type = types.find((item) => item.id === id);
      return { id, code: type?.code ?? '', name: type?.name ?? '' };
    }),
    parameters: parameters.filter((parameter) => asked.has(parameter.code)).map(presentPublicParameter),
    declaredValues: parameterValues(record.request.declaredValues),
    observedValues: parameterValues(visit.observedValues ?? record.request.declaredValues),
    photos: base.photos,
    arrival: base.arrival,
    completedAt: base.completedAt,
    note: visit.observationNote ?? undefined,
  };
}

/** Visite relue après une action de l'agent. */
export async function agentVisitAfter(
  deps: CleaningDeps,
  record: CaseRecord,
  visitId: string,
  isLead: boolean,
): Promise<cleaningV1.AgentVisitView> {
  const fresh = (await deps.cases.findCase(record.request.id)) ?? record;
  const visit = fresh.visits.find((item) => item.id === visitId)!;
  return presentAgentVisit(deps, {
    record: fresh,
    visit,
    showLocation: visit.status === 'in_progress',
    isLead,
  });
}
