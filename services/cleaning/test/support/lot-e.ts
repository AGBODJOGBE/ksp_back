import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, runWithContext } from '@ksp/platform';
import { type Pool } from 'pg';
import { type ExecutionDeps } from '../../src/application/deps';
import { type SessionInvoiceRequest } from '../../src/application/execution/execution.ports';
import { FieldSessionUseCases } from '../../src/application/execution/field.use-cases';
import { type WalletDebit } from '../../src/application/ports';
import { AesGcmFieldCipher } from '../../src/infrastructure/crypto/aes-gcm-field-cipher';
import { PrismaIdempotencyStore } from '../../src/infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaExecutionRepository } from '../../src/infrastructure/persistence/execution/prisma-execution.repository';
import { PrismaPlanningRepository } from '../../src/infrastructure/persistence/planning/prisma-planning.repository';
import { type PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../../src/infrastructure/system/system';

/**
 * Jeu d'essai du lot E sur une vraie base : catalogue de démonstration, programme et séances créés
 * en SQL (le lot C les crée à l'acceptation du devis), agents et affectations en SQL ; wallet,
 * billing et payment remplacés par des faux en mémoire.
 */
const DEMO = join(__dirname, '..', '..', 'prisma', 'demo', 'demo-data.sql');
const ids = new UuidV7Generator();

export async function loadDemo(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET ksp.demo = 'on'");
    await client.query(readFileSync(DEMO, 'utf8'));
  } finally {
    client.release();
  }
}

/** Horloge réglable des tests. */
export class TestClock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

/** Wallet en mémoire : débit jamais partiel, idempotent par clé (ADR-046). */
export class FakeWallet {
  balances = new Map<string, number>();
  debits = new Map<string, { holderId: string; amount: number; transactionId: string; objectId: string }>();
  failing = false;

  credit(holderId: string, amount: number): void {
    this.balances.set(holderId, (this.balances.get(holderId) ?? 0) + amount);
  }

  async debit(input: {
    idempotencyKey: string;
    holder: { type: 'user' | 'organization'; id: string };
    amount: number;
    object: { objectType: string; objectId: string; part: string };
  }): Promise<WalletDebit> {
    if (this.failing) throw AppError.unavailable('WALLET_UNAVAILABLE', 'Wallet indisponible.');
    const existing = this.debits.get(input.idempotencyKey);
    if (existing) return { transactionId: existing.transactionId, amount: existing.amount, created: false };
    const balance = this.balances.get(input.holder.id) ?? 0;
    if (balance < input.amount) {
      throw AppError.precondition('WALLET_INSUFFICIENT_FUNDS', 'Solde insuffisant.', {
        missing: input.amount - balance,
      });
    }
    this.balances.set(input.holder.id, balance - input.amount);
    const transactionId = ids.next();
    this.debits.set(input.idempotencyKey, {
      holderId: input.holder.id,
      amount: input.amount,
      transactionId,
      objectId: input.object.objectId,
    });
    return { transactionId, amount: input.amount, created: true };
  }

  async refund(): Promise<void> {}

  async balance(holder: { id: string }): Promise<number> {
    return this.balances.get(holder.id) ?? 0;
  }
}

/** Billing en mémoire : une facture par clé (IssueInvoice idempotent). */
export class FakeInvoices {
  invoices = new Map<string, SessionInvoiceRequest & { invoiceId: string }>();
  failing = false;

  async issueSessionInvoice(request: SessionInvoiceRequest): Promise<{ invoiceId: string }> {
    if (this.failing) throw AppError.unavailable('BILLING_UNAVAILABLE', 'Billing indisponible.');
    const existing = this.invoices.get(request.idempotencyKey);
    if (existing) return { invoiceId: existing.invoiceId };
    const invoiceId = ids.next();
    this.invoices.set(request.idempotencyKey, { ...request, invoiceId });
    return { invoiceId };
  }
}

/** Payment en mémoire : une page par clé. */
export class FakeDirectPayments {
  requests: { idempotencyKey: string; amount: number; objectId: string }[] = [];

