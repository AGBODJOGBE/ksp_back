import { type Mission } from '../../domain/mission';
import { type QuoteRequest } from '../../domain/quote-request';
import { type CleaningDeps } from '../deps';
import { FIELD_WORK, requireStaff } from '../shared/access';

/** Noms affichés d'une réponse du back-office, par identifiant de compte et d'organisation. */
export interface NameBook {
  users: ReadonlyMap<string, string>;
  organizations: ReadonlyMap<string, string>;
}

export const NO_NAMES: NameBook = { users: new Map(), organizations: new Map() };

interface NameRequest {
  /** Clients : nom lu dans identity. */
  customerIds: (string | null | undefined)[];
  /** Équipe KSP (agent de visite, auteur d'un paiement ou d'un réglage) : nom de la fiche agent d'abord. */
  staffIds: (string | null | undefined)[];
  organizationIds: (string | null | undefined)[];
}

const present = (ids: (string | null | undefined)[]) => [
  ...new Set(ids.filter((id): id is string => Boolean(id))),
];

/**
 * Noms lisibles du back-office (ADR-029) : client et organisation des demandes et missions,
 * agent de la visite, auteur d'un paiement ou d'un changement de grille, de réglage ou de zone.
 *
 * - Un membre de l'équipe rattaché comme agent garde le nom de sa fiche agent (celui des passages) ;
 *   les autres comptes sont lus dans identity, en un appel par lot.
 * - Rien n'est enregistré : un nom changé dans identity apparaît à la lecture suivante.
 * - Identity indisponible : les noms manquent, la réponse n'échoue pas (PeopleDirectory).
 */
export class ResolveBackofficeNamesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  forRequests(requests: readonly QuoteRequest[]): Promise<NameBook> {
    return this.execute({
      customerIds: requests.map((request) => request.customerId),
      staffIds: requests.map((request) => request.visit?.agentId),
      organizationIds: requests.map((request) => request.organizationId),
    });
  }

  forMissions(missions: readonly Mission[]): Promise<NameBook> {
    return this.execute({
      customerIds: missions.map((mission) => mission.customerId),
      // Paiement en ligne : enregistré par le système (« system »), pas par un membre de l'équipe.
      staffIds: missions.flatMap((mission) =>
        mission.payment.payments
          .filter((record) => record.method !== 'mobile_money_online')
          .map((record) => record.recordedBy),
      ),
      organizationIds: missions.map((mission) => mission.organizationId),
    });
  }

  /** Auteurs des changements de grille, de réglages ou de zones. */
  forAuthors(authorIds: (string | null | undefined)[]): Promise<NameBook> {
    return this.execute({ customerIds: [], staffIds: authorIds, organizationIds: [] });
  }

  private async execute(input: NameRequest): Promise<NameBook> {
    requireStaff(FIELD_WORK);
    const staffIds = present(input.staffIds);
    const organizationIds = present(input.organizationIds);
    const agents = staffIds.length ? await this.deps.agents.findAgents(staffIds) : [];
    const agentNames = new Map(
      agents.filter((agent) => agent.displayName).map((agent) => [agent.agentId, agent.displayName]),
    );
    const fromIdentity = present([...input.customerIds, ...staffIds.filter((id) => !agentNames.has(id))]);
    const [users, organizations] = await Promise.all([
      fromIdentity.length ? this.deps.people.userNames(fromIdentity) : new Map<string, string>(),
      organizationIds.length
        ? this.deps.people.organizationNames(organizationIds)
        : new Map<string, string>(),
    ]);
    return { users: new Map([...users, ...agentNames]), organizations };
  }
}
