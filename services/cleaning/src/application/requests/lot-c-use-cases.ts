import { type CleaningDeps } from '../deps';
import { AgentVisitsUseCases } from './agent-visits.use-cases';
import { ClientQuotesUseCases } from './client-quotes.use-cases';
import { ClientRequestsUseCases } from './client-requests.use-cases';
import { CaseDeadlinesUseCase } from './deadlines.use-cases';
import { MoneyEventsUseCases } from './money-events.use-cases';
import { PlacesUseCases } from './places.use-cases';
import { QuotesAdminUseCases } from './quotes-admin.use-cases';
import { RequestAdminUseCases } from './request-admin.use-cases';
import { RetainedValuesUseCases } from './retained.use-cases';
import { SubmitRequestUseCase } from './submit-request.use-case';
import { VisitsAdminUseCases } from './visits-admin.use-cases';

/** Jeton d'injection des cas d'usage du lot C (racine de composition : app.module.ts). */
export const LOT_C_USE_CASES = Symbol('LOT_C_USE_CASES');

/** Cas d'usage du dossier (lot C) : lieux, demande, frais de visite, visite, constat, devis. */
export function lotCUseCases(deps: CleaningDeps) {
  return {
    places: new PlacesUseCases(deps),
    submit: new SubmitRequestUseCase(deps),
    requests: new ClientRequestsUseCases(deps),
    quotes: new ClientQuotesUseCases(deps),
    requestAdmin: new RequestAdminUseCases(deps),
    visitsAdmin: new VisitsAdminUseCases(deps),
    retained: new RetainedValuesUseCases(deps),
    quotesAdmin: new QuotesAdminUseCases(deps),
    agentVisits: new AgentVisitsUseCases(deps),
    deadlines: new CaseDeadlinesUseCase(deps),
    money: new MoneyEventsUseCases(deps),
  };
}

export type LotCUseCases = ReturnType<typeof lotCUseCases>;
