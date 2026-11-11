import { type Mission } from '../domain/mission';
import { effectiveRequestStatus, type QuoteRequest } from '../domain/quote-request';
import { effectiveVisit } from '../domain/request-deadlines';
import { type SchedulePolicy } from '../domain/intervention-schedule';
import { type FieldDatePolicy } from '../domain/schedule';
import {
  type AgentRepository,
  type CatalogRepository,
  type ContractInvoiceRepository,
  type InterventionPhotoStore,
  type MissionRepository,
  type OrganizationStandingRepository,
  type PeopleDirectory,
  type QuoteRequestRepository,
  type ReverseGeocoder,
  type WalletLedger,
} from './ports';
import { type Clock, type IdGenerator } from './shared/system.ports';

/** Dépendances communes des cas d'usage, reliées par la racine de composition. */
export interface CleaningDeps {
  catalog: CatalogRepository;
  requests: QuoteRequestRepository;
  missions: MissionRepository;
  agents: AgentRepository;
  invoices: ContractInvoiceRepository;
  /** Organisations suspendues par KSP, apprises par les événements d'identity (ADR-030). */
  organizations: OrganizationStandingRepository;
  /** Noms affichés au back-office, lus dans identity (ADR-029). */
  people: PeopleDirectory;
  /** Commune d'un point GPS (ADR-034) : Nominatim auto-hébergé, puis Google en secours. */
  geocoder: ReverseGeocoder;
  /** Portefeuille prépayé des clients (service wallet, ADR-046). */
  wallet: WalletLedger;
  /** Photos des passages chez le service file (ADR-038, ADR-053). */
  photos: InterventionPhotoStore;
  /** Contrôles de dates du terrain, réglables par configuration. */
  fieldDates: FieldDatePolicy;
  /** Bornes des plans de passages (ADR-052) : durée et nombre de passages, par configuration. */
  schedules: SchedulePolicy;
  clock: Clock;
  ids: IdGenerator;
}

/** Mission avec le nom affiché de ses agents (« Mes prestations de nettoyage », back-office). */
export interface MissionView {
  mission: Mission;
  agentNames: Record<string, string>;
}

/**
 * Demande telle qu'elle s'affiche : un devis dont la validité est dépassée apparaît expiré, et la
 * visite encore planifiée d'une demande close apparaît annulée (ADR-053).
 */
export function presentRequest(request: QuoteRequest, now: Date): QuoteRequest {
  return { ...request, status: effectiveRequestStatus(request, now), visit: effectiveVisit(request, now) };
}

export async function missionView(deps: CleaningDeps, mission: Mission): Promise<MissionView> {
  const ids = [...new Set(mission.interventions.flatMap((intervention) => intervention.agentIds))];
  const agents = ids.length ? await deps.agents.findAgents(ids) : [];
  return {
    mission,
    agentNames: Object.fromEntries(agents.map((agent) => [agent.agentId, agent.displayName])),
  };
}
