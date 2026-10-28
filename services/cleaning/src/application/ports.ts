import { type CleaningEventPayloads, type CleaningEventType } from '@ksp/contracts';
import { type Agent, type Team, type Unavailability } from '../domain/agent';
import { type PricingRule, type ServiceDefinition } from '../domain/catalog';
import { type Intervention, type Mission, type MissionStatus } from '../domain/mission';
import { type CustomerKind, type QuoteRequest, type RequestStatus } from '../domain/quote-request';
import { type BusyPeriod } from '../domain/schedule';
import { type CleaningSettings } from '../domain/settings';
import { type Zone } from '../domain/zone';
import { type PageRequest, type PageResult } from './shared/validation';

/**
 * Ports du service cleaning. Chaque écriture porte ses événements (outbox) et ses traces
 * (auteur, date) : l'adaptateur les enregistre dans la même transaction que l'état.
 */
export type OutboxMessage = {
  [K in CleaningEventType]: { type: K; payload: CleaningEventPayloads[K] };
}[CleaningEventType];

/** Trace locale d'un changement de prix, de devis ou d'affectation (en attendant le service audit). */
export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: 'quote_request' | 'mission' | 'service' | 'settings' | 'agent' | 'team' | 'zone';
  entityId: string;
  at: Date;
  /** Identifiants et montants seulement : jamais d'adresse ni de commentaire. */
  details?: Record<string, unknown>;
}

export interface Changes {
  events: OutboxMessage[];
  audit: AuditEntry[];
}

export type NewPricing = Omit<PricingRule, 'version' | 'updatedBy' | 'updatedAt'>;