  async create(input: {
    idempotencyKey: string;
    amount: number;
    target: { objectId: string };
    expiresAt: Date | null;
  }) {
    const existing = this.requests.findIndex((request) => request.idempotencyKey === input.idempotencyKey);
    if (existing < 0)
      this.requests.push({
        idempotencyKey: input.idempotencyKey,
        amount: input.amount,
        objectId: input.target.objectId,
      });
    return {
      paymentId: `00000000-0000-7000-8000-${String(Math.max(existing, this.requests.length - 1)).padStart(12, '0')}`,
      checkoutUrl: `https://pay.test/${input.idempotencyKey}`,
      expiresAt: input.expiresAt,
    };
  }
}

export interface LotEHarness {
  deps: ExecutionDeps;
  clock: TestClock;
  wallet: FakeWallet;
  invoices: FakeInvoices;
  directPayments: FakePayments;
}
type FakePayments = FakeDirectPayments;

export function harness(prisma: PrismaService, now: string): LotEHarness {
  const clock = new TestClock(new Date(now));
  const wallet = new FakeWallet();
  const invoices = new FakeInvoices();
  const directPayments = new FakeDirectPayments();
  const deps = {
    execution: new PrismaExecutionRepository(prisma, clock, ids),
    planning: new PrismaPlanningRepository(prisma, clock, ids),
    idempotency: new PrismaIdempotencyStore(prisma),
    wallet,
    balances: wallet,
    invoices,
    directPayments,
    placePoints: { points: async () => new Map() },
    cipher: AesGcmFieldCipher.fromConfig(undefined, 'test'),
    clock,
    ids,
    people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
    photos: { attach: async () => undefined, remove: async () => undefined, list: async () => [] },
  } as unknown as ExecutionDeps;
  return { deps, clock, wallet, invoices, directPayments };
}

export interface SeededProgram {
  programId: string;
  ownerId: string;
  sessionIds: string[];
  agentUserId: string;
  agentId: string;
}

/**
 * Programme de particulier (ou d'organisation) de `count` séances quotidiennes de 2 h à partir de
 * `firstStart`, une séance par jour, un agent salarié chef d'équipe affecté à toutes.
 */
export async function seedProgram(
  pool: Pool,
  input: {
    count: number;
    firstStart: string;
    price?: number;
    visitFeeToDeduct?: number;
    payerKind?: 'individual' | 'organization';
    status?: 'confirmed' | 'in_progress';
  },
): Promise<SeededProgram> {
  const [place, request, quote, program, owner, agentId, agentUserId] = [
    ids.next(),
    ids.next(),
    ids.next(),
    ids.next(),
    ids.next(),
    ids.next(),
    ids.next(),
  ];
  const price = input.price ?? 10_000;
  const ownerKind = input.payerKind === 'organization' ? 'organization' : 'user';
  const { rows } = await pool.query<{ offer_id: string; place_type_id: string }>(
    'SELECT id AS offer_id, place_type_id FROM offers LIMIT 1',
  );
  const { offer_id: offerId, place_type_id: placeTypeId } = rows[0]!;
  await pool.query(
    `INSERT INTO places (id, owner_kind, owner_id, place_type_id, name, gps_encrypted, landmark_encrypted, commune_key, created_by, created_at, updated_at)
     VALUES ($1, $5, $2, $3, 'Maison', 'x', 'x', 'cotonou', $4, now(), now())`,
    [place, owner, placeTypeId, owner, ownerKind],
  );
  await pool.query(
    `INSERT INTO cleaning_requests (id, owner_kind, owner_id, submitted_by, place_id, place_type_id, commune_key, gps_encrypted, landmark_encrypted, status, declared_values, schedule_plan, visit_slots, created_at, updated_at)
     VALUES ($1, $5, $2, $6, $3, $4, 'cotonou', 'x', 'x', 'accepted', '{}', '{}', '[{}]', now(), now())`,
    [request, owner, place, placeTypeId, ownerKind, ownerKind === 'user' ? owner : agentUserId],
  );
  await pool.query('INSERT INTO request_items (request_id, offer_id) VALUES ($1, $2)', [request, offerId]);
  await pool.query(
    `INSERT INTO quotes (id, request_id, version, lines, session_price, sessions_count, total, team_size, duration_minutes, schedule_plan, created_by, created_at)
     VALUES ($1, $2, 1, '[]', $4, $5, $6, 1, 120, '{}', $3, now())`,
    [quote, request, owner, price, input.count, price * input.count],
  );
  await pool.query(
    `INSERT INTO programs (id, request_id, quote_id, owner_kind, owner_id, payer_kind, place_id, commune_key, session_price, team_size, duration_minutes, schedule_plan, visit_fee_to_deduct, status, created_at, updated_at)
     VALUES ($1, $2, $3, $8, $4, $9, $5, 'cotonou', $6, 1, 120, '{"kind":"one_off"}', $7, $10, now(), now())`,
    [
      program,
      request,
      quote,
      owner,
      place,
      price,
      input.visitFeeToDeduct ?? 0,
      ownerKind,
      input.payerKind ?? 'individual',
      input.status ?? 'confirmed',
    ],
  );
  await pool.query(
    `INSERT INTO agents (id, user_id, status, employment_kind, display_name, home_commune_key, created_at, updated_at)
     VALUES ($1, $2, 'active', 'employee', 'Awa', 'cotonou', now(), now())`,
    [agentId, agentUserId],
  );
  const sessionIds: string[] = [];
  const first = new Date(input.firstStart).getTime();
  for (let rank = 1; rank <= input.count; rank += 1) {
    const id = ids.next();
    const start = new Date(first + (rank - 1) * 86_400_000);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    await pool.query(
      `INSERT INTO sessions (id, program_id, rank, commune_key, scheduled_start, scheduled_end, price, status, payment_status, created_at, updated_at)
       VALUES ($1, $2, $3, 'cotonou', $4, $5, $6, 'assigned', $7, now(), now())`,
      [id, program, rank, start, end, price, input.payerKind === 'organization' ? null : 'not_due'],
    );
    await pool.query(
      `INSERT INTO assignments (id, target_kind, session_id, agent_id, is_lead, source, status, occupied_from, occupied_until, created_by, created_at)
       VALUES ($1, 'session', $2, $3, true, 'manual', 'confirmed', $4, $5, $3, now())`,
      [ids.next(), id, agentId, start, end],
    );
    sessionIds.push(id);
  }
  return { programId: program, ownerId: owner, sessionIds, agentUserId, agentId };
}

