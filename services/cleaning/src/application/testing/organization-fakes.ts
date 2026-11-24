import { type OrganizationProgram, type ProgramChange } from '../../domain/organizations/alignment';
import { type InvoiceStanding, type OrganizationBillingStanding } from '../../domain/organizations/standing';
import { isTerminalProgram, type ProgramStatus } from '../../domain/programs/program-status';
import { type ActiveCause, type SuspensionCauseCode } from '../../domain/programs/suspension';
import { DEFAULT_SETTINGS, type ModuleSettings } from '../../domain/settings/settings';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import {
  type ExecutionReader,
  type ExecutionRepository,
  type ExecutionSettings,
  type ExecutionTx,
  type ProgramRecord,
  type SessionPatch,
  type SessionRecord,
} from '../execution/execution.ports';
import {
  type KspStanding,
  type OrganizationTransaction,
  type OrganizationUnitOfWork,
  type ProgramCauseEffect,
} from '../organizations/organizations.ports';
import {
  lockedOrganizationPrograms,
  unpaidWarningChanges,
  writeCauseChanges,
  writeUnpaidProgramChanges,
} from '../organizations/program-changes';
import {
  type AuditEntry,
  type Changes,
  type IdempotencyRecord,
  type IdempotencyStore,
  type OutboxMessage,
} from '../ports';
import { type SettingsRepository, type StoredSettings } from '../settings/settings.use-cases';

/**
 * Doublures en mémoire de la situation des organisations (piste O) : état d'une base réduite aux
 * tables utiles, transaction qui annule tout en cas d'erreur, verrou par organisation. Les
 * écritures des programmes passent par le vrai code du lot E, sur une doublure de sa transaction.
 */
export interface FakeState {
  processed: Set<string>;
  billing: Map<string, OrganizationBillingStanding>;
  invoices: Map<string, { organizationId: string; standing: InvoiceStanding; at: Date }>;
  ksp: Map<string, KspStanding>;
  programs: Map<string, ProgramRecord>;
  sessions: Map<string, SessionRecord[]>;
  /** Historique des causes (program_suspension_causes). */
  causes: { programId: string; cause: SuspensionCauseCode; since: Date; liftedAt: Date | null }[];
  events: OutboxMessage[];
  audit: AuditEntry[];
  idempotency: IdempotencyRecord[];
  holidays: string[];
}

export function emptyState(): FakeState {
  return {
    processed: new Set(),
    billing: new Map(),
    invoices: new Map(),
    ksp: new Map(),
    programs: new Map(),
    sessions: new Map(),
    causes: [],
    events: [],
    audit: [],
    idempotency: [],
    holidays: [],
  };
}

export function programRecord(input: {
  id: string;
  organizationId: string;
  status?: ProgramStatus;
  causes?: ActiveCause[];
  excludedDates?: string[];
  /** Programme d'un particulier : `organizationId` est alors son compte. */
  personal?: boolean;
}): ProgramRecord {
  const causes = input.causes ?? [];
  return {
    id: input.id,
    number: `PN-2026-${input.id.slice(-6)}`,
    ownerKind: input.personal ? 'user' : 'organization',
    ownerId: input.organizationId,
    customerId: input.personal ? input.organizationId : '0196b1c0-0000-7000-8000-00000000c001',
    organizationId: input.personal ? null : input.organizationId,
    payerKind: input.personal ? 'individual' : 'organization',
    communeKey: 'cotonou',
    status: input.status ?? (causes.length ? 'suspended' : 'confirmed'),
    causes,
    suspendedAt: causes.length ? causes[0]!.since : null,
    schedulePlan: { excludedDates: input.excludedDates ?? [] },
    planKind: 'weekly',
    sessionsCount: 0,
  } as unknown as ProgramRecord;
}

export function sessionRecord(input: {
  id: string;
  programId: string;
  rank: number;
  status: SessionRecord['status'];
  start: Date;
  agentIds?: string[];
}): SessionRecord {
  return {
    id: input.id,
    programId: input.programId,
    rank: input.rank,
    status: input.status,
    scheduledStart: input.start,
    scheduledEnd: new Date(input.start.getTime() + 2 * 3_600_000),
    agents: (input.agentIds ?? []).map((agentId, index) => ({ agentId, isLead: index === 0 })),
    catchUpSuggestedStart: null,
    version: 0,
  } as unknown as SessionRecord;
}

/** Lectures du lot E sur l'état en mémoire. */
class FakeExecutionReader implements Pick<ExecutionReader, 'program' | 'programSessions' | 'holidays'> {
  constructor(protected readonly state: () => FakeState) {}

  async program(id: string): Promise<ProgramRecord | null> {
    const program = this.state().programs.get(id);
    return program ? { ...program, causes: [...program.causes] } : null;
  }

