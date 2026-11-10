import { INITIAL_ZONES, type Zone, zoneCode } from '../../domain/zone';
import { AppError, type RoleClaim, runWithContext } from '@ksp/platform';
import { type Agent, type Team, type Unavailability } from '../../domain/agent';
import { type ServiceDefinition } from '../../domain/catalog';
import { homeCleaningService } from '../../domain/testing';
import {
  ACTIVE_INTERVENTION_STATUSES,
  type Intervention,
  isTerminalMission,
  type Mission,
} from '../../domain/mission';
import { DEFAULT_SCHEDULE_POLICY, type SchedulePolicy } from '../../domain/intervention-schedule';
import { type GeocodedPlace, type GeoPoint } from '../../domain/location';
import { type PlaceType } from '../../domain/place-type';
import { isOpenRequest, type QuoteRequest, type QuoteRequestGroup } from '../../domain/quote-request';
import { openSubmissions } from '../../domain/request-group';
import { withoutPosition } from '../../domain/location';
import {
  type BusyPeriod,
  DEFAULT_FIELD_DATE_POLICY,
  type FieldDatePolicy,
  slotFrom,
} from '../../domain/schedule';
import { type CleaningSettings, DEFAULT_SETTINGS } from '../../domain/settings';
import { type ServiceDefinitionInput } from '../catalog/admin-catalog.use-cases';
import { type CleaningDeps } from '../deps';
import {
  type AgentRepository,
  type CatalogRepository,
  type Changes,
  type WalletDebit,
  type WalletLedger,
  type ContractInvoiceRepository,
  type ContractInvoiceStatus,
  type CreateResult,
  type GroupOperation,
  type GroupOperationRecord,
  type GroupWrite,
  type VisitEntry,
  type VisitFilter,
  type ZoneActivity,
  type MissionFilter,
  type MissionRepository,
  type NewServiceVersion,
  type OrganizationStandingRepository,
  type PeopleDirectory,
  type QuoteRequestFilter,
  type QuoteRequestGroupView,
  type QuoteRequestRepository,
  type ReverseGeocoder,
  type StoredSettings,
} from '../ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type PageRequest, type PageResult } from '../shared/validation';

/** Doublures en mémoire des ports, pour les tests des cas d'usage. */

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-10-23T08:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
}

export class SequentialIds implements IdGenerator {
  private seq = 0;
  next(): string {
    this.seq += 1;
    return `0192f1c4-0000-7000-8000-${String(this.seq).padStart(12, '0')}`;
  }
}

/** Journal commun des écritures : événements et traces dans l'ordre. */
export class Recorder {
  readonly changes: Changes[] = [];
  record(changes: Changes): void {
    this.changes.push(changes);
  }
  get events() {
    return this.changes.flatMap((change) => change.events);
  }
  get audit() {
    return this.changes.flatMap((change) => change.audit);
  }
}

function paginate<T extends { id: string }>(items: T[], page: PageRequest): PageResult<T> {
  const sorted = [...items].sort((a, b) => b.id.localeCompare(a.id));
  const from = page.cursor ? sorted.filter((item) => item.id < page.cursor!) : sorted;
  const slice = from.slice(0, page.limit);
  return { items: slice, nextCursor: from.length > page.limit ? slice.at(-1)!.id : null };
}

export class InMemoryCatalog implements CatalogRepository {
  readonly services = new Map<string, ServiceDefinition>();
  settings: StoredSettings = { ...DEFAULT_SETTINGS, updatedBy: null, updatedAt: null };

  constructor(private readonly recorder: Recorder) {}