/** Appel au nom d'un compte de l'espace connecté (contexte personnel). */
export function asCustomer<T>(userId: string, fn: () => T): T {
  return runWithContext(
    {
      correlationId: 'test',
      callerService: 'gateway',
      user: { userId, sessionId: 's', activeContext: 'personal', roles: [], mfa: false },
    },
    fn,
  );
}

/** Appel du back-office (double authentification récente). */
export function asStaffMember<T>(userId: string, fn: () => T, permissions = SUPERVISOR_PERMISSIONS): T {
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
        permissions,
      },
    },
    fn,
  );
}

/** Permissions du superviseur du lot E (ADR-057). */
export const SUPERVISOR_PERMISSIONS = [
  'cleaning.program.read',
  'cleaning.program.manage',
  'cleaning.amounts.read',
];

export const newId = () => ids.next();

/** Déroulé complet d'une séance par son chef d'équipe, à l'heure prévue (2 h de travail). */
export async function runSession(
  h: LotEHarness,
  agentUserId: string,
  sessionId: string,
  start: Date,
): Promise<void> {
  const field = new FieldSessionUseCases(h.deps);
  const as = <T>(fn: () => Promise<T>) => asCustomer(agentUserId, fn);
  const key = (step: string) => `${step}-${sessionId}`;
  h.clock.current = new Date(start.getTime() - 10 * 60_000);
  await as(() => field.arrive({ sessionId, idempotencyKey: key('arrivee') }));
  await as(() =>
    field.addPhoto({ sessionId, idempotencyKey: key('avant'), fileId: newId(), kind: 'before' }),
  );
  h.clock.current = start;
  await as(() => field.start({ sessionId, idempotencyKey: key('demarrage') }));
  const view = await as(() => field.get(sessionId));
  await as(() =>
    field.updateChecklist({
      sessionId,
      idempotencyKey: key('liste'),
      items: view.checklist.map((point) => ({
        code: point.code,
        checked: true,
        cleaningTypeCode: point.cleaningTypeCode,
      })),
    }),
  );
  await as(() => field.addPhoto({ sessionId, idempotencyKey: key('apres'), fileId: newId(), kind: 'after' }));
  h.clock.current = new Date(start.getTime() + 2 * 3_600_000);
  await as(() => field.complete({ sessionId, idempotencyKey: key('cloture') }));
}
