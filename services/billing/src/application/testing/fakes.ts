import { AppError, type RoleClaim, runWithContext } from '@ksp/platform';
import { type BillingContract, contractPeriods } from '../../domain/contract';
import { formatInvoiceNumber, type Invoice, type InvoicePayment, invoiceYear } from '../../domain/invoice';
import { type BillingSettings, DEFAULT_BILLING_SETTINGS } from '../../domain/settings';
import {
  type BillingDeps,
  type Clock,
  type ContractRepository,
  type IdGenerator,
  type InvoiceFilter,
  type InvoiceRepository,
  type OrganizationDirectory,
  type OrganizationProfile,
  type OutboxMessage,
  type PageRequest,
  type SettingsRepository,
  type StoredBillingSettings,
  type WalletDebit,
  type WalletLedger,
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
    // Comme la transaction SQL : une erreur levée par `change` n'enregistre pas l'événement (inbox).
    const next = change(this.contracts.get(contractId) ?? null);
    this.processed.add(key);
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

  /** Contrat relu « sous verrou » à l'émission (relié par testWorld). */
  contractOf: (id: string) => BillingContract | null = () => null;

  async issue(
    contractId: string,
    periodIndex: number,
    build: (contract: BillingContract) => Omit<Invoice, 'number'> | null,
    events: (invoice: Invoice) => OutboxMessage[],
  ) {
    const exists = [...this.invoices.values()].some(
      (i) => i.contractId === contractId && i.periodIndex === periodIndex,
    );
    if (exists) return null;
    const contract = this.contractOf(contractId);
    const draft = contract ? build(contract) : null;
    if (!draft) return null;
    const year = invoiceYear(draft);
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
          (!filter.status || i.status === filter.status) &&
          (!filter.periodFrom || i.periodEnd > filter.periodFrom) &&
          (!filter.periodTo || i.periodStart < filter.periodTo),
      )
      .sort((a, b) => b.id.localeCompare(a.id));
    const from = page.cursor ? items.filter((i) => i.id < page.cursor!) : items;
    const slice = from.slice(0, page.limit);
    return { items: slice, nextCursor: from.length > page.limit ? slice.at(-1)!.id : null };
  }
  async listPastDue(now: Date) {
    return [...this.invoices.values()].filter((i) => i.status === 'pending_payment' && i.dueAt <= now);
  }
  async listUnpaidForCustomer(customerId: string) {
    return [...this.invoices.values()]
      .filter(
        (i) => i.customerId === customerId && (i.status === 'pending_payment' || i.status === 'overdue'),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
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
  readonly processed = new Set<string>();
  async recordOnlinePayment(
    invoice: Invoice,
    payment: InvoicePayment,
    inbox: { eventId: string; consumer: string },
    events: (overdueCount: number) => OutboxMessage[],
  ) {
    const key = `${inbox.eventId}:${inbox.consumer}`;
    if (this.processed.has(key)) return 'duplicate' as const;
    if (!(await this.recordPayment(invoice, payment, events))) return 'conflict' as const;
    this.processed.add(key);
    return 'saved' as const;
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

/** Fiches d'identity en mémoire ; `unavailable` simule une panne d'identity. */
export class InMemoryOrganizations implements OrganizationDirectory {
  readonly profiles = new Map<string, OrganizationProfile>();
  readonly lookups: string[][] = [];
  unavailable = false;

  async findByIds(organizationIds: readonly string[]) {
    this.lookups.push([...organizationIds]);
    if (this.unavailable) throw new Error('identity indisponible');
    return organizationIds.flatMap((id) => {
      const profile = this.profiles.get(id);
      return profile ? [profile] : [];
    });
  }
}

/**
 * Portefeuille simulé (ADR-046) : solde par titulaire, débits idempotents par clé, remboursements
 * notés ; solde insuffisant refusé comme wallet (WALLET_INSUFFICIENT_FUNDS, montant manquant).
 */
export class FakeWallet implements WalletLedger {
  readonly balances = new Map<string, number>();
  readonly debits = new Map<string, { transactionId: string; amount: number; holderId: string }>();
  readonly refunds: string[] = [];

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
    const transactionId = `0192f1c4-0000-7000-d000-${String(this.debits.size + 1).padStart(12, '0')}`;
    this.debits.set(input.idempotencyKey, { transactionId, amount: input.amount, holderId: input.holder.id });
    return { transactionId, amount: input.amount, created: true };
  }

  async refund(input: { transactionId: string; reason: string }): Promise<void> {
    this.refunds.push(input.transactionId);
  }
}

export interface TestWorld extends BillingDeps {
  recorder: Recorder;
  wallet: FakeWallet;
  clock: FixedClock;
  contracts: InMemoryContracts;
  invoices: InMemoryInvoices;
  settings: InMemorySettings;
  organizations: InMemoryOrganizations;
}

export function testWorld(): TestWorld {
  const recorder = new Recorder();
  const invoices = new InMemoryInvoices(recorder);
  const contracts = new InMemoryContracts(invoices);
  invoices.contractOf = (id) => contracts.contracts.get(id) ?? null;
  return {
    recorder,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    contracts,
    invoices,
    settings: new InMemorySettings(),
    organizations: withOrganization(new InMemoryOrganizations()),
    wallet: new FakeWallet(),
  };
}

export const CUSTOMER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
export const OTHER_CUSTOMER_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99';
export const ORGANIZATION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000';
export const STAFF_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001';

/** Fiche de l'organisation des tests, telle qu'identity la rend à billing. */
export const ORGANIZATION_PROFILE: OrganizationProfile = {
  id: ORGANIZATION_ID,
  legalName: 'SARL Bénin Propre',
  address: 'Lot 12, Haie Vive, Cotonou',
  ifu: '3201912345678',
  rccm: 'RB/COT/19 B 1234',
};

function withOrganization(organizations: InMemoryOrganizations): InMemoryOrganizations {
  organizations.profiles.set(ORGANIZATION_ID, ORGANIZATION_PROFILE);
  return organizations;
}

/** Exécute `fn` comme l'utilisateur donné (contexte transmis par la gateway). */
export function as<T>(
  userId: string,
  fn: () => T,
  options: {
    roles?: string[];
    mfa?: boolean;
    activeContext?: string;
    orgRole?: string;
    /** Service appelant (jeton vérifié par le kit) ; absent : non vérifié, comme en développement. */
    callerService?: string;
  } = {},
): T {
  const roles: RoleClaim[] = (options.roles ?? ['customer']).map((role) => ({ role, scopeType: 'global' }));
  if (options.orgRole && options.activeContext) {
    roles.push({ role: options.orgRole, scopeType: 'org', scopeId: options.activeContext });
  }
  return runWithContext(
    {
      correlationId: 'c-test',
      ...(options.callerService ? { callerService: options.callerService } : {}),
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
