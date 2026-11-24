import { runWithContext } from '@ksp/platform';
import { validatedSkillCodes } from '../../domain/agents/agent';
import { type AgendaEntry, type TargetRef, travelFromMatrix } from '../../domain/planning/agenda';
import { IN_FORCE_STATUSES } from '../../domain/planning/assignment-status';
import { overlaps } from '../../domain/planning/time';
import {
  type AgentAccount,
  type AgentAccounts,
  AgentAlreadyRegisteredError,
  type AgentRecord,
  type AgentRoles,
  ConcurrentUpdateError,
  type InvitationRecord,
  type InvitationSender,
  type PhoneFingerprints,
  type PlanningSettings,
  type TeamRecord,
} from '../agents/agent.ports';
import { type AgentDeps } from '../deps';
import { type AuditEntry, type FieldCipher, type OutboxMessage } from '../ports';
import {
  type AgentAssignmentRecord,
  type AssignmentRecord,
  type IdempotencyRecord,
  type NewAssignment,
  type PlanningRepository,
  type PlanningTx,
  ScheduleOverlapError,
  type TargetRecord,
} from '../planning/planning.ports';

/** Faux en mémoire du dépôt de la planification, pour les tests des cas d'usage. */

type StoredAssignment = AssignmentRecord & {
  occupiedUntil: Date;
  removedBy?: string | null;
  removalReason?: string;
};
type StoredTarget = Omit<TargetRecord, 'assignments' | 'assignedAgents'>;
interface StoredTeam {
  id: string;
  name: string;
  leadAgentId: string;
  active: boolean;
  createdAt: Date;
  memberIds: string[];
}

interface State {
  agents: Map<string, AgentRecord>;
  teams: Map<string, StoredTeam>;
  assignments: Map<string, StoredAssignment>;
  targets: Map<string, StoredTarget>;
  skills: Map<string, { name: string; active: boolean }>;
  zones: Set<string>;
  idempotency: Map<string, IdempotencyRecord>;
  /** Piste A : invitations, avec l'empreinte du numéro. */
  invitations: Map<string, InvitationRecord & { phoneFingerprint: string }>;
  events: OutboxMessage[];
  audit: AuditEntry[];
}

const key = (ref: TargetRef) => `${ref.kind}:${ref.id}`;
const inForce = (a: { status: string }) => (IN_FORCE_STATUSES as readonly string[]).includes(a.status);

export const SETTINGS: PlanningSettings = {
  defaultTravelMinutes: 30,
  assignmentResponseHours: 12,
  defaultMaxHoursDay: 8,
  defaultMaxHoursWeek: 48,
};

export class InMemoryPlanning implements PlanningRepository {
  state: State = {
    agents: new Map(),
    teams: new Map(),
    assignments: new Map(),
    targets: new Map(),
    skills: new Map([
      ['interior', { name: 'Intérieur', active: true }],
      ['windows', { name: 'Vitres', active: true }],
    ]),
    zones: new Set(['cotonou', 'porto-novo']),
    idempotency: new Map(),
    invitations: new Map(),
    events: [],
    audit: [],
  };
  settingsValue: PlanningSettings = { ...SETTINGS };
  /** Nombre de transactions ouvertes, et verrous posés. */
  locks: string[][] = [];

  get events() {
    return this.state.events;
  }
  get audit() {
    return this.state.audit;
  }

  addAgent(agent: AgentRecord): AgentRecord {
    this.state.agents.set(agent.id, agent);
    return agent;
  }
  addTarget(target: StoredTarget): void {
    this.state.targets.set(key(target.target), target);
  }
  addAssignment(assignment: StoredAssignment): void {
    this.state.assignments.set(assignment.id, assignment);
  }
  addTeam(team: StoredTeam): void {
    this.state.teams.set(team.id, team);
  }
  storedAssignment(id: string): StoredAssignment | undefined {
    return this.state.assignments.get(id);
  }

