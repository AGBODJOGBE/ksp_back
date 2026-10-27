import { type RoleClaim, runWithContext } from '@ksp/platform';
import { type BillingContract, contractPeriods } from '../../domain/contract';
import { formatInvoiceNumber, type Invoice, type InvoicePayment } from '../../domain/invoice';
import { type BillingSettings, DEFAULT_BILLING_SETTINGS } from '../../domain/settings';
import {
  type BillingDeps,
  type Clock,
  type ContractRepository,
  type IdGenerator,
  type InvoiceFilter,
  type InvoiceRepository,
  type OutboxMessage,
  type PageRequest,
  type SettingsRepository,
  type StoredBillingSettings,
} from '../ports';

/** Doublures en mémoire des ports de billing, pour les tests de l'application. */
export class FixedClock implements Clock {
  constructor(public current = new Date('2026-12-05T08:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `0192f1c4-7a2b-7c3d-8e4f-${String(this.counter).padStart(12, '0')}`;
  }
}

export class Recorder {
  readonly events: OutboxMessage[] = [];
  record(events: OutboxMessage[]): void {
    this.events.push(...events);
  }
}

export class InMemoryContracts implements ContractRepository {
  readonly contracts = new Map<string, BillingContract>();
  readonly processed = new Set<string>();

  constructor(private readonly invoices: InMemoryInvoices) {}

  async apply(
    eventId: string,
    consumer: string,
    contractId: string,
    change: (current: BillingContract | null) => BillingContract | null,
  ) {
    const key = `${eventId}/${consumer}`;
    if (this.processed.has(key)) return 'duplicate' as const;
    this.processed.add(key);
    const next = change(this.contracts.get(contractId) ?? null);
    if (next) this.contracts.set(contractId, next);
    return 'processed' as const;
  }
  async findById(id: string) {
    return this.contracts.get(id) ?? null;
  }
  async listOpen() {
    return [...this.contracts.values()]
      .map((contract) => ({
        contract,
        invoicedIndexes: [...this.invoices.invoices.values()]
          .filter((invoice) => invoice.contractId === contract.id)
          .map((invoice) => invoice.periodIndex),
      }))
      .filter(({ contract, invoicedIndexes }) => invoicedIndexes.length < contractPeriods(contract).length);
  }
}

export class InMemoryInvoices implements InvoiceRepository {
  readonly invoices = new Map<string, Invoice>();
  private sequence = new Map<number, number>();

  constructor(private readonly recorder: Recorder) {}

  async issue(draft: Omit<Invoice, 'number'>, events: (invoice: Invoice) => OutboxMessage[]) {
    const exists = [...this.invoices.values()].some(
      (i) => i.contractId === draft.contractId && i.periodIndex === draft.periodIndex,
    );
    if (exists) return null;
    const year = draft.issuedAt.getUTCFullYear();
    const next = (this.sequence.get(year) ?? 0) + 1;
    this.sequence.set(year, next);
    const invoice = { ...draft, number: formatInvoiceNumber(year, next) };
    this.invoices.set(invoice.id, invoice);
    this.recorder.record(events(invoice));
    return invoice;
  }
  async findById(id: string) {
    return this.invoices.get(id) ?? null;
  }
  async list(filter: InvoiceFilter, page: PageRequest) {
    const items = [...this.invoices.values()]
      .filter(
        (i) =>
          (!filter.customerId || i.customerId === filter.customerId) &&
          (filter.organizationId === undefined || i.organizationId === filter.organizationId) &&
          (!filter.contractId || i.contractId === filter.contractId) &&
          (!filter.status || i.status === filter.status),
      )
      .sort((a, b) => b.id.localeCompare(a.id));
    const from = page.cursor ? items.filter((i) => i.id < page.cursor!) : items;
    const slice = from.slice(0, page.limit);
    return { items: slice, nextCursor: from.length > page.limit ? slice.at(-1)!.id : null };
  }
  async listPastDue(now: Date) {
    return [...this.invoices.values()].filter((i) => i.status === 'pending_payment' && i.dueAt <= now);
  }
  async markOverdue(invoice: Invoice, events: (overdueCount: number) => OutboxMessage[]) {
    const stored = this.invoices.get(invoice.id);
    if (!stored || stored.status !== 'pending_payment' || stored.version !== invoice.version) return false;
    this.invoices.set(invoice.id, { ...stored, status: 'overdue', version: stored.version + 1 });
    this.recorder.record(events(this.countOverdue(invoice.contractId)));
    return true;
  }
  async recordPayment(
    invoice: Invoice,
    _payment: InvoicePayment,
    events: (overdueCount: number) => OutboxMessage[],
  ) {
    const stored = this.invoices.get(invoice.id);
    if (!stored || stored.version !== invoice.version) return false;
    this.invoices.set(invoice.id, { ...invoice, version: invoice.version + 1 });
    this.recorder.record(events(this.countOverdue(invoice.contractId)));
    return true;
  }
  private countOverdue(contractId: string) {
    return [...this.invoices.values()].filter((i) => i.contractId === contractId && i.status === 'overdue')
      .length;
  }
}

export class InMemorySettings implements SettingsRepository {
  current: StoredBillingSettings = { ...DEFAULT_BILLING_SETTINGS, updatedBy: null, updatedAt: null };
  async get() {
    return this.current;
  }
  async save(settings: BillingSettings, updatedBy: string, at: Date) {
    this.current = { ...settings, updatedBy, updatedAt: at };
    return this.current;
  }
}

export interface TestWorld extends BillingDeps {
  recorder: Recorder;
  clock: FixedClock;
  contracts: InMemoryContracts;
  invoices: InMemoryInvoices;
  settings: InMemorySettings;
}

export function testWorld(): TestWorld {
  const recorder = new Recorder();
  const invoices = new InMemoryInvoices(recorder);
  return {
    recorder,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    contracts: new InMemoryContracts(invoices),
    invoices,
    settings: new InMemorySettings(),
  };
}

export const CUSTOMER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
export const OTHER_CUSTOMER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99';
export const ORGANIZATION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000';
export const STAFF_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001';

/** Exécute `fn` comme l'utilisateur donné (contexte transmis par la gateway). */
export function as<T>(
  userId: string,
  fn: () => T,
  options: { roles?: string[]; mfa?: boolean; activeContext?: string } = {},
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
        authTime: Math.floor(Date.now() / 1000),
      },
    },
    fn,
  );
}

export const asCustomer = <T>(fn: () => T, activeContext = ORGANIZATION_ID) =>
  as(CUSTOMER_ID, fn, { activeContext });
export const asStaff = <T>(fn: () => T, role = 'finance_officer') =>
  as(STAFF_ID, fn, { roles: [role], mfa: true });