  async listServices() {
    return [...this.services.values()];
  }
  async findService(code: string) {
    return this.services.get(code) ?? null;
  }
  /** Versions remplacées, gardées pour la lecture d'une demande avec sa version (ADR-037). */
  readonly history: ServiceDefinition[] = [];
  async findServiceVersion(code: string, version: number) {
    const current = this.services.get(code);
    if (current?.pricing.version === version) return current;
    return (
      this.history.find((service) => service.code === code && service.pricing.version === version) ?? null
    );
  }
  async saveService(definition: NewServiceVersion, changes: Changes) {
    const previous = this.services.get(definition.code);
    if (previous) this.history.push(previous);
    const at = changes.audit[0]!.at;
    const saved: ServiceDefinition = {
      ...definition,
      pricing: {
        ...definition.pricing,
        version: (previous?.pricing.version ?? 0) + 1,
        updatedBy: changes.audit[0]!.actorId,
        updatedAt: at,
      },
    };
    this.services.set(definition.code, saved);
    this.recorder.record(changes);
    return saved;
  }
  async getSettings() {
    return this.settings;
  }
  async saveSettings(settings: CleaningSettings, changes: Changes) {
    this.settings = { ...settings, updatedBy: changes.audit[0]!.actorId, updatedAt: changes.audit[0]!.at };
    this.recorder.record(changes);
    return this.settings;
  }
  readonly zones = new Map<string, Zone>(
    INITIAL_ZONES.map((commune) => [
      zoneCode(commune),
      { code: zoneCode(commune), commune, aliases: [], active: true, updatedBy: null, updatedAt: null },
    ]),
  );
  async listZones() {
    return [...this.zones.values()].sort((a, b) => a.commune.localeCompare(b.commune));
  }
  async saveZone(zone: Zone, changes: Changes) {
    this.zones.set(zone.code, zone);
    this.recorder.record(changes);
    return zone;
  }
  readonly placeTypes = new Map<string, PlaceType>();
  async listPlaceTypes() {
    return [...this.placeTypes.values()];
  }
  async savePlaceType(placeType: PlaceType, changes: Changes) {
    this.placeTypes.set(placeType.code, placeType);
    this.recorder.record(changes);
    return placeType;
  }
}

/** Géocodeur simulé : réponse réglable, panne possible, points reçus comptés. */
export class FakeGeocoder implements ReverseGeocoder {
  readonly calls: GeoPoint[] = [];
  result: GeocodedPlace | null = {
    provider: 'nominatim',
    communes: ['Abomey-Calavi', 'Atlantique'],
    displayAddress: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
  };
  failure: Error | null = null;

