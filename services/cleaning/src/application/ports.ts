import { type CleaningEventPayloads, type CleaningEventType } from '@ksp/contracts';
import { type Agent, type Team, type Unavailability } from '../domain/agent';
import { type Assignment } from '../domain/agenda';
import { type PricingRule, type ServiceDefinition } from '../domain/catalog';
import { type GeocodedPlace, type GeoPoint } from '../domain/location';
import { type Intervention, type Mission, type MissionStatus } from '../domain/mission';
import { type PlaceType } from '../domain/place-type';
import {
  type CustomerKind,
  type QuoteRequest,
  type QuoteRequestGroup,
  type RequestStatus,
  type VisitStatus,
} from '../domain/quote-request';
import { type SkippedMission, type SkippedRequest } from '../domain/request-group';
import { type BusyPeriod } from '../domain/schedule';
import { type BatchConflict } from '../domain/intervention-batch';
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
  entityType:
    | 'quote_request'
    | 'mission'
    | 'service'
    | 'settings'
    | 'agent'
    | 'team'
    | 'zone'
    | 'place_type'
    | 'request_group'
    | 'mission_group';
  entityId: string;
  at: Date;
  /** Identifiants et montants seulement : jamais d'adresse ni de commentaire. */
  details?: Record<string, unknown>;
}

/** Débit du portefeuille prépayé d'un client (wallet.Debit, ADR-046). */
export interface WalletDebit {
  transactionId: string;
  amount: number;
  created: boolean;
}

/**
 * Portefeuille prépayé (service wallet, jeton de service, ADR-046). Débit jamais partiel :
 * solde insuffisant → AppError WALLET_INSUFFICIENT_FUNDS (montant manquant), transmise telle quelle
 * au client. Idempotent par clé. Remboursement d'un débit : une seule fois.
 */
export interface WalletLedger {
  debit(input: {
    idempotencyKey: string;
    holder: { type: 'user' | 'organization'; id: string };
    amount: number;
    object: { objectType: string; objectId: string; part: string };
    description: string;
  }): Promise<WalletDebit>;
  refund(input: { transactionId: string; reason: string }): Promise<void>;
}

export interface Changes {
  events: OutboxMessage[];
  audit: AuditEntry[];
}

export type NewPricing = Omit<PricingRule, 'version' | 'updatedBy' | 'updatedAt'>;

/** Définition complète à enregistrer : sa grille devient une nouvelle version. */
export type NewServiceVersion = Omit<ServiceDefinition, 'pricing'> & { pricing: NewPricing };

