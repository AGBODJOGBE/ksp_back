import { runWithContext, type RequestContext } from '@ksp/platform';
import {
  type AuditLog,
  type CaseObligations,
  type Clock,
  type Directory,
  type Documents,
  type Files,
  type FullSettings,
  type Holiday,
  type HolidayStore,
  type IdGenerator,
  type Notifier,
  type PaymentLinks,
  type PersonalData,
  type PricingRuleFilter,
  type PricingRuleStore,
  type SettingsStore,
  type StoredPricingRule,
  type WalletGateway,
} from '../ports';
import { type RecoveryDeps } from '../use-cases';
import { memoryDebtorAccess } from './debtor-access.fakes';
import { memoryCaseStores } from './case-fakes';
import { type AmicableOptions } from '../amicable/amicable.ports';
import { MemoryAmicableStore, MemoryDocumentCancellation } from './amicable-fakes';
import { memoryMoneyStores } from './money-fakes';
import { MemoryStatementStore } from './statement-fakes';
import { MemoryLitigationStore } from './litigation-fakes';

/** Doublures en mémoire des ports (tests des cas d'usage). */

export const NOW = new Date('2026-11-20T09:00:00.000Z');

export class FixedClock implements Clock {
  constructor(public current: Date = NOW) {}
  now(): Date {
    return this.current;
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `0192f1c4-0000-7000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
}

export class MemorySettingsStore implements SettingsStore {
  row: { values: unknown; updatedAt: Date; updatedBy: string | null } | null = null;
  async load() {
    return this.row;
  }
  async save(values: FullSettings, by: string, at: Date): Promise<void> {
    this.row = { values: structuredClone(values), updatedAt: at, updatedBy: by };
  }
}

export class MemoryHolidayStore implements HolidayStore {
  readonly days = new Map<string, string>();
  async listYear(year: number): Promise<Holiday[]> {
    return this.between(`${year}-01-01`, `${year}-12-31`);
  }
  async replaceYear(year: number, holidays: readonly Holiday[]): Promise<void> {
    for (const date of [...this.days.keys()]) if (date.startsWith(`${year}-`)) this.days.delete(date);
    for (const holiday of holidays) this.days.set(holiday.date, holiday.label);
  }
  async between(from: string, to: string): Promise<Holiday[]> {
    return [...this.days.entries()]
      .filter(([date]) => date >= from && date <= to)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, label]) => ({ date, label }));
  }
}

export class MemoryPricingRuleStore implements PricingRuleStore {
  readonly rules = new Map<string, StoredPricingRule>();
  readonly keys = new Map<string, string>();

  async find(id: string) {
    return this.rules.get(id) ?? null;
  }
  async findByIdempotencyKey(createdBy: string, key: string) {
    const id = this.keys.get(`${createdBy}:${key}`);
    return id ? (this.rules.get(id) ?? null) : null;
  }
  async list(filter: PricingRuleFilter, page: { limit: number; cursor: string | null }) {
    const items = [...this.rules.values()]
      .filter(
        (stored) =>
          (!filter.object || stored.rule.object === filter.object) &&
          (!filter.statuses?.length || filter.statuses.includes(stored.rule.status)) &&
          (!filter.offer || stored.rule.target.offer === filter.offer) &&
          (!filter.creditorId || stored.rule.target.creditorId === filter.creditorId) &&
          (!page.cursor || stored.rule.id < page.cursor),
      )
      .sort((a, b) => b.rule.id.localeCompare(a.rule.id));
    const pageItems = items.slice(0, page.limit);
    return {
      items: pageItems,
      nextCursor: items.length > page.limit ? pageItems[pageItems.length - 1]!.rule.id : null,
    };
  }
  async listByObject(object: string) {
    return [...this.rules.values()].filter(
      (stored) => stored.rule.object === object && stored.rule.status !== 'archived',
    );
  }
  async insert(stored: StoredPricingRule, idempotencyKey: string | null) {
    this.rules.set(stored.rule.id, structuredClone(stored));
    if (idempotencyKey) this.keys.set(`${stored.rule.createdBy}:${idempotencyKey}`, stored.rule.id);
  }
  async update(stored: StoredPricingRule) {
    this.rules.set(stored.rule.id, structuredClone(stored));
  }
  async publish(
    stored: StoredPricingRule,
    superseded: readonly { ruleId: string; action: 'archive' | 'end_at'; validUntil?: Date }[],
    at: Date,
  ) {
    for (const change of superseded) {
      const other = this.rules.get(change.ruleId)!;
      this.rules.set(
        change.ruleId,
        change.action === 'archive'
          ? { ...other, rule: { ...other.rule, status: 'archived' }, archivedAt: at }
          : { ...other, rule: { ...other.rule, validUntil: change.validUntil ?? at } },
      );
    }
    this.rules.set(stored.rule.id, structuredClone(stored));
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: Parameters<AuditLog['record']>[0][] = [];
  async record(entry: Parameters<AuditLog['record']>[0]): Promise<void> {
    this.entries.push(entry);
  }
}

export class MemoryCaseObligations implements CaseObligations {
  readonly open = new Map<string, { number: string }[]>();
  async openCases(creditor: { type: 'user' | 'organization'; id: string }) {
    return this.open.get(`${creditor.type}:${creditor.id}`) ?? [];
  }
}

/** Chiffrement factice réversible : les tests vérifient seulement le contexte et l'aller-retour. */
export class FakePersonalData implements PersonalData {
  encrypt(value: string, context: string): string {
    return `enc(${context}):${Buffer.from(value).toString('base64')}`;
  }
  decrypt(value: string, context: string): string {
    const prefix = `enc(${context}):`;
    if (!value.startsWith(prefix)) throw new Error('contexte différent');
    return Buffer.from(value.slice(prefix.length), 'base64').toString();
  }
  phoneIndex(phone: string): string {
    return `phone:${phone}`;
  }
  emailIndex(email: string): string {
    return `email:${email.toLowerCase()}`;
  }
  nameIndex(token: string): string {
    return `name:${token}`;
  }
}

const unused = (name: string) => () => {
  throw new Error(`${name} ne devrait pas être appelé en R1`);
};

export function makeDeps(overrides: Partial<RecoveryDeps> = {}) {
  const caseStores = memoryCaseStores();
  const moneyStores = memoryMoneyStores(caseStores.cases);
  const amicable = new MemoryAmicableStore(caseStores.cases);
  const base = {
    settings: new MemorySettingsStore(),
    holidays: new MemoryHolidayStore(),
    rules: new MemoryPricingRuleStore(),
    audit: new MemoryAuditLog(),
    obligations: new MemoryCaseObligations(),
    personalData: new FakePersonalData(),
    wallet: {
      debit: unused('wallet.debit'),
      refund: unused('wallet.refund'),
      recordCollection: unused('wallet.recordCollection'),
      reverseCollection: unused('wallet.reverseCollection'),
      balance: unused('wallet.balance'),
    } as WalletGateway,
    paymentLinks: {
      create: unused('payment.create'),
      get: unused('payment.get'),
      revoke: unused('payment.revoke'),
    } as PaymentLinks,
    documents: {
      generate: unused('document.generate'),
      requestSignature: unused('document.requestSignature'),
    } as Documents,
    files: { attach: unused('file.attach') } as Files,
    notifier: { sendToDebtor: unused('notification.sendToDebtor') } as Notifier,
    directory: {
      usersByIds: unused('identity.usersByIds'),
      organizationsByIds: unused('identity.organizationsByIds'),
    } as Directory,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    debtorAccess: memoryDebtorAccess(),
    ...caseStores,
    // Procédure amiable (R4) : ordre des canaux du service, e-mail d'abord (choix à trancher).
    amicable,
    documentCancellation: new MemoryDocumentCancellation(),
    amicableOptions: { debtorChannels: ['email', 'whatsapp'] } as AmicableOptions,
    ...moneyStores,
    // Relevés mensuels (R-CO-05), sur les encaissements du dépôt de l'argent.
    statements: new MemoryStatementStore(moneyStores.money),
    // Contentieux (R5) : ses décisions s'écrivent avec celles de la procédure amiable.
    litigation: new MemoryLitigationStore(caseStores.cases, amicable),
  };
  return { ...base, ...overrides } as typeof base;
}

export const ADMIN_ID = '0192f1c4-0000-7000-8000-00000000ad01';
export const SECOND_ADMIN_ID = '0192f1c4-0000-7000-8000-00000000ad02';
export const FINANCE_ID = '0192f1c4-0000-7000-8000-00000000f001';
export const AGENT_ID = '0192f1c4-0000-7000-8000-00000000a6e1';
export const CREDITOR_ID = '0192f1c4-0000-7000-8000-00000000c001';
export const ORGANIZATION_ID = '0192f1c4-0000-7000-8000-00000000c0a1';

/** Membre du personnel relayé par la gateway, double authentification il y a `mfaAgeSeconds`. */
export function asStaff<T>(
  userId: string,
  roles: readonly string[],
  fn: () => Promise<T>,
  mfaAgeSeconds = 60,
): Promise<T> {
  const context: RequestContext = {
    correlationId: 'c-test',
    callerService: 'gateway',
    user: {
      userId,
      sessionId: 's-test',
      activeContext: 'personal',
      roles: roles.map((role) => ({ role, scopeType: 'domain', scopeId: 'recovery' })),
      mfa: true,
      authTime: Math.floor(NOW.getTime() / 1000) - mfaAgeSeconds,
    },
  };
  return runWithContext(context, fn);
}

/** Créancier connecté : son compte, ou son organisation active. */
export function asCreditor<T>(fn: () => Promise<T>, organizationId?: string): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: 'gateway',
      user: {
        userId: CREDITOR_ID,
        sessionId: 's-test',
        activeContext: organizationId ?? 'personal',
        roles: organizationId ? [{ role: 'org_admin', scopeType: 'org', scopeId: organizationId }] : [],
        mfa: false,
      },
    },
    fn,
  );
}

export function asService<T>(service: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ correlationId: 'c-test', callerService: service }, fn);
}

/** Erreur rejetée par une promesse (code, détails). */
export async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; details: Record<string, unknown> };
  }
  throw new Error('La promesse aurait dû être rejetée.');
}
