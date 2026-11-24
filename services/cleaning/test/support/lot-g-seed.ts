import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWithContext } from '@ksp/platform';
import { type Pool } from 'pg';
import { UuidV7Generator } from '../../src/infrastructure/system/system';

/**
 * Jeu d'essai des tests d'intégration du lot G. Les programmes et les séances (lots C et E) sont
 * créés en SQL, sans passer par leurs cas d'usage ; les agents aussi, déjà validés.
 */
const DEMO = join(__dirname, '..', '..', 'prisma', 'demo', 'demo-data.sql');
const ids = new UuidV7Generator();

/** Catalogue, zones et compétences de démonstration. */
export async function loadDemo(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET ksp.demo = 'on'");
    await client.query(readFileSync(DEMO, 'utf8'));
  } finally {
    client.release();
  }
}

export interface SeededProgram {
  programId: string;
  requestId: string;
  quoteId: string;
  placeId: string;
  ownerId: string;
  sessionIds: string[];
}

export interface ProgramSeed {
  communeKey?: string;
  teamSize?: number;
  ownerKind?: 'user' | 'organization';
  ownerId?: string;
  /** Auteur de la demande (organisation) ; par défaut le titulaire. */
  submittedBy?: string;
  status?: 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  schedulePlan?: Record<string, unknown>;
  sessionPrice?: number;
  /** Séances : début, fin, statut (à affecter par défaut). */
  sessions: { start: string; end: string; status?: string; completedAt?: string }[];
}

/** Lieu, demande acceptée, devis, programme et ses séances. */
export async function seedProgram(pool: Pool, seed: ProgramSeed): Promise<SeededProgram> {
  const [placeId, requestId, quoteId, programId] = [ids.next(), ids.next(), ids.next(), ids.next()];
  const ownerId = seed.ownerId ?? ids.next();
  const ownerKind = seed.ownerKind ?? 'user';
  const submittedBy = seed.submittedBy ?? ownerId;
  const commune = seed.communeKey ?? 'cotonou';
  const teamSize = seed.teamSize ?? 1;
  const price = seed.sessionPrice ?? 10_000;
  const plan = JSON.stringify(seed.schedulePlan ?? {});
  const { rows } = await pool.query<{ offer_id: string; place_type_id: string }>(
    'SELECT id AS offer_id, place_type_id FROM offers ORDER BY id LIMIT 1',
  );
  const { offer_id: offerId, place_type_id: placeTypeId } = rows[0]!;
  await pool.query(
    `INSERT INTO places (id, owner_kind, owner_id, place_type_id, name, gps_encrypted, landmark_encrypted, commune_key, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Maison', 'x', 'x', $5, $6, now(), now())`,
    [placeId, ownerKind, ownerId, placeTypeId, commune, submittedBy],
  );
  await pool.query(
    `INSERT INTO cleaning_requests (id, owner_kind, owner_id, submitted_by, place_id, place_type_id, commune_key, gps_encrypted, landmark_encrypted, status, declared_values, schedule_plan, visit_slots, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'x', 'x', 'accepted', '{}', $8, '[{}]', now(), now())`,
    [requestId, ownerKind, ownerId, submittedBy, placeId, placeTypeId, commune, plan],
  );
  await pool.query('INSERT INTO request_items (request_id, offer_id) VALUES ($1, $2)', [requestId, offerId]);
  await pool.query(
    `INSERT INTO quotes (id, request_id, version, lines, session_price, sessions_count, total, team_size, duration_minutes, schedule_plan, created_by, created_at)
     VALUES ($1, $2, 1, '[]', $3, $4, $5, $6, 120, $7, $8, now())`,
    [
      quoteId,
      requestId,
      price,
      Math.max(1, seed.sessions.length),
      price * Math.max(1, seed.sessions.length),
      teamSize,
      plan,
      submittedBy,
    ],
  );
  await pool.query(
    `INSERT INTO programs (id, request_id, quote_id, owner_kind, owner_id, payer_kind, place_id, commune_key, session_price, team_size, duration_minutes, schedule_plan, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 120, $11, $12, now(), now())`,
    [
      programId,
      requestId,
      quoteId,
      ownerKind,
      ownerId,
      ownerKind === 'user' ? 'individual' : 'organization',
      placeId,
      commune,
      price,
      teamSize,
      plan,
      seed.status ?? 'confirmed',
    ],
  );
  const sessionIds: string[] = [];
  for (const [index, session] of seed.sessions.entries()) {
    sessionIds.push(
      await seedSession(pool, {
        programId,
        rank: index + 1,
        communeKey: commune,
        price,
        ...session,
      }),
    );
  }
  return { programId, requestId, quoteId, placeId, ownerId, sessionIds };
}