export interface StoredSettings extends CleaningSettings {
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface CatalogRepository {
  listServices(): Promise<ServiceDefinition[]>;
  findService(code: string): Promise<ServiceDefinition | null>;
  /**
   * Définition d'une version donnée de la grille (champs, options, fréquences de cette version),
   * pour lire une demande avec la version utilisée par son calcul (ADR-037) ; null si inconnue.
   */
  findServiceVersion(code: string, version: number): Promise<ServiceDefinition | null>;
  /**
   * Crée ou remplace la prestation complète (champs, options, grille) : une nouvelle version
   * datée, avec son auteur (ADR-033).
   */
  saveService(definition: NewServiceVersion, changes: Changes): Promise<ServiceDefinition>;
  getSettings(): Promise<StoredSettings>;
  saveSettings(settings: CleaningSettings, changes: Changes): Promise<StoredSettings>;
  /** Zones desservies, actives et désactivées, par nom de commune. */
  listZones(): Promise<Zone[]>;
  /** Crée ou modifie la zone (clé = commune normalisée). */
  saveZone(zone: Zone, changes: Changes): Promise<Zone>;
  /** Types de lieu du parcours client (ADR-034), actifs et désactivés. */
  listPlaceTypes(): Promise<PlaceType[]>;
  /** Crée ou modifie le type de lieu (clé = code). */
  savePlaceType(placeType: PlaceType, changes: Changes): Promise<PlaceType>;
}

/** Groupe et ses demandes, dans l'ordre des prestations envoyées (ADR-034). */
export interface QuoteRequestGroupView {
  group: QuoteRequestGroup;
  requests: QuoteRequest[];
}

/** Opérations de groupe idempotentes (ADR-035). */
export type GroupOperation =
  | 'visit.scheduled'
  | 'visit.completed'
  | 'group.rejected'
  | 'group.cancelled'
  | 'quotes.sent'
  | 'quotes.accepted'
  | 'interventions.scheduled';

/** Résultat d'une opération de groupe, gardé pour la rejouer à l'identique. */
export interface GroupOutcome {
  groupId: string;
  /** Demandes (ou missions, pour la planification) modifiées. */
  affectedIds: string[];
  skippedRequests: SkippedRequest[];
  skippedMissions: SkippedMission[];
  groupVisitId: string | null;
  missionIds: string[];
}

/** Trace d'une opération de groupe : (auteur, opération, clé) unique. */
export interface GroupOperationRecord {
  actorId: string;
  operation: GroupOperation;
  idempotencyKey: string;
  outcome: GroupOutcome;
}

/**
 * Écriture d'une opération de groupe dans une seule transaction (ADR-035) : demandes et missions
 * modifiées (contrôle de version de chacune), missions créées, événements et traces, et la trace
 * d'idempotence. Une version changée annule tout (`conflict`) ; une clé déjà enregistrée par un
 * appel concurrent aussi (`replayed`).
 */
export interface GroupWrite {
  requests: QuoteRequest[];
  missions?: Mission[];
  newMissions?: { mission: Mission; acceptanceKey: string }[];
  changes: Changes;
  operation?: GroupOperationRecord | null;
  /** Acceptation : état de l'organisation lu sous verrou, comme l'acceptation seule (ADR-030). */
  organizationId?: string | null;
}

export type GroupWriteOutcome = 'saved' | 'conflict' | 'replayed' | 'organization_suspended';

/** Filtres cumulables de la liste des visites (ADR-035). */
export interface VisitFilter {
  agentId?: string;
  /** Bornes de la date prévue : incluse, exclue. */
  from?: Date;
  to?: Date;
  status?: VisitStatus;
  groupId?: string;
}

/** Une visite telle qu'elle se liste : la visite commune d'un groupe et ses demandes, ou une visite seule. */
export interface VisitEntry {
  /** Visite commune, ou identifiant de la visite seule. */
  id: string;
  requests: QuoteRequest[];
}

/** Activité d'une commune (code de zone) : demandes ouvertes, missions actives (ADR-035). */
export interface ZoneActivity {
  openRequests: number;
  activeMissions: number;
}

export type CreateResult<T> = { created: true; value: T } | { created: false; value: T };

/** Filtres cumulables de la liste des demandes. */
export interface QuoteRequestFilter {
  customerId?: string;
  /** Contexte du client (ADR-049) : null pour ses dossiers personnels, sinon cette organisation. */
  organizationId?: string | null;
  status?: RequestStatus;
  /** Code de zone : commune normalisée (zoneCode), comparée à celle enregistrée avec la demande. */
  communeCode?: string;
  customerKind?: CustomerKind;
  /** Parcours par lieu (ADR-034) : groupe, type de lieu, prestation. */
  groupId?: string;
  placeType?: string;
  serviceCode?: string;
}

export interface QuoteRequestRepository {
  /**
   * Groupe de demandes (ADR-034) : le groupe et toutes ses demandes, avec leurs événements et
   * traces, dans une seule transaction. Idempotent par (client, clé) : un second appel renvoie le
   * groupe déjà créé, sans rien écrire.
   */
  createGroup(
    group: QuoteRequestGroup,
    requests: QuoteRequest[],
    idempotencyKey: string,
    changes: Changes,
  ): Promise<CreateResult<QuoteRequestGroupView>>;
  findGroupByIdempotencyKey(
    customerId: string,
    idempotencyKey: string,
  ): Promise<QuoteRequestGroupView | null>;
  findGroup(groupId: string): Promise<QuoteRequestGroupView | null>;
  /** Nombre de demandes de chacun de ces groupes (absent : groupe inconnu). */
  groupSizes(groupIds: readonly string[]): Promise<Map<string, number>>;
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
  /**
   * Envois ouverts du client (ADR-035) : chaque demande seule et chaque groupe comptent pour 1 ;
   * ouverte = reçue, visite planifiée ou devis envoyé encore valide ; un groupe est ouvert tant
   * qu'une de ses demandes l'est.
   */
  countOpen(customerId: string, now: Date): Promise<number>;
  /**
   * Demandes ouvertes du client (reçue, visite planifiée, devis envoyé encore valide), une par
   * demande : elles bloquent la suppression de son compte (UC-ID-11, ADR-036).
   */
  openForCustomer(customerId: string, now: Date): Promise<{ id: string }[]>;
  /** Opération de groupe déjà faite avec cette clé par cet auteur, ou null (ADR-035). */
  findGroupOperation(
    actorId: string,
    operation: GroupOperation,
    idempotencyKey: string,
  ): Promise<GroupOperationRecord | null>;
  saveGroup(write: GroupWrite): Promise<GroupWriteOutcome>;
  /**
   * Visites (ADR-035), les plus récentes d'abord (curseur : identifiant de la visite commune ou de
   * la visite seule) ; une visite commune est une seule entrée avec toutes ses demandes.
   */
  listVisits(filter: VisitFilter, page: PageRequest): Promise<PageResult<VisitEntry>>;
  /** Demandes ouvertes et missions actives par code de commune (ADR-035). */
  zoneActivity(now: Date): Promise<Map<string, ZoneActivity>>;
  /**
   * Efface coordonnées, précision, repère et adresse géocodée des demandes et missions clôturées
   * avant `cutoff` (ADR-035), par lots ; l'adresse qui n'est que le repère est vidée. Idempotent :
   * une ligne déjà effacée n'est plus touchée.
   */
  purgeLocations(cutoff: Date, batchSize: number): Promise<{ requests: number; missions: number }>;
  /**
   * Compte client anonymisé (identity.user.deleted) : même effacement pour toutes ses demandes et
   * missions, inbox dans la même transaction.
   */
  eraseCustomerLocations(
    customerId: string,
    inbox: { eventId: string; consumer: string },
  ): Promise<'processed' | 'duplicate'>;
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
  /** Échéances (ADR-053) : devis envoyés dont la validité est dépassée, les plus anciens d'abord. */
  listQuotesToExpire(now: Date, limit: number): Promise<QuoteRequest[]>;
  /**
   * Devis envoyés encore valides qui expirent au plus tard à `until`, dont le devis en cours n'a pas
   * encore eu son rappel (ADR-053), les plus proches de l'expiration d'abord.
   */
  listQuotesToRemind(now: Date, until: Date, limit: number): Promise<QuoteRequest[]>;
  /**
   * Marque le rappel de chaque devis cité, s'il est toujours le devis en cours et sans rappel, puis
   * écrit les changements construits avec les demandes marquées, dans la même transaction : un
   * rappel n'est jamais publié deux fois. Renvoie les demandes marquées.
   */
  recordQuoteReminders(
    reminders: readonly { requestId: string; quoteId: string }[],
    changes: (remindedRequestIds: string[]) => Changes,
  ): Promise<string[]>;
  /** Visites encore planifiées de demandes closes (refusées, annulées, déclinées, expirées). */
  listStaleVisits(limit: number): Promise<QuoteRequest[]>;
}

export interface MissionFilter {
  customerId?: string;
  /** Contexte du client (ADR-049) : null pour ses dossiers personnels, sinon cette organisation. */
  organizationId?: string | null;
  agentId?: string;
  status?: MissionStatus;
  /** Groupe de la demande d'origine et prestation (ADR-034). */
  groupId?: string;
  serviceCode?: string;
}

/** Résultat d'une planification en lot (ADR-052), gardé pour la rejouer à l'identique. */
export interface InterventionBatchOutcome {
  missionId: string;
  interventionIds: string[];
  /** Dates planifiées, dans l'ordre. */
  scheduledDates: string[];
  /** Dates sautées pour conflit d'agenda (skipConflicts), avec leurs agents ; vide sinon. */
  skipped: BatchConflict[];
}

/** Plan d'une planification en lot, construit sous le verrou des agents. */
export type InterventionBatchPlan =
  { conflicts: BatchConflict[] } | { mission: Mission; changes: Changes; outcome: InterventionBatchOutcome };

export type InterventionBatchResult =
  | { status: 'saved'; outcome: InterventionBatchOutcome }
  | { status: 'conflicts'; conflicts: BatchConflict[] }
  | { status: 'replayed' }
  | { status: 'stale' };

export interface MissionRepository {
  findById(id: string): Promise<Mission | null>;
  findByInterventionId(interventionId: string): Promise<Mission | null>;
  list(filter: MissionFilter, page: PageRequest): Promise<PageResult<Mission>>;
  /** Enregistre la mission et ses passages si sa version n'a pas changé ; sinon false. */
  save(mission: Mission, changes: Changes): Promise<boolean>;
  /**
   * Effet d'un événement reçu : inbox (événement, consommateur) et mission enregistrés dans la même
   * transaction. Événement déjà traité : `duplicate`, rien n'est écrit ; version changée depuis la
   * lecture : `conflict`, rien n'est écrit (le message est retraité).
   */
  saveFromEvent(
    mission: Mission,
    changes: Changes,
    inbox: { eventId: string; consumer: string },
  ): Promise<'saved' | 'duplicate' | 'conflict'>;
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
  /** Planification en lot déjà faite avec cette clé pour la mission (ADR-052), sinon null. */
  findInterventionBatch(missionId: string, idempotencyKey: string): Promise<InterventionBatchOutcome | null>;
  /**
   * Planification en lot (ADR-052), dans une transaction : verrouille les agents, lit leurs périodes
   * occupées, laisse `plan` choisir les passages ; s'il en renvoie, enregistre la trace d'idempotence
   * (clé déjà prise par un appel concurrent : `replayed`), la mission (version changée : `stale`), les
   * événements et les traces. Sinon, rien n'est écrit (`conflicts`).
   */
  scheduleBatch(input: {
    agentIds: string[];
    batch: { missionId: string; actorId: string; idempotencyKey: string };
    plan: (busy: BusyPeriod[]) => InterventionBatchPlan;
  }): Promise<InterventionBatchResult>;
  /** Missions de particuliers en récurrent, non terminées : surveillance des passages impayés. */
  listIndividualRecurring(): Promise<Mission[]>;
  /** Missions non terminées d'une organisation : suspension ou reprise avec elle (ADR-030). */
  listActiveForOrganization(organizationId: string): Promise<Mission[]>;
  /** Toutes les missions d'un groupe de demandes (ADR-035), les plus anciennes d'abord. */
  listForGroup(groupId: string): Promise<Mission[]>;
  /**
   * Planification commune (ADR-035) : verrouille les agents, lit leurs périodes occupées (avec le
   * groupe de chaque passage), demande les conflits ; s'il n'y en a aucun, enregistre toutes les
   * missions (contrôle de version) et la trace d'idempotence dans une transaction.
   */
  scheduleGroup(input: {
    missions: Mission[];
    agentIds: string[];
    conflicts: (busy: BusyPeriod[]) => string[];
    changes: Changes;
    operation?: GroupOperationRecord | null;
  }): Promise<{ conflicts: string[]; outcome: 'saved' | 'conflict' | 'replayed' }>;
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
  /** Compléments (ADR-053) : désactivation et réactivation d'un agent ou d'une équipe. */
  setAgentActive(agentId: string, active: boolean, changes: Changes): Promise<void>;
  /** Supprime l'indisponibilité de cet agent ; false si elle n'existe pas. */
  removeUnavailability(agentId: string, unavailabilityId: string, changes: Changes): Promise<boolean>;
  setTeamActive(teamId: string, active: boolean, changes: Changes): Promise<void>;
  /**
   * Passages actifs et visites planifiées (demande ouverte) de l'agent qui se terminent après `from`
   * (et commencent avant `to` s'il est donné) ; une visite dure `visitDurationMinutes`.
   */
  assignments(
    agentId: string,
    period: { from: Date; to: Date | null },
    visitDurationMinutes: number,
  ): Promise<Assignment[]>;
  /**
   * Périodes occupées des agents : passages actifs, indisponibilités et visites planifiées (demande
   * ouverte, hors visites données) ; une visite dure `visitDurationMinutes`.
   */
  busyPeriods(
    agentIds: readonly string[],
    options: { visitDurationMinutes: number; excludedVisitIds: readonly string[] },
  ): Promise<BusyPeriod[]>;
}

/** Fichier d'une photo de passage chez file, avec son adresse de lecture de courte durée. */
export interface StoredPhoto {
  fileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: Date;
  downloadUrl: string | null;
  downloadExpiresAt: Date | null;
}

/**
 * Photos des passages chez le service file (FileInternalService, ADR-038 ; finalité
 * cleaning_intervention_photo, objet cleaning_intervention). Les erreurs de file sont transmises
 * telles quelles (FILE_NOT_FOUND, FILE_OWNER_MISMATCH…). Rattachement idempotent pour le même passage ;
 * suppression idempotente.
 */
export interface InterventionPhotoStore {
  /** Rattache au passage un fichier envoyé par `ownerId` lui-même. */
  attach(input: { fileId: string; interventionId: string; ownerId: string }): Promise<void>;
  remove(fileId: string, interventionId: string): Promise<void>;
  /** Fichiers disponibles rattachés au passage, avec leurs adresses de lecture. */
  list(interventionId: string): Promise<StoredPhoto[]>;
}

/**
 * Géocodage inverse (ADR-034) : noms de commune possibles d'un point GPS. Null si aucun
 * fournisseur ne répond ou ne trouve de commune ; jamais d'erreur (le client choisit alors sa
 * commune). L'adaptateur ne journalise jamais les coordonnées.
 */
export interface ReverseGeocoder {
  reverse(point: GeoPoint): Promise<GeocodedPlace | null>;
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
