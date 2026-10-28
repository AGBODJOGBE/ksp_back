import { INITIAL_ZONES, type Zone, zoneCode } from '../../domain/zone';
import { type RoleClaim, runWithContext } from '@ksp/platform';
import { type Agent, type Team, type Unavailability } from '../../domain/agent';
import { DEFAULT_TEAM_SIZE, type ServiceDefinition } from '../../domain/catalog';
import {
  ACTIVE_INTERVENTION_STATUSES,
  type Intervention,
  isTerminalMission,
  type Mission,
} from '../../domain/mission';
import { isOpenRequest, type QuoteRequest } from '../../domain/quote-request';
import {
  type BusyPeriod,
  DEFAULT_FIELD_DATE_POLICY,
  type FieldDatePolicy,
  slotFrom,
} from '../../domain/schedule';
import { type CleaningSettings, DEFAULT_SETTINGS } from '../../domain/settings';
import { type CleaningDeps } from '../deps';
import {
  type AgentRepository,
  type CatalogRepository,
  type Changes,
  type ContractInvoiceRepository,
  type ContractInvoiceStatus,
  type CreateResult,
  type MissionFilter,
  type MissionRepository,
  type NewPricing,
  type PeopleDirectory,
  type QuoteRequestFilter,
  type QuoteRequestRepository,
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
  async saveService(service: Omit<ServiceDefinition, 'pricing'>, pricing: NewPricing, changes: Changes) {
    const previous = this.services.get(service.code);
    const at = changes.audit[0]!.at;
    const saved: ServiceDefinition = {
      ...service,
      pricing: {
        ...pricing,
        version: (previous?.pricing.version ?? 0) + 1,
        updatedBy: changes.audit[0]!.actorId,
        updatedAt: at,
      },
    };
    this.services.set(service.code, saved);
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
      { code: zoneCode(commune), commune, active: true, updatedBy: null, updatedAt: null },
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
  /** Périodes occupées : passages actifs (hors un passage éventuel) et indisponibilités. */
  busyPeriods(excludedId: string | null): BusyPeriod[] {
    const busy: BusyPeriod[] = [...this.unavailabilities];
    for (const other of this.missions.values()) {
      for (const i of other.interventions) {
        if (i.id === excludedId || !ACTIVE_INTERVENTION_STATUSES.includes(i.status)) continue;
        for (const agentId of i.agentIds)
          busy.push({ agentId, slot: slotFrom(i.scheduledStart, i.durationMinutes) });
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

  constructor(
    private readonly recorder: Recorder,
    private readonly missions: InMemoryMissions,
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
        (!filter.customerKind || r.customerKind === filter.customerKind),
    );
    return paginate(items, page);
  }
  async countOpen(customerId: string, now: Date) {
    return [...this.requests.values()].filter((r) => r.customerId === customerId && isOpenRequest(r, now))
      .length;
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

export interface TestWorld extends CleaningDeps {
  recorder: Recorder;
  clock: FixedClock;
  catalog: InMemoryCatalog;
  requests: InMemoryRequests;
  missions: InMemoryMissions;
  agents: InMemoryAgents;
  invoices: InMemoryContractInvoices;
  people: InMemoryPeople;
  fieldDates: FieldDatePolicy;
}

export function testWorld(): TestWorld {
  const recorder = new Recorder();
  const missions = new InMemoryMissions(recorder);
  return {
    recorder,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    catalog: new InMemoryCatalog(recorder),
    requests: new InMemoryRequests(recorder, missions),
    missions,
    agents: new InMemoryAgents(recorder),
    invoices: new InMemoryContractInvoices(),
    people: new InMemoryPeople(),
    fieldDates: { ...DEFAULT_FIELD_DATE_POLICY },
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

/** Prestation de démonstration utilisée par les tests. */
export function homeCleaning(overrides: Partial<ServiceDefinition['pricing']> = {}): ServiceDefinition {
  return {
    code: 'home_cleaning',
    name: 'Nettoyage à domicile',
    description: 'Ménage complet',
    unit: 'room',
    active: true,
    pricing: {
      version: 1,
      unitPrice: 5000,
      minimumPrice: 15000,
      options: [{ code: 'windows', label: 'Vitres', price: 4000 }],
      communeCoefficients: { 'abomey-calavi': 11000 },
      defaultCoefficientBp: 10000,
      teamSize: { ...DEFAULT_TEAM_SIZE, unitsPerAgent: 3 },
      checklist: [],
      updatedBy: SUPERVISOR_ID,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      ...overrides,
    },
  };
}