/**
 * Séance d'un programme ; une séance réalisée porte son heure de fin réelle et une photo « avant » et
 * « après » (contrainte sessions_completed_check).
 */
export async function seedSession(
  pool: Pool,
  input: {
    programId: string;
    rank: number;
    start: string;
    end: string;
    status?: string;
    completedAt?: string;
    communeKey?: string;
    price?: number;
  },
): Promise<string> {
  const id = ids.next();
  const completed = input.status === 'completed';
  await pool.query(
    `INSERT INTO sessions (id, program_id, rank, commune_key, scheduled_start, scheduled_end, price, status, started_at, completed_at, before_photo_file_ids, after_photo_file_ids, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
    [
      id,
      input.programId,
      input.rank,
      input.communeKey ?? 'cotonou',
      input.start,
      input.end,
      input.price ?? 10_000,
      input.status ?? 'to_assign',
      completed ? input.start : null,
      completed ? (input.completedAt ?? input.end) : null,
      completed ? [ids.next()] : [],
      completed ? [ids.next()] : [],
    ],
  );
  return id;
}

export interface AgentSeed {
  name: string;
  canLead?: boolean;
  /** Note moyenne (une note) ; absente : sans note. */
  rating?: number;
  zones?: string[];
  employmentKind?: 'employee' | 'independent';
  /** Congés : début et fin. */
  leaves?: { start: string; end: string }[];
}

/** Agent actif, disponible tous les jours toute la journée, toutes les compétences actives validées. */
export async function seedAgent(pool: Pool, seed: AgentSeed): Promise<string> {
  const id = ids.next();
  const supervisor = ids.next();
  await pool.query(
    `INSERT INTO agents (id, user_id, status, employment_kind, display_name, home_commune_key, can_lead, rating_sum, rating_count, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $4, 'cotonou', $5, $6, $7, now(), now())`,
    [
      id,
      ids.next(),
      seed.employmentKind ?? 'employee',
      seed.name,
      seed.canLead ?? false,
      seed.rating ?? 0,
      seed.rating === undefined ? 0 : 1,
    ],
  );
  await pool.query(
    `INSERT INTO agent_skills (agent_id, skill_code, status) SELECT $1, code, 'validated' FROM skills WHERE active`,
    [id],
  );
  for (const zone of seed.zones ?? ['cotonou']) {
    await pool.query('INSERT INTO agent_zones (agent_id, commune_key) VALUES ($1, $2)', [id, zone]);
  }
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await pool.query(
      `INSERT INTO availability_rules (id, agent_id, weekday, start_minute, end_minute, updated_by, updated_at)
       VALUES ($1, $2, $3, 0, 1440, $4, now())`,
      [ids.next(), id, weekday, supervisor],
    );
  }
  for (const leave of seed.leaves ?? []) {
    await pool.query(
      `INSERT INTO unavailabilities (id, agent_id, kind, starts_at, ends_at, reason, created_by, created_at)
       VALUES ($1, $2, 'unavailable', $3, $4, 'leave', $5, now())`,
      [ids.next(), id, leave.start, leave.end, supervisor],
    );
  }
  return id;
}

/** Affectation confirmée d'un agent à une séance (historique d'un programme). */
export async function seedAssignment(
  pool: Pool,
  input: { sessionId: string; agentId: string; start: string; end: string; isLead?: boolean },
): Promise<string> {
  const id = ids.next();
  await pool.query(
    `INSERT INTO assignments (id, target_kind, session_id, agent_id, is_lead, source, status, occupied_from, occupied_until, created_by, created_at)
     VALUES ($1, 'session', $2, $3, $4, 'manual', 'confirmed', $5, $6, $7, now())`,
    [id, input.sessionId, input.agentId, input.isLead ?? false, input.start, input.end, ids.next()],
  );
  return id;
}

/** Exécute dans le contexte d'un membre du personnel, double authentification faite, avec ses permissions. */
export function asStaffWith<T>(permissions: string[], fn: () => T, userId: string = ids.next()): T {
  return runWithContext(
    {
      correlationId: 'test',
      callerService: 'gateway',
      user: {
        userId,
        sessionId: 's',
        activeContext: 'personal',
        roles: [],
        permissions,
        mfa: true,
        authTime: Math.floor(Date.now() / 1000),
      },
    },
    fn,
  );
}

export const newId = () => ids.next();
