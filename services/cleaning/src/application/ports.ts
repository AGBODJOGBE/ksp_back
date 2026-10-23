import { type CleaningEventPayloads, type CleaningEventType } from '@ksp/contracts';
import { type Agent, type Team, type Unavailability } from '../domain/agent';
import { type PricingRule, type ServiceDefinition } from '../domain/catalog';
import { type Intervention, type Mission, type MissionStatus } from '../domain/mission';
import { type QuoteRequest, type RequestStatus } from '../domain/quote-request';
import { type BusyPeriod } from '../domain/schedule';
import { type CleaningSettings } from '../domain/settings';
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
  entityType: 'quote_request' | 'mission' | 'service' | 'settings' | 'agent' | 'team';
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
}

export type CreateResult<T> = { created: true; value: T } | { created: false; value: T };

export interface QuoteRequestFilter {
  customerId?: string;
  status?: RequestStatus;
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
   * Idempotent par clé ; une acceptation concurrente renvoie `conflict`.
   */
  accept(
    request: QuoteRequest,
    mission: Mission,
    idempotencyKey: string,
    changes: Changes,
  ): Promise<{ status: 'created' } | { status: 'replayed'; missionId: string } | { status: 'conflict' }>;
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