  async transaction<T>(work: (tx: PlanningTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.tx());
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async idempotency(ref: { actorId: string; operation: string; key: string }) {
    return this.state.idempotency.get(`${ref.actorId}|${ref.operation}|${ref.key}`) ?? null;
  }

  async agentById(id: string) {
    return this.state.agents.get(id) ?? null;
  }
  /** Piste A : invitation rendue sans son empreinte, comme le dépôt. */
  async invitationById(id: string): Promise<InvitationRecord | null> {
    const stored = this.state.invitations.get(id);
    if (!stored) return null;
    const { phoneFingerprint: _fingerprint, ...invitation } = stored;
    return invitation;
  }
  async agentByUserId(userId: string) {
    return [...this.state.agents.values()].find((a) => a.userId === userId) ?? null;
  }
  async agentsByIds(ids: readonly string[]) {
    return [...this.state.agents.values()].filter((a) => ids.includes(a.id));
  }
  async teamById(id: string): Promise<TeamRecord | null> {
    const team = this.state.teams.get(id);
    if (!team) return null;
    return {
      id: team.id,
      name: team.name,
      leadAgentId: team.leadAgentId,
      active: team.active,
      createdAt: team.createdAt,
      members: team.memberIds.map((agentId) => {
        const agent = this.state.agents.get(agentId)!;
        return { agentId, displayName: agent.displayName, status: agent.status };
      }),
    };
  }
  async agendas(agentIds: readonly string[], window: { start: Date; end: Date | null }) {
    const result = new Map<string, AgendaEntry[]>(agentIds.map((id) => [id, []]));
    for (const a of this.state.assignments.values()) {
      if (!agentIds.includes(a.agentId)) continue;
      if (a.occupiedUntil <= window.start || (window.end && a.occupiedFrom >= window.end)) continue;
      result.get(a.agentId)!.push({
        assignmentId: a.id,
        target: a.target,
        placeId: a.placeId,
        start: a.start,
        end: a.occupiedUntil,
        travelMinutes: a.travelMinutes,
        status: a.status,
        respondBefore: a.respondBefore,
      });
    }
    return result;
  }
  async targets(refs: readonly TargetRef[]): Promise<TargetRecord[]> {
    return refs.flatMap((ref) => {
      const target = this.state.targets.get(key(ref));
      if (!target) return [];
      const assignments = [...this.state.assignments.values()].filter(
        (a) => key(a.target) === key(ref) && inForce(a),
      );
      return [
        {
          ...target,
          assignments,
          assignedAgents: assignments.map((a) => ({
            agentId: a.agentId,
            isLead: a.isLead,
            validatedSkills: [...validatedSkillCodes(this.state.agents.get(a.agentId)?.skills ?? [])],
          })),
        },
      ];
    });
  }
  async assignment(id: string) {
    return this.state.assignments.get(id) ?? null;
  }
  async settings() {
    return this.settingsValue;
  }
  async listAgents() {
    const items = [...this.state.agents.values()];
    return { items, nextCursor: null, total: items.length };
  }
  async agentStats(agentIds: readonly string[]) {
    return new Map(
      agentIds.map((id) => [
        id,
        { sessionsCompleted: 0, visitsCompleted: 0, hoursThisWeek: 0, hoursThisMonth: 0, openClaims: 0 },
      ]),
    );
  }
  async listTeams() {
    const items = await Promise.all([...this.state.teams.keys()].map((id) => this.teamById(id)));
    return { items: items as TeamRecord[], nextCursor: null, total: items.length };
  }
  async missingSkills(codes: readonly string[]) {
    return codes.filter((code) => !this.state.skills.get(code)?.active);
  }
  async missingZones(keys: readonly string[]) {
    return keys.filter((zone) => !this.state.zones.has(zone));
  }
  async agentAssignments(agentId: string) {
    const items: AgentAssignmentRecord[] = [...this.state.assignments.values()]
      .filter((a) => a.agentId === agentId)
      .map((a) => {
        const target = this.state.targets.get(key(a.target))!;
        return {
          ...a,
          targetStatus: target.status,
          placeTypeName: target.placeTypeName,
          communeName: target.communeName,
        };
      });
    return { items, nextCursor: null, total: items.length };
  }
  async planning() {
    return this.targets([...this.state.targets.values()].map((t) => t.target));
  }
  async unassigned() {
    const items = await this.planning();
    return { items, nextCursor: null, total: items.length };
  }

  private tx(): PlanningTx {
    const state = () => this.state;
    const reader = {
      agentById: (id: string) => this.agentById(id),
      agentByUserId: (id: string) => this.agentByUserId(id),
      agentsByIds: (ids: readonly string[]) => this.agentsByIds(ids),
      teamById: (id: string) => this.teamById(id),
      agendas: (ids: readonly string[], w: { start: Date; end: Date | null }) => this.agendas(ids, w),
      targets: (refs: readonly TargetRef[]) => this.targets(refs),
      assignment: (id: string) => this.assignment(id),
      settings: () => this.settings(),
      invitationById: (id: string) => this.invitationById(id),
    };
    return {
      ...reader,
      lockAgents: async (ids) => {
        this.locks.push([...ids].sort());
      },
      insertAgent: async (agent) => {
        if ([...state().agents.values()].some((a) => a.userId === agent.userId)) {
          throw new AgentAlreadyRegisteredError();
        }
        state().agents.set(agent.id, {
          ...agent,
          canLead: false,
          ratingSum: 0,
          ratingCount: 0,
          statusReason: null,
          roleAssignmentId: null,
          updatedAt: agent.createdAt,
          version: 0,
          skills: [],
          zoneKeys: [],
          weekly: [],
          extras: [],
          unavailabilities: [],
        });
      },
      updateAgent: async (id, version, patch) => {
        const agent = state().agents.get(id)!;
        if (agent.version !== version) throw new ConcurrentUpdateError();
        const { reviewedBy: _by, reviewedAt: _at, ...fields } = patch;
        Object.assign(agent, fields, { version: version + 1 });
      },
      replaceSkills: async (agentId, skills) => {
        state().agents.get(agentId)!.skills = skills.map((s) => ({
          ...s,
          name: state().skills.get(s.code)?.name ?? s.code,
        }));
      },
      replaceZones: async (agentId, zoneKeys) => {
        state().agents.get(agentId)!.zoneKeys = [...zoneKeys];
      },
      replaceWeekly: async (agentId, ranges) => {
        state().agents.get(agentId)!.weekly = ranges.map((r) => ({ ...r }));
      },
      replaceExtras: async (agentId, extras) => {
        state().agents.get(agentId)!.extras = extras.map((e) => ({ ...e }));
      },
      insertUnavailability: async (row) => {
        state().agents.get(row.agentId)!.unavailabilities.push({
          id: row.id,
          start: row.start,
          end: row.end,
          reason: row.reason,
          note: row.note,
          forced: row.forced,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        });
      },
      deleteUnavailability: async (agentId, id) => {
        const agent = state().agents.get(agentId)!;
        const before = agent.unavailabilities.length;
        agent.unavailabilities = agent.unavailabilities.filter((u) => u.id !== id);
        return agent.unavailabilities.length < before;
      },
      insertTeam: async (team, memberIds) => {
        state().teams.set(team.id, { ...team, active: true, memberIds: [...memberIds] });
      },
      updateTeam: async (id, patch, memberIds) => {
        const team = state().teams.get(id)!;
        const { updatedAt: _at, ...fields } = patch;
        Object.assign(team, fields);
        if (memberIds) team.memberIds = [...memberIds];
      },
      insertAssignments: async (rows) => {
        for (const row of rows) this.insert(row);
      },
      removeAssignments: async (ids, removal) => {
        for (const id of ids) {
          Object.assign(state().assignments.get(id)!, {
            status: 'removed',
            removedBy: removal.by,
            removalReason: removal.reason,
          });
        }
      },
      respondAssignment: async (id, status) => {
        state().assignments.get(id)!.status = status;
      },
      setLead: async (id, isLead) => {
        state().assignments.get(id)!.isLead = isLead;
      },
      setSessionStatus: async (sessionId, status) => {
        state().targets.get(`session:${sessionId}`)!.status = status;
      },
      write: async (changes) => {
        state().events.push(...changes.events);
        state().audit.push(...changes.audit);
      },
      remember: async (record) => {
        state().idempotency.set(`${record.actorId}|${record.operation}|${record.key}`, record);
      },
      // Piste A (agents) : invitations
      openInvitation: async (row) => {
        const open = [...state().invitations.values()].find(
          (invitation) => invitation.phoneFingerprint === row.phoneFingerprint && !invitation.consumedAt,
        );
        if (open) Object.assign(open, { expiresAt: row.expiresAt, sentAt: null });
        else {
          state().invitations.set(row.id, {
            ...row,
            sentAt: null,
            sendAttempts: 0,
            consumedAt: null,
            agentId: null,
          });
        }
        return (await this.invitationById((open ?? row).id))!;
      },
      recordInvitationSend: async (id, sentAt) => {
        const invitation = state().invitations.get(id)!;
        invitation.sendAttempts += 1;
        if (sentAt) invitation.sentAt = sentAt;
      },
      consumeInvitation: async (id, agentId, at) => {
        const invitation = state().invitations.get(id);
        if (!invitation || invitation.consumedAt || invitation.expiresAt.getTime() <= at.getTime()) {
          return false;
        }
        Object.assign(invitation, { consumedAt: at, agentId, phoneEncrypted: null });
        return true;
      },
    };
  }

  /** Ajout d'une affectation, avec la contrainte d'exclusion de la base. */
  private insert(row: NewAssignment): void {
    const target = this.state.targets.get(key(row.target))!;
    const clash = [...this.state.assignments.values()].some(
      (a) =>
        a.agentId === row.agentId &&
        inForce(a) &&
        inForce(row) &&
        overlaps(
          { start: a.occupiedFrom, end: a.occupiedUntil },
          { start: row.occupiedFrom, end: row.occupiedUntil },
        ),
    );
    if (clash) throw new ScheduleOverlapError();
    this.state.assignments.set(row.id, {
      ...row,
      start: target.start,
      end: target.end,
      placeId: target.placeId,
    });
  }
}

/** Agent actif de Cotonou, compétence « interior » validée, disponible tous les jours 6 h – 20 h. */
export function agentRecord(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    userId: `user-${id}`,
    status: 'active',
    employmentKind: 'employee',
    displayName: `Agent ${id}`,
    photoFileId: null,
    homeCommuneKey: 'cotonou',
    idDocumentEncrypted: null,
    emergencyContactEncrypted: null,
    mobileMoneyEncrypted: null,
    maxHoursDay: 8,
    maxHoursWeek: 48,
    canLead: true,
    ratingSum: 0,
    ratingCount: 0,
    statusReason: null,
    roleAssignmentId: null,
    createdAt: new Date('2026-11-01T08:00:00Z'),
    updatedAt: new Date('2026-11-01T08:00:00Z'),
    version: 0,
    skills: [{ code: 'interior', name: 'Intérieur', status: 'validated' }],
    zoneKeys: ['cotonou'],
    weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 360, endMinute: 1200 })),
    extras: [],
    unavailabilities: [],
    ...extra,
  };
}

