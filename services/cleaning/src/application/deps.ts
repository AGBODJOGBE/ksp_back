import { type Mission } from '../domain/mission';
import { effectiveRequestStatus, type QuoteRequest } from '../domain/quote-request';
import {
  type AgentRepository,
  type CatalogRepository,
  type ContractInvoiceRepository,
  type MissionRepository,
  type QuoteRequestRepository,
} from './ports';
import { type Clock, type IdGenerator } from './shared/system.ports';

/** Dépendances communes des cas d'usage, reliées par la racine de composition. */
export interface CleaningDeps {
  catalog: CatalogRepository;
  requests: QuoteRequestRepository;
  missions: MissionRepository;
  agents: AgentRepository;
  invoices: ContractInvoiceRepository;
  clock: Clock;
  ids: IdGenerator;
}

/** Mission avec le nom affiché de ses agents (« Mes prestations de nettoyage », back-office). */
export interface MissionView {
  mission: Mission;
  agentNames: Record<string, string>;
}

/** Demande telle qu'elle s'affiche : un devis dont la validité est dépassée apparaît expiré. */
export function presentRequest(request: QuoteRequest, now: Date): QuoteRequest {
  return { ...request, status: effectiveRequestStatus(request, now) };
}

export async function missionView(deps: CleaningDeps, mission: Mission): Promise<MissionView> {
  const ids = [...new Set(mission.interventions.flatMap((intervention) => intervention.agentIds))];
  const agents = ids.length ? await deps.agents.findAgents(ids) : [];
  return {
    mission,
    agentNames: Object.fromEntries(agents.map((agent) => [agent.agentId, agent.displayName])),
  };
}