export interface StoredSettings extends CleaningSettings {
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface CatalogRepository {
  listServices(): Promise<ServiceDefinition[]>;
  findService(code: string): Promise<ServiceDefinition | null>;
  /** Crée ou modifie la prestation ; la grille devient une nouvelle version datée, avec son auteur. */
  saveService(
    service: Omit<ServiceDefinition, 'pricing'>,
    pricing: NewPricing,
    changes: Changes,
  ): Promise<ServiceDefinition>;
  getSettings(): Promise<StoredSettings>;
  saveSettings(settings: CleaningSettings, changes: Changes): Promise<StoredSettings>;
  /** Zones desservies, actives et désactivées, par nom de commune. */
  listZones(): Promise<Zone[]>;
  /** Crée ou modifie la zone (clé = commune normalisée). */
  saveZone(zone: Zone, changes: Changes): Promise<Zone>;
}

export type CreateResult<T> = { created: true; value: T } | { created: false; value: T };

/** Filtres cumulables de la liste des demandes. */
export interface QuoteRequestFilter {
  customerId?: string;
  status?: RequestStatus;
  /** Code de zone : commune normalisée (zoneCode), comparée à celle enregistrée avec la demande. */
  communeCode?: string;
  customerKind?: CustomerKind;
}

export interface QuoteRequestRepository {
  /** Idempotent par (client, clé) : un second appel renvoie la demande déjà créée. */
  create(
    request: QuoteRequest,
    idempotencyKey: string,
    changes: Changes,
  ): Promise<CreateResult<QuoteRequest>>;
  findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<QuoteRequest | null>;
  findById(id: string): Promise<QuoteRequest | null>;
  /** Mission déjà créée par une acceptation avec cette clé, ou null. */
  findAcceptance(requestId: string, idempotencyKey: string): Promise<string | null>;
  findByVisitId(visitId: string): Promise<QuoteRequest | null>;
  list(filter: QuoteRequestFilter, page: PageRequest): Promise<PageResult<QuoteRequest>>;
  /** Demandes du client à l'état reçue, visite planifiée ou devis envoyé encore valide. */
  countOpen(customerId: string, now: Date): Promise<number>;
  /** Enregistre la demande si sa version n'a pas changé depuis la lecture ; sinon false. */
  save(request: QuoteRequest, changes: Changes): Promise<boolean>;
  /**
   * Acceptation atomique : demande acceptée et mission créée dans la même transaction.
   * Idempotent par clé ; une acceptation concurrente renvoie `conflict`. La mission d'une
   * organisation suspendue n'est pas créée (`organization_suspended`) : l'état de l'organisation
   * est lu sous le même verrou que son enregistrement (OrganizationStandingRepository.record),
   * si bien qu'une mission créée est toujours vue par la suspension qui suit.
   */
  accept(
    request: QuoteRequest,
    mission: Mission,
    idempotencyKey: string,
    changes: Changes,
  ): Promise<
    | { status: 'created' }
    | { status: 'replayed'; missionId: string }
    | { status: 'conflict' }
    | { status: 'organization_suspended' }
  >;
}

export interface MissionFilter {
  customerId?: string;
  agentId?: string;
  status?: MissionStatus;
}

export interface MissionRepository {
  findById(id: string): Promise<Mission | null>;
  findByInterventionId(interventionId: string): Promise<Mission | null>;
  list(filter: MissionFilter, page: PageRequest): Promise<PageResult<Mission>>;
  /** Enregistre la mission et ses passages si sa version n'a pas changé ; sinon false. */
  save(mission: Mission, changes: Changes): Promise<boolean>;
  /**
   * Planifie un passage sans double réservation : verrouille les agents, lit leurs périodes
   * occupées (passages actifs et indisponibilités), demande au domaine les conflits ; s'il n'y
   * en a aucun, enregistre la mission. Renvoie les agents en conflit (vide si enregistré).
   */
  scheduleIntervention(
    mission: Mission,
    intervention: Intervention,
    conflicts: (busy: BusyPeriod[]) => string[],
    changes: Changes,
  ): Promise<{ conflicts: string[]; saved: boolean }>;
  /** Missions non terminées du client (bloquent la suppression du compte). */
  pendingForCustomer(customerId: string): Promise<{ id: string; status: MissionStatus }[]>;
  /**
   * Reprogrammation : verrouille les agents donnés, lit leurs périodes occupées (passages actifs
   * et indisponibilités), laisse `plan` construire la mission et ses changements, puis enregistre
   * si la version n'a pas changé. Renvoie false en cas de modification concurrente.
   */
  saveWithAgenda(
    agentIds: string[],
    plan: (busy: BusyPeriod[]) => { mission: Mission; changes: Changes },
  ): Promise<boolean>;
  /** Missions de particuliers en récurrent, non terminées : surveillance des passages impayés. */
  listIndividualRecurring(): Promise<Mission[]>;
  /** Missions non terminées d'une organisation : suspension ou reprise avec elle (ADR-030). */
  listActiveForOrganization(organizationId: string): Promise<Mission[]>;
}

export type ContractInvoiceStatus = 'overdue' | 'paid';

/**
 * Factures d'entreprise apprises par les événements de billing. L'inbox et l'état sont écrits
 * dans la même transaction ; une facture payée ne redevient jamais impayée, quel que soit
 * l'ordre d'arrivée des événements.
 */
export interface ContractInvoiceRepository {
  record(input: {
    eventId: string;
    consumer: string;
    invoiceId: string;
    missionId: string;
    status: ContractInvoiceStatus;
    at: Date;
  }): Promise<'processed' | 'duplicate'>;
  countOverdue(missionId: string): Promise<number>;
}

/**
 * Organisations suspendues par KSP, apprises par les événements d'identity (ADR-030). L'inbox et
 * l'état sont écrits dans la même transaction ; un événement plus ancien que le dernier appliqué
 * à l'organisation est sans effet (ordre d'arrivée indifférent) ; à date égale, la suspension
 * l'emporte.
 */
export interface OrganizationStandingRepository {
  record(input: {
    eventId: string;
    consumer: string;
    organizationId: string;
    suspended: boolean;
    /** Date de la décision (occurredAt de l'événement). */
    at: Date;
  }): Promise<'processed' | 'duplicate'>;
  isSuspended(organizationId: string): Promise<boolean>;
}

export interface AgentRepository {
  listAgents(): Promise<Agent[]>;
  findAgents(agentIds: string[]): Promise<Agent[]>;
  register(agent: Agent, changes: Changes): Promise<boolean>;
  addUnavailability(agentId: string, unavailability: Unavailability, changes: Changes): Promise<void>;
  listTeams(): Promise<Team[]>;
  findTeam(teamId: string): Promise<Team | null>;
  saveTeam(team: Team, changes: Changes): Promise<void>;
}

/**
 * Paiement en ligne par Mobile Money (FedaPay), branché plus tard par le service payment : il
 * enregistrera l'encaissement à réception de payment.intent.succeeded. Aucun adaptateur au lot 2.
 */
export interface OnlinePaymentRecorder {
  recordOnlinePayment(input: {
    missionId: string;
    amount: number;
    providerReference: string;
    at: Date;
  }): Promise<void>;
}

/**
 * Noms affichés au back-office (ADR-029), lus dans identity au moment de la réponse : prénom et
 * nom d'un compte, raison sociale d'une organisation. Lecture au mieux : un identifiant inconnu
 * est absent, et une panne d'identity rend des noms absents au lieu d'une erreur (la liste du
 * back-office reste utilisable). Aucun nom n'est enregistré dans cleaning.
 */
export interface PeopleDirectory {
  userNames(userIds: readonly string[]): Promise<Map<string, string>>;
  organizationNames(organizationIds: readonly string[]): Promise<Map<string, string>>;
}