/** Séance à affecter du lundi 23 novembre 2026, 9 h – 11 h à Porto-Novo, à Cotonou. */
export function sessionTarget(id: string, extra: Partial<StoredTarget> = {}): StoredTarget {
  return {
    target: { kind: 'session', id },
    status: 'to_assign',
    placeId: 'place-a',
    communeKey: 'cotonou',
    start: new Date('2026-11-23T08:00:00Z'),
    end: new Date('2026-11-23T10:00:00Z'),
    requiredSkills: ['interior'],
    expectedTeamSize: 1,
    number: 'PN-000001',
    rank: 1,
    programId: 'program-1',
    requestId: 'request-1',
    customerId: 'customer-1',
    organizationId: null,
    sessionsCount: 4,
    communeName: 'Cotonou',
    placeTypeName: 'Villa',
    cleaningTypes: [{ id: 'type-1', code: 'floor', name: 'Sol' }],
    ...extra,
  };
}

/** Chiffrement réversible lisible, pour vérifier ce qui est stocké. */
export const fakeCipher: FieldCipher = {
  encrypt: (plain, context) => `enc(${context}):${plain}`,
  decrypt: (cipher, context) => {
    const prefix = `enc(${context}):`;
    if (!cipher.startsWith(prefix)) throw new Error('contexte');
    return cipher.slice(prefix.length);
  },
};