  async programSessions(programId: string): Promise<SessionRecord[]> {
    return (this.state().sessions.get(programId) ?? []).map((session) => ({ ...session }));
  }

  async holidays(): Promise<string[]> {
    return [...this.state().holidays];
  }
}

/** Écritures du lot E utilisées par la suspension et la reprise ; les autres ne sont pas appelées. */
class FakeExecutionTx extends FakeExecutionReader {
  /** Verrous pris (organisation, puis programmes), dans l'ordre. */
  readonly locked: string[] = [];

  constructor(
    state: () => FakeState,
    private readonly firstSessionLeadHours: number,
  ) {
    super(state);
  }

  async lockProgram(programId: string): Promise<void> {
    this.locked.push(programId);
  }

  /** Verrou de l'organisation (RV-85) : sa situation partage cette transaction. */
  async organization(organizationId: string): Promise<OrganizationTransaction> {
    this.locked.push(`organisation ${organizationId}`);
    return new FakeOrganizationTransaction(this.state, this);
  }

  async settings(): Promise<ExecutionSettings> {
    return { firstSessionLeadHours: this.firstSessionLeadHours } as ExecutionSettings;
  }

  async addCause(
    programId: string,
    cause: ActiveCause,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void> {
    const program = this.state().programs.get(programId)!;
    this.state().causes.push({ programId, cause: cause.cause, since: cause.since, liftedAt: null });
    this.state().programs.set(programId, {
      ...program,
      causes: [...program.causes, cause],
      ...(status ?? {}),
    });
  }

  async liftCause(
    programId: string,
    cause: SuspensionCauseCode,
    at: Date,
    _by: string | null,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void> {
    const program = this.state().programs.get(programId)!;
    for (const line of this.state().causes) {
      if (line.programId === programId && line.cause === cause && !line.liftedAt) line.liftedAt = at;
    }
    this.state().programs.set(programId, {
      ...program,
      causes: program.causes.filter((active) => active.cause !== cause),
      ...(status ?? {}),
    });
  }

  async updateSession(id: string, _expectedVersion: number | null, patch: SessionPatch): Promise<void> {
    for (const [programId, sessions] of this.state().sessions) {
      this.state().sessions.set(
        programId,
        sessions.map((session) =>
          session.id === id ? ({ ...session, ...patch } as SessionRecord) : session,
        ),
      );
    }
  }

  async releaseAssignments(sessionIds: readonly string[]): Promise<string[]> {
    const released = new Set<string>();
    for (const [programId, sessions] of this.state().sessions) {
      this.state().sessions.set(
        programId,
        sessions.map((session) => {
          if (!sessionIds.includes(session.id)) return session;
          session.agents.forEach((agent) => released.add(agent.agentId));
          return { ...session, agents: [] };
        }),
      );
    }
    return [...released].sort();
  }

  async write(changes: Changes): Promise<void> {
    this.state().events.push(...changes.events);
    this.state().audit.push(...changes.audit);
    if (changes.idempotency) this.state().idempotency.push(changes.idempotency);
  }
}

class FakeOrganizationTransaction implements OrganizationTransaction {
  constructor(
    private readonly state: () => FakeState,
    readonly execution: FakeExecutionTx,
  ) {}

  private get tx(): ExecutionTx {
    return this.execution as unknown as ExecutionTx;
  }

  async markProcessed(eventId: string, consumer: string): Promise<boolean> {
    const key = `${eventId}|${consumer}`;
    if (this.state().processed.has(key)) return false;
    this.state().processed.add(key);
    return true;
  }

  async standing(organizationId: string): Promise<OrganizationBillingStanding> {
    return (
      this.state().billing.get(organizationId) ?? {
        organizationId,
        overdueCount: 0,
        warningLevel: 0,
        version: 0,
      }
    );
  }

  async saveStanding(standing: OrganizationBillingStanding): Promise<void> {
    const stored = this.state().billing.get(standing.organizationId);
    if ((stored?.version ?? 0) !== standing.version - 1) throw new ConcurrentUpdateError();
    this.state().billing.set(standing.organizationId, { ...standing });
  }

  async invoiceStanding(invoiceId: string): Promise<InvoiceStanding | null> {
    return this.state().invoices.get(invoiceId)?.standing ?? null;
  }

  async saveInvoiceStanding(invoice: {
    invoiceId: string;
    organizationId: string;
    standing: InvoiceStanding;
    at: Date;
  }): Promise<void> {
    this.state().invoices.set(invoice.invoiceId, {
      organizationId: invoice.organizationId,
      standing: invoice.standing,
      at: invoice.at,
    });
  }

  async overdueInvoiceIds(organizationId: string): Promise<string[]> {
    return [...this.state().invoices]
      .filter(([, invoice]) => invoice.organizationId === organizationId && invoice.standing === 'overdue')
      .map(([invoiceId]) => invoiceId)
      .sort();
  }

  async openPrograms(organizationId: string): Promise<OrganizationProgram[]> {
    const programIds = [...this.state().programs.values()]
      .filter((program) => program.ownerId === organizationId && !isTerminalProgram(program.status))
      .map((program) => program.id);
    return lockedOrganizationPrograms(this.tx, programIds);
  }

  applyProgramChanges(
    changes: readonly ProgramChange[],
    context: { unpaidCount: number; threshold: number; at: Date },
  ): Promise<void> {
    return writeUnpaidProgramChanges(this.tx, changes, context);
  }

  publishUnpaidWarning(payload: Parameters<typeof unpaidWarningChanges>[0]): Promise<void> {
    return this.tx.write(unpaidWarningChanges(payload));
  }

  async kspStanding(organizationId: string): Promise<KspStanding | null> {
    return this.state().ksp.get(organizationId) ?? null;
  }

  async saveKspStanding(standing: KspStanding): Promise<void> {
    this.state().ksp.set(standing.organizationId, { ...standing });
  }

  applyOrganizationSuspension(input: {
    programIds: readonly string[];
    action: 'add' | 'lift';
    at: Date;
  }): Promise<ProgramCauseEffect[]> {
    return writeCauseChanges(this.tx, {
      changes: input.programIds.map((programId) => ({ programId, action: input.action })),
      cause: 'organization_suspended',
      unpaidCount: null,
      threshold: null,
      at: input.at,
    });
  }
}

/**
 * Unité de travail en mémoire : une transaction à la fois par organisation (verrou), état remis
 * tel qu'il était si `work` échoue.
 */
export class FakeOrganizations implements OrganizationUnitOfWork {
  state: FakeState = emptyState();
  settings: ModuleSettings = { ...DEFAULT_SETTINGS };
  /** Organisations dont la prochaine transaction échoue à la fin (test de l'annulation). */
  readonly failing = new Set<string>();
  /** Ordre d'entrée et de sortie des transactions (test du verrou). */
  readonly trace: string[] = [];
  private readonly queues = new Map<string, Promise<unknown>>();

  readonly reader = new FakeExecutionReader(() => this.state) as unknown as ExecutionReader;

  /** Dépôt du lot E sur le même état (actions du back-office sur un programme). */
  readonly execution = Object.assign(new FakeExecutionReader(() => this.state), {
    transaction: <T>(work: (tx: ExecutionTx) => Promise<T>): Promise<T> =>
      this.transact((execution) => work(execution as unknown as ExecutionTx)),
  }) as unknown as ExecutionRepository;

  readonly idempotency: IdempotencyStore = {
    find: async (ref) =>
      this.state.idempotency.find(
        (record) =>
          record.actorId === ref.actorId && record.operation === ref.operation && record.key === ref.key,
      ) ?? null,
  };

  readonly moduleSettings: SettingsRepository = {
    read: async (): Promise<StoredSettings> => ({
      settings: this.settings,
      updatedAt: null,
      updatedBy: null,
      version: 0,
    }),
    save: async (settings) => {
      this.settings = settings;
    },
  };

  run<T>(organizationId: string, work: (tx: OrganizationTransaction) => Promise<T>): Promise<T> {
    const previous = this.queues.get(organizationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.trace.push(`début ${organizationId}`);
        try {
          return await this.transact(async (execution) => {
            const result = await work(await execution.organization(organizationId));
            if (this.failing.delete(organizationId)) throw new Error('Échec de la transaction (test).');
            return result;
          });
        } finally {
          this.trace.push(`fin ${organizationId}`);
        }
      });
    this.queues.set(organizationId, next);
    return next;
  }

  /** Transaction : l'état est remis tel qu'il était si `work` échoue. */
  private async transact<T>(work: (execution: FakeExecutionTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work(new FakeExecutionTx(() => this.state, this.settings.firstSessionLeadHours));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async organizationsToReevaluate(): Promise<string[]> {
    const ids = new Set<string>();
    for (const invoice of this.state.invoices.values()) {
      if (invoice.standing === 'overdue') ids.add(invoice.organizationId);
    }
    for (const standing of this.state.billing.values()) {
      if (standing.overdueCount > 0 || standing.warningLevel > 0) ids.add(standing.organizationId);
    }
    for (const program of this.state.programs.values()) {
      if (program.causes.some((cause) => cause.cause === 'unpaid_invoices')) ids.add(program.ownerId);
    }
    return [...ids].sort();
  }
}