  async reverse(point: GeoPoint) {
    this.calls.push(point);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

/** Type de lieu de test (Maison : ménage et vitres en option, jardin…). */
export function placeType(overrides: Partial<PlaceType> = {}): PlaceType {
  return {
    code: 'house',
    label: 'Maison',
    description: 'Maison individuelle avec ou sans cour.',
    icon: 'house',
    displayOrder: 10,
    active: true,
    serviceCodes: ['home_cleaning'],
    updatedBy: null,
    updatedAt: null,
    ...overrides,
  };
}

export class InMemoryMissions implements MissionRepository {
  readonly missions = new Map<string, Mission>();
  unavailabilities: BusyPeriod[] = [];

  constructor(private readonly recorder: Recorder) {}

  async findById(id: string) {
    return this.missions.get(id) ?? null;
  }
  async findByInterventionId(interventionId: string) {
    return (
      [...this.missions.values()].find((m) => m.interventions.some((i) => i.id === interventionId)) ?? null
    );
  }
  async list(filter: MissionFilter, page: PageRequest) {
    const items = [...this.missions.values()].filter(
      (m) =>
        (!filter.customerId || m.customerId === filter.customerId) &&
        (!filter.status || m.status === filter.status) &&
        (!filter.groupId || m.groupId === filter.groupId) &&
        (!filter.serviceCode || m.serviceCode === filter.serviceCode) &&
        (!filter.agentId || m.interventions.some((i) => i.agentIds.includes(filter.agentId!))),
    );
    return paginate(items, page);
  }
  async save(mission: Mission, changes: Changes) {
    const stored = this.missions.get(mission.id);
    if (stored && stored.version !== mission.version) return false;
    this.missions.set(mission.id, { ...mission, version: mission.version + 1 });
    this.recorder.record(changes);
    return true;
  }
  readonly processed = new Set<string>();
  async saveFromEvent(mission: Mission, changes: Changes, inbox: { eventId: string; consumer: string }) {
    const key = `${inbox.eventId}:${inbox.consumer}`;
    if (this.processed.has(key)) return 'duplicate' as const;
    if (!(await this.save(mission, changes))) return 'conflict' as const;
    this.processed.add(key);
    return 'saved' as const;
  }
  /** Périodes occupées : passages actifs (hors un passage éventuel) et indisponibilités. */
  busyPeriods(excludedId: string | null): BusyPeriod[] {
    const busy: BusyPeriod[] = [...this.unavailabilities];
    for (const other of this.missions.values()) {
      for (const i of other.interventions) {
        if (i.id === excludedId || !ACTIVE_INTERVENTION_STATUSES.includes(i.status)) continue;
        for (const agentId of i.agentIds)
          busy.push({ agentId, slot: slotFrom(i.scheduledStart, i.durationMinutes), groupId: other.groupId });
      }
    }
    return busy;
  }
  async scheduleIntervention(
    mission: Mission,
    intervention: Intervention,
    conflicts: (busy: BusyPeriod[]) => string[],
    changes: Changes,
  ) {
    const busy = this.busyPeriods(intervention.id);
    const found = conflicts(busy.filter((period) => intervention.agentIds.includes(period.agentId)));
    if (found.length) return { conflicts: found, saved: false };
    return { conflicts: [], saved: await this.save(mission, changes) };
  }
  async pendingForCustomer(customerId: string) {
    return [...this.missions.values()]
      .filter((m) => m.customerId === customerId && !isTerminalMission(m.status))
      .map((m) => ({ id: m.id, status: m.status }));
  }
  async saveWithAgenda(
    agentIds: string[],
    plan: (busy: BusyPeriod[]) => { mission: Mission; changes: Changes },
  ) {
    const busy = this.busyPeriods(null).filter((period) => agentIds.includes(period.agentId));
    const { mission, changes } = plan(busy);
    return this.save(mission, changes);
  }
  async listIndividualRecurring() {
    return [...this.missions.values()].filter(
      (m) => m.organizationId === null && m.recurrence !== null && !isTerminalMission(m.status),
    );
  }
  async listActiveForOrganization(organizationId: string) {
    return [...this.missions.values()].filter(
      (m) => m.organizationId === organizationId && !isTerminalMission(m.status),
    );
  }
  async listForGroup(groupId: string) {
    return [...this.missions.values()]
      .filter((m) => m.groupId === groupId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  /** Opérations de groupe enregistrées (partagées avec les demandes). */
  readonly operations = new Map<string, GroupOperationRecord>();
  async scheduleGroup(input: {
    missions: Mission[];
    agentIds: string[];
    conflicts: (busy: BusyPeriod[]) => string[];
    changes: Changes;
    operation?: GroupOperationRecord | null;
  }) {
    const busy = this.busyPeriods(null).filter((period) => input.agentIds.includes(period.agentId));
    const found = input.conflicts(busy);
    if (found.length) return { conflicts: found, outcome: 'conflict' as const };
    const op = input.operation;
    const opKey = op ? `${op.actorId}:${op.operation}:${op.idempotencyKey}` : null;
    if (opKey && this.operations.has(opKey)) return { conflicts: [], outcome: 'replayed' as const };
    if (input.missions.some((m) => this.missions.get(m.id)?.version !== m.version)) {
      return { conflicts: [], outcome: 'conflict' as const };
    }
    for (const m of input.missions) this.missions.set(m.id, { ...m, version: m.version + 1 });
    if (opKey) this.operations.set(opKey, op!);
    this.recorder.record(input.changes);
    return { conflicts: [], outcome: 'saved' as const };
  }
}

/** État des organisations : inbox par (événement, consommateur), décision la plus récente gardée. */
export class InMemoryOrganizationStandings implements OrganizationStandingRepository {
  readonly processed = new Set<string>();
  readonly standings = new Map<string, { suspended: boolean; changedAt: Date }>();

  async record(input: {
    eventId: string;
    consumer: string;
    organizationId: string;
    suspended: boolean;
    at: Date;
  }) {
    const key = `${input.eventId}/${input.consumer}`;
    if (this.processed.has(key)) return 'duplicate' as const;
    this.processed.add(key);
    const current = this.standings.get(input.organizationId);
    const newer = !current || current.changedAt < input.at;
    // Même date : la suspension l'emporte (ADR-030).
    const tie = current && current.changedAt.getTime() === input.at.getTime() && input.suspended;
    if (newer || tie) {
      this.standings.set(input.organizationId, { suspended: input.suspended, changedAt: input.at });
    }
    return 'processed' as const;
  }
  async isSuspended(organizationId: string) {
    return this.standings.get(organizationId)?.suspended ?? false;
  }
}

/** Factures de contrat : inbox par (événement, consommateur), une facture payée le reste. */
export class InMemoryContractInvoices implements ContractInvoiceRepository {
  readonly processed = new Set<string>();
  readonly invoices = new Map<string, { missionId: string; status: ContractInvoiceStatus }>();

  async record(input: {
    eventId: string;
    consumer: string;
    invoiceId: string;
    missionId: string;
    status: ContractInvoiceStatus;
  }) {
    const key = `${input.eventId}/${input.consumer}`;
    if (this.processed.has(key)) return 'duplicate' as const;
    this.processed.add(key);
    if (this.invoices.get(input.invoiceId)?.status !== 'paid') {
      this.invoices.set(input.invoiceId, { missionId: input.missionId, status: input.status });
    }
    return 'processed' as const;
  }
  async countOverdue(missionId: string) {
    return [...this.invoices.values()].filter((i) => i.missionId === missionId && i.status === 'overdue')
      .length;
  }
}

export class InMemoryRequests implements QuoteRequestRepository {
  readonly requests = new Map<string, QuoteRequest>();
  readonly keys = new Map<string, string>();
  readonly acceptances = new Map<string, string>();
  readonly groups = new Map<string, QuoteRequestGroup>();
  readonly groupKeys = new Map<string, string>();
  /** Simule l'échec de la transaction du groupe après la première demande : rien n'est gardé. */
  failGroupWrites = false;

  constructor(
    private readonly recorder: Recorder,
    private readonly missions: InMemoryMissions,
    private readonly organizations: InMemoryOrganizationStandings,
  ) {}

  async create(
    request: QuoteRequest,
    idempotencyKey: string,
    changes: Changes,
  ): Promise<CreateResult<QuoteRequest>> {
    const key = `${request.customerId}:${idempotencyKey}`;
    const existing = this.keys.get(key);
    if (existing) return { created: false, value: this.requests.get(existing)! };
    this.keys.set(key, request.id);
    this.requests.set(request.id, request);
    this.recorder.record(changes);
    return { created: true, value: request };
  }
  async findByIdempotencyKey(customerId: string, idempotencyKey: string) {
    const id = this.keys.get(`${customerId}:${idempotencyKey}`);
    return id ? this.requests.get(id)! : null;
  }
  async createGroup(
    group: QuoteRequestGroup,
    requests: QuoteRequest[],
    idempotencyKey: string,
    changes: Changes,
  ): Promise<CreateResult<QuoteRequestGroupView>> {
    const key = `${group.customerId}:${idempotencyKey}`;
    const existing = this.groupKeys.get(key);
    if (existing) return { created: false, value: (await this.findGroup(existing))! };
    // Une seule transaction : tout ou rien.
    if (this.failGroupWrites) throw new Error('transaction annulée');
    this.groupKeys.set(key, group.id);
    this.groups.set(group.id, group);
    for (const request of requests) this.requests.set(request.id, request);
    this.recorder.record(changes);
    return { created: true, value: { group, requests } };
  }
  async findGroupByIdempotencyKey(customerId: string, idempotencyKey: string) {
    const id = this.groupKeys.get(`${customerId}:${idempotencyKey}`);
    return id ? this.findGroup(id) : null;
  }
  async groupSizes(groupIds: readonly string[]) {
    const sizes = new Map<string, number>();
    for (const request of this.requests.values()) {
      if (request.groupId && groupIds.includes(request.groupId))
        sizes.set(request.groupId, (sizes.get(request.groupId) ?? 0) + 1);
    }
    return sizes;
  }
  async findGroup(groupId: string) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    const requests = [...this.requests.values()]
      .filter((request) => request.groupId === groupId)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { group, requests };
  }
  async findById(id: string) {
    return this.requests.get(id) ?? null;
  }
  async findAcceptance(requestId: string, idempotencyKey: string) {
    return this.acceptances.get(`${requestId}:${idempotencyKey}`) ?? null;
  }
  async findByVisitId(visitId: string) {
    return [...this.requests.values()].find((r) => r.visit?.id === visitId) ?? null;
  }
  async list(filter: QuoteRequestFilter, page: PageRequest) {
    const items = [...this.requests.values()].filter(
      (r) =>
        (!filter.customerId || r.customerId === filter.customerId) &&
        (!filter.status || r.status === filter.status) &&
        (!filter.communeCode || zoneCode(r.commune) === filter.communeCode) &&
        (!filter.customerKind || r.customerKind === filter.customerKind) &&
        (!filter.groupId || r.groupId === filter.groupId) &&
        (!filter.placeType || r.placeType === filter.placeType) &&
        (!filter.serviceCode || r.serviceCode === filter.serviceCode),
    );
    return paginate(items, page);
  }
  async countOpen(customerId: string, now: Date) {
    return openSubmissions(
      [...this.requests.values()].filter((r) => r.customerId === customerId),
      now,
    );
  }
  async openForCustomer(customerId: string, now: Date) {
    return [...this.requests.values()]
      .filter((r) => r.customerId === customerId && isOpenRequest(r, now))
      .map((r) => ({ id: r.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async findGroupOperation(actorId: string, operation: GroupOperation, idempotencyKey: string) {
    return this.missions.operations.get(`${actorId}:${operation}:${idempotencyKey}`) ?? null;
  }
  async saveGroup(write: GroupWrite) {
    const op = write.operation;
    const opKey = op ? `${op.actorId}:${op.operation}:${op.idempotencyKey}` : null;
    if (opKey && this.missions.operations.has(opKey)) return 'replayed' as const;
    if (write.organizationId && (await this.organizations.isSuspended(write.organizationId))) {
      return 'organization_suspended' as const;
    }
    if (this.failGroupWrites) throw new Error('transaction annulée');
    if (write.requests.some((r) => this.requests.get(r.id)?.version !== r.version))
      return 'conflict' as const;
    if ((write.missions ?? []).some((m) => this.missions.missions.get(m.id)?.version !== m.version)) {
      return 'conflict' as const;
    }
    for (const r of write.requests) this.requests.set(r.id, { ...r, version: r.version + 1 });
    for (const m of write.missions ?? []) this.missions.missions.set(m.id, { ...m, version: m.version + 1 });
    for (const { mission } of write.newMissions ?? []) this.missions.missions.set(mission.id, mission);
    if (opKey) this.missions.operations.set(opKey, op!);
    this.recorder.record(write.changes);
    return 'saved' as const;
  }
  async listVisits(filter: VisitFilter, page: PageRequest) {
    const entries = new Map<string, QuoteRequest[]>();
    for (const r of this.requests.values()) {
      const v = r.visit;
      if (!v) continue;
      if (filter.agentId && v.agentId !== filter.agentId) continue;
      if (filter.status && v.status !== filter.status) continue;
      if (filter.from && v.scheduledAt < filter.from) continue;
      if (filter.to && v.scheduledAt >= filter.to) continue;
      if (filter.groupId && r.groupId !== filter.groupId) continue;
      const key = v.groupVisitId ?? v.id;
      entries.set(key, [...(entries.get(key) ?? []), r]);
    }
    return paginate(
      [...entries].map(([id, requests]): VisitEntry => ({ id, requests })),
      page,
    );
  }
  async zoneActivity(now: Date) {
    const activity = new Map<string, ZoneActivity>();
    const add = (code: string, key: keyof ZoneActivity) => {
      const current = activity.get(code) ?? { openRequests: 0, activeMissions: 0 };
      activity.set(code, { ...current, [key]: current[key] + 1 });
    };
    for (const r of this.requests.values())
      if (isOpenRequest(r, now)) add(zoneCode(r.commune), 'openRequests');
    for (const m of this.missions.missions.values())
      if (!isTerminalMission(m.status)) add(zoneCode(m.commune), 'activeMissions');
    return activity;
  }
  async purgeLocations(cutoff: Date) {
    const closed = ['accepted', 'declined', 'rejected', 'expired', 'cancelled'];
    let requests = 0;
    let missions = 0;
    for (const r of this.requests.values()) {
      const hasPlace = r.location || r.landmark || r.geocodedAddress;
      if (!hasPlace || !closed.includes(r.status) || r.updatedAt >= cutoff) continue;
      this.requests.set(r.id, { ...withoutPosition(r), geocodedAddress: null, version: r.version + 1 });
      requests += 1;
    }
    for (const m of this.missions.missions.values()) {
      if (!(m.location || m.landmark) || !isTerminalMission(m.status) || m.updatedAt >= cutoff) continue;
      this.missions.missions.set(m.id, { ...withoutPosition(m), version: m.version + 1 });
      missions += 1;
    }
    return { requests, missions };
  }
  readonly processedErasures = new Set<string>();
  async eraseCustomerLocations(customerId: string, inbox: { eventId: string; consumer: string }) {
    const key = `${inbox.eventId}/${inbox.consumer}`;
    if (this.processedErasures.has(key)) return 'duplicate' as const;
    this.processedErasures.add(key);
    for (const r of this.requests.values())
      if (r.customerId === customerId)
        this.requests.set(r.id, { ...withoutPosition(r), geocodedAddress: null, version: r.version + 1 });
    for (const m of this.missions.missions.values())
      if (m.customerId === customerId)
        this.missions.missions.set(m.id, { ...withoutPosition(m), version: m.version + 1 });
    return 'processed' as const;
  }
  async save(request: QuoteRequest, changes: Changes) {
    if (this.requests.get(request.id)?.version !== request.version) return false;
    this.requests.set(request.id, { ...request, version: request.version + 1 });
    this.recorder.record(changes);
    return true;
  }
  async accept(request: QuoteRequest, mission: Mission, idempotencyKey: string, changes: Changes) {
    const key = `${request.id}:${idempotencyKey}`;
    const replay = this.acceptances.get(key);
    if (replay) return { status: 'replayed' as const, missionId: replay };
    if (mission.organizationId && (await this.organizations.isSuspended(mission.organizationId))) {
      return { status: 'organization_suspended' as const };
    }
    if (this.requests.get(request.id)?.version !== request.version) return { status: 'conflict' as const };
    this.requests.set(request.id, { ...request, version: request.version + 1 });
    this.missions.missions.set(mission.id, mission);
    this.acceptances.set(key, mission.id);
    this.recorder.record(changes);
    return { status: 'created' as const };
  }
}

export class InMemoryAgents implements AgentRepository {
  readonly agents = new Map<string, Agent>();
  readonly teams = new Map<string, Team>();

  constructor(private readonly recorder: Recorder) {}

  async listAgents() {
    return [...this.agents.values()];
  }
  async findAgents(agentIds: string[]) {
    return agentIds.flatMap((id) => this.agents.get(id) ?? []);
  }
  async register(agent: Agent, changes: Changes) {
    if (this.agents.has(agent.agentId)) return false;
    this.agents.set(agent.agentId, agent);
    this.recorder.record(changes);
    return true;
  }
  async addUnavailability(agentId: string, unavailability: Unavailability, changes: Changes) {
    const agent = this.agents.get(agentId)!;
    this.agents.set(agentId, { ...agent, unavailabilities: [...agent.unavailabilities, unavailability] });
    this.recorder.record(changes);
  }
  async listTeams() {
    return [...this.teams.values()];
  }
  async findTeam(teamId: string) {
    return this.teams.get(teamId) ?? null;
  }
  async saveTeam(team: Team, changes: Changes) {
    this.teams.set(team.id, team);
    this.recorder.record(changes);
  }
}

/** Annuaire d'identity simulé : noms connus, appels comptés, panne possible (lecture au mieux). */
export class InMemoryPeople implements PeopleDirectory {
  readonly users = new Map<string, string>();
  readonly organizations = new Map<string, string>();
  readonly calls: { kind: 'users' | 'organizations'; ids: string[] }[] = [];
  /** Simule identity indisponible : l'adaptateur réel rend alors des noms absents. */
  down = false;

  async userNames(userIds: readonly string[]) {
    this.calls.push({ kind: 'users', ids: [...userIds] });
    if (this.down) return new Map<string, string>();
    return new Map(userIds.flatMap((id) => (this.users.has(id) ? [[id, this.users.get(id)!] as const] : [])));
  }
  async organizationNames(organizationIds: readonly string[]) {
    this.calls.push({ kind: 'organizations', ids: [...organizationIds] });
    if (this.down) return new Map<string, string>();
    return new Map(
      organizationIds.flatMap((id) =>
        this.organizations.has(id) ? [[id, this.organizations.get(id)!] as const] : [],
      ),
    );
  }
}

/**
 * Portefeuille simulé (ADR-046) : solde par client, débits idempotents par clé, remboursements
 * uniques ; solde insuffisant refusé comme wallet (WALLET_INSUFFICIENT_FUNDS, montant manquant).
 */
export class FakeWallet implements WalletLedger {
  readonly balances = new Map<string, number>();
  readonly debits = new Map<string, { transactionId: string; amount: number; refunded: boolean }>();
  readonly refunds: string[] = [];
  private n = 0;

  async debit(input: Parameters<WalletLedger['debit']>[0]): Promise<WalletDebit> {
    const known = this.debits.get(input.idempotencyKey);
    if (known) return { transactionId: known.transactionId, amount: known.amount, created: false };
    const balance = this.balances.get(input.holder.id) ?? 0;
    if (balance < input.amount) {
      throw AppError.precondition('WALLET_INSUFFICIENT_FUNDS', 'Solde du portefeuille insuffisant.', {
        missing: { amount: input.amount - balance, currency: 'XOF' },
      });
    }
    this.balances.set(input.holder.id, balance - input.amount);
    this.n += 1;
    const transactionId = `0192f1c4-0000-7000-d000-${String(this.n).padStart(12, '0')}`;
    this.debits.set(input.idempotencyKey, { transactionId, amount: input.amount, refunded: false });
    return { transactionId, amount: input.amount, created: true };
  }

  async refund(input: { transactionId: string; reason: string }): Promise<void> {
    this.refunds.push(input.transactionId);
  }
}

export interface TestWorld extends CleaningDeps {
  recorder: Recorder;
  wallet: FakeWallet;
  clock: FixedClock;
  catalog: InMemoryCatalog;
  requests: InMemoryRequests;
  missions: InMemoryMissions;
  agents: InMemoryAgents;
  invoices: InMemoryContractInvoices;
  organizations: InMemoryOrganizationStandings;
  people: InMemoryPeople;
  geocoder: FakeGeocoder;
  fieldDates: FieldDatePolicy;
  schedules: SchedulePolicy;
}

export function testWorld(): TestWorld {
  const recorder = new Recorder();
  const missions = new InMemoryMissions(recorder);
  const organizations = new InMemoryOrganizationStandings();
  return {
    recorder,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    catalog: new InMemoryCatalog(recorder),
    requests: new InMemoryRequests(recorder, missions, organizations),
    missions,
    agents: new InMemoryAgents(recorder),
    invoices: new InMemoryContractInvoices(),
    organizations,
    people: new InMemoryPeople(),
    wallet: new FakeWallet(),
    geocoder: new FakeGeocoder(),
    fieldDates: { ...DEFAULT_FIELD_DATE_POLICY },
    schedules: { ...DEFAULT_SCHEDULE_POLICY },
  };
}

export const CUSTOMER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
export const OTHER_CUSTOMER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99';
export const ORGANIZATION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000';
export const SUPERVISOR_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001';
export const AGENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002';
export const OTHER_AGENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0003';

/** Exécute `fn` au nom d'un utilisateur, comme si la gateway avait transmis son contexte. */
export function as<T>(
  userId: string,
  fn: () => T,
  options: { roles?: string[]; mfa?: boolean; activeContext?: string; nowSeconds?: number } = {},
): T {
  const roles: RoleClaim[] = (options.roles ?? ['customer']).map((role) => ({ role, scopeType: 'global' }));
  return runWithContext(
    {
      correlationId: 'c-test',
      user: {
        userId,
        sessionId: 's-test',
        activeContext: options.activeContext ?? 'personal',
        roles,
        mfa: options.mfa ?? false,
        authTime: options.nowSeconds ?? Math.floor(Date.now() / 1000),
      },
    },
    fn,
  );
}

export const asCustomer = <T>(fn: () => T, userId = CUSTOMER_ID) => as(userId, fn);
export const asSupervisor = <T>(fn: () => T) =>
  as(SUPERVISOR_ID, fn, { roles: ['cleaning_supervisor'], mfa: true });
export const asAdmin = <T>(fn: () => T) => as(SUPERVISOR_ID, fn, { roles: ['cleaning_admin'], mfa: true });
export const SUPER_ADMIN_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0009';
export const asSuperAdmin = <T>(fn: () => T, mfa = true) =>
  as(SUPER_ADMIN_ID, fn, { roles: ['super_admin'], mfa });
export const asAgent = <T>(fn: () => T, agentId = AGENT_ID) =>
  as(agentId, fn, { roles: ['cleaning_agent'], mfa: true });

/** Prestation de démonstration utilisée par les tests (grille complète, version 3). */
export function homeCleaning(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return homeCleaningService({ ...overrides });
}

/** Définition saisie au back-office (nouveau format) reprenant une prestation du modèle. */
export function definitionInput(service: ServiceDefinition): ServiceDefinitionInput {
  return {
    name: service.name,
    description: service.description,
    active: service.active,
    fields: service.fields,
    options: service.options,
    pricing: {
      minimumPrice: service.pricing.minimumPrice,
      communeCoefficients: Object.entries(service.pricing.communeCoefficients).map(
        ([commune, coefficientBp]) => ({
          commune,
          coefficientBp,
        }),
      ),
      defaultCoefficientBp: service.pricing.defaultCoefficientBp,
      frequencies: service.pricing.frequencies,
      teamSize: service.pricing.teamSize,
      checklist: service.pricing.checklist,
    },
  };
}