export const NOW = new Date('2026-11-20T07:00:00Z');

/**
 * Faux d'identity pour le rôle cleaning_agent (piste A) : attributions en mémoire, idempotentes
 * comme GrantRole et RevokeRole ; `failure` simule une panne ou un refus d'identity.
 */
export class FakeAgentRoles implements AgentRoles {
  /** Attribution active de chaque compte. */
  readonly active = new Map<string, string>();
  readonly granted: { userId: string; reason: string }[] = [];
  readonly revoked: { assignmentId: string; reason: string }[] = [];
  /** Erreur levée par chaque appel tant qu'elle est posée. */
  failure: Error | null = null;
  private sequence = 0;

  async grant(input: { userId: string; reason: string }): Promise<{ assignmentId: string }> {
    if (this.failure) throw this.failure;
    this.granted.push(input);
    let assignmentId = this.active.get(input.userId);
    if (!assignmentId) {
      assignmentId = `0192f1c4-0000-7000-9000-${String(++this.sequence).padStart(12, '0')}`;
      this.active.set(input.userId, assignmentId);
    }
    return { assignmentId };
  }

  async revoke(input: { assignmentId: string; reason: string }): Promise<void> {
    if (this.failure) throw this.failure;
    for (const [userId, assignmentId] of this.active) {
      if (assignmentId !== input.assignmentId) continue;
      this.active.delete(userId);
      this.revoked.push(input);
    }
  }
}

/**
 * Faux d'identity pour le compte d'un agent créé par l'admin (piste A) : un compte par numéro, créé
 * « en attente de vérification » s'il manque ; `failure` simule une panne ou un refus d'identity.
 */
export class FakeAgentAccounts implements AgentAccounts {
  /** Compte de chaque numéro normalisé. */
  readonly byPhone = new Map<string, { userId: string; status: string }>();
  readonly ensured: { phone: string; firstName: string; lastName: string }[] = [];
  /** Comptes créés par un appel. */
  readonly created: string[] = [];
  failure: Error | null = null;
  private sequence = 0;

  async ensureByPhone(input: { phone: string; firstName: string; lastName: string }): Promise<AgentAccount> {
    if (this.failure) throw this.failure;
    this.ensured.push(input);
    const existing = this.byPhone.get(input.phone);
    if (existing) return { ...existing, created: false };
    const account = {
      userId: `0192f1c4-0000-7000-a000-${String(++this.sequence).padStart(12, '0')}`,
      status: 'pending_verification',
    };
    this.byPhone.set(input.phone, account);
    this.created.push(account.userId);
    return { ...account, created: true };
  }

  async findByPhone(phone: string): Promise<{ userId: string; status: string } | null> {
    if (this.failure) throw this.failure;
    return this.byPhone.get(phone) ?? null;
  }
}

/**
 * Faux de notification pour l'invitation d'un agent (piste A) : envois reçus, avec leur numéro de
 * tentative ; `failure` simule une panne (AppError) ou un envoi refusé (InvitationSendFailedError).
 */
export class FakeInvitationSender implements InvitationSender {
  readonly sent: { invitationId: string; attempt: number; phone: string; expiresAt: Date }[] = [];
  /** Tentatives reçues, réussies ou non. */
  readonly attempts: number[] = [];
  failure: Error | null = null;

  async send(input: {
    invitationId: string;
    attempt: number;
    phone: string;
    expiresAt: Date;
  }): Promise<void> {
    this.attempts.push(input.attempt);
    if (this.failure) throw this.failure;
    this.sent.push(input);
  }
}

/** Empreinte de test du numéro invité : stable, sans le numéro en clair. */
export const fakePhoneFingerprints: PhoneFingerprints = {
  invitationPhone: (phone) => `k1.${Buffer.from(`empreinte:${phone}`).toString('base64url')}`,
};

/** Dépendances des cas d'usage du lot D, horloge fixe et identifiants prévisibles. */
export function planningDeps(
  planning = new InMemoryPlanning(),
  matrix: Record<string, Record<string, number>> = {},
) {
  let next = 0;
  const travelCalls: string[][] = [];
  const deps = {
    planning,
    travel: {
      matrix: async (placeIds: readonly string[]) => {
        travelCalls.push([...placeIds]);
        return travelFromMatrix(matrix);
      },
    },
    cipher: fakeCipher,
    clock: { now: () => NOW },
    ids: { next: () => `00000000-0000-7000-8000-${String(++next).padStart(12, '0')}` },
    people: {
      userNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, `Nom ${id}`])),
      organizationNames: async () => new Map<string, string>(),
    },
    // Piste A (agents)
    roles: new FakeAgentRoles(),
    accounts: new FakeAgentAccounts(),
    invitations: new FakeInvitationSender(),
    phoneFingerprints: fakePhoneFingerprints,
  } as unknown as AgentDeps;
  return { deps, planning, travelCalls };
}

export const STAFF = '0192f1c4-0000-7000-8000-00000000a001';
export const AGENT_USER = '0192f1c4-0000-7000-8000-00000000a002';

/** Exécute dans le contexte d'un membre du back-office (gateway, double authentification). */
export function asStaff<T>(fn: () => T, userId = STAFF): T {
  return runWithContext(
    {
      correlationId: 'test',
      callerService: 'gateway',
      user: {
        userId,
        sessionId: 's',
        activeContext: 'personal',
        roles: [],
        mfa: true,
        authTime: Math.floor(Date.now() / 1000),
      },
    },
    fn,
  );
}

/** Exécute dans le contexte d'un compte connecté de l'application agent. */
export function asUser<T>(fn: () => T, userId = AGENT_USER): T {
  return runWithContext(
    {
      correlationId: 'test',
      callerService: 'gateway',
      user: { userId, sessionId: 's', activeContext: 'personal', roles: [], mfa: false },
    },
    fn,
  );
}
