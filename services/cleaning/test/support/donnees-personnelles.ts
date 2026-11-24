import { type Pool } from 'pg';
import { newId } from './lot-g-seed';

/**
 * Jeu d'essai de la piste S (données personnelles) sur une vraie base : lieux, demandes, frais,
 * devis, visites et mouvements d'argent créés en SQL, sans passer par les cas d'usage des lots C et
 * E. Les colonnes chiffrées reçoivent un texte quelconque : les tests ne lisent que leur présence.
 * Le catalogue de démonstration doit être chargé (loadDemo).
 */
export const CIPHERTEXT = 'v1.test.chiffre';

async function placeTypeId(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ place_type_id: string }>(
    'SELECT place_type_id FROM offers ORDER BY id LIMIT 1',
  );
  return rows[0]!.place_type_id;
}

/** Lieu de « Mes lieux » avec position, repère, adresse saisie et adresse lisible. */
export async function seedPlace(
  pool: Pool,
  input: { ownerId: string; ownerKind?: 'user' | 'organization'; archivedAt?: string | null },
): Promise<string> {
  const id = newId();
  await pool.query(
    `INSERT INTO places (id, owner_kind, owner_id, place_type_id, name, gps_encrypted, landmark_encrypted, address_encrypted, readable_address_encrypted, commune_key, commune_boundaries_version, archived_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Maison', $5, $5, $5, $5, 'cotonou', 'test-1', $6, $3, now(), now())`,
    [
      id,
      input.ownerKind ?? 'user',
      input.ownerId,
      await placeTypeId(pool),
      CIPHERTEXT,
      input.archivedAt ?? null,
    ],
  );
  return id;
}

export interface SeededRequest {
  id: string;
  number: string;
}

/** Demande sur un lieu, avec sa copie chiffrée de la position (R-DM-08). */
export async function seedRequest(
  pool: Pool,
  input: {
    ownerId: string;
    ownerKind?: 'user' | 'organization';
    placeId: string;
    status: string;
    submittedBy?: string;
    closedAt?: string | null;
  },
): Promise<SeededRequest> {
  const id = newId();
  const { rows } = await pool.query<{ number: string }>(
    `INSERT INTO cleaning_requests (id, owner_kind, owner_id, submitted_by, place_id, place_type_id, commune_key, gps_encrypted, landmark_encrypted, address_encrypted, readable_address_encrypted, status, declared_values, schedule_plan, visit_slots, closed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'cotonou', $7, $7, $7, $7, $8, '{}', '{}', '[{"start":"2030-01-07T08:00:00.000Z","end":"2030-01-07T10:00:00.000Z"}]', $9, now(), now())
     RETURNING number`,
    [
      id,
      input.ownerKind ?? 'user',
      input.ownerId,
      input.submittedBy ?? input.ownerId,
      input.placeId,
      await placeTypeId(pool),
      CIPHERTEXT,
      input.status,
      input.closedAt ?? null,
    ],
  );
  return { id, number: rows[0]!.number };
}

/** Devis envoyé d'une demande « devis envoyé », valable jusqu'à `validUntil`. */
export async function seedSentQuote(pool: Pool, requestId: string, validUntil: string): Promise<string> {
  const id = newId();
  await pool.query(
    `INSERT INTO quotes (id, request_id, version, status, lines, session_price, sessions_count, total, team_size, duration_minutes, schedule_plan, valid_until, sent_at, created_by, created_at)
     VALUES ($1, $2, 1, 'sent', '{}', 10000, 1, 10000, 1, 120, '{}', $3, now(), $4, now())`,
    [id, requestId, validUntil, newId()],
  );
  return id;
}

/** Frais de visite d'une demande : payés, ou à payer avant `dueAt`. */
export async function seedVisitFee(
  pool: Pool,
  input: { requestId: string; rank?: number; dueAt?: string | null },
): Promise<string> {
  const id = newId();
  const awaiting = input.dueAt !== undefined && input.dueAt !== null;
  await pool.query(
    `INSERT INTO visit_fees (id, request_id, rank, amount, status, due_at, paid_at, created_at, updated_at)
     VALUES ($1, $2, $3, 5000, $4, $5, $6, now(), now())`,
    [
      id,
      input.requestId,
      input.rank ?? 1,
      awaiting ? 'awaiting_payment' : 'paid',
      awaiting ? input.dueAt : null,
      awaiting ? null : new Date().toISOString(),
    ],
  );
  return id;
}

/** Visite terminée (ou manquée, avec la photo du lieu) d'une demande, avec la position d'arrivée. */
export async function seedVisit(
  pool: Pool,
  input: {
    requestId: string;
    visitFeeId: string;
    start: string;
    attempt?: number;
    status?: 'completed' | 'missed';
    arrival?: boolean;
    photoFileIds?: string[];
    missedPhotoFileId?: string | null;
  },
): Promise<string> {
  const id = newId();
  const missed = input.status === 'missed';
  const end = new Date(new Date(input.start).getTime() + 3_600_000).toISOString();
  const arrival = input.arrival ?? true;
  await pool.query(
    `INSERT INTO visits (id, request_id, attempt, visit_fee_id, status, scheduled_start, scheduled_end, duration_minutes, arrived_at, arrival_gps_encrypted, arrival_distance_m, photo_file_ids, missed_photo_file_id, missed_at, completed_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 60, $8, $9, $10, $11, $12, $13, $14, $15, now(), now())`,
    [
      id,
      input.requestId,
      input.attempt ?? 1,
      input.visitFeeId,
      input.status ?? 'completed',
      input.start,
      end,
      arrival ? input.start : null,
      arrival ? CIPHERTEXT : null,
      arrival ? 42 : null,
      input.photoFileIds ?? [],
      input.missedPhotoFileId ?? null,
      missed ? end : null,
      missed ? null : end,
      newId(),
    ],
  );
  return id;
}

/** Affectation d'un agent à une visite. */
export async function seedVisitAssignment(
  pool: Pool,
  input: { visitId: string; agentId: string; start: string; end: string; status?: string },
): Promise<string> {
  const id = newId();
  const status = input.status ?? 'confirmed';
  await pool.query(
    `INSERT INTO assignments (id, target_kind, visit_id, agent_id, is_lead, source, status, occupied_from, occupied_until, created_by, created_at, removed_at, removal_reason)
     VALUES ($1, 'visit', $2, $3, false, 'manual', $4, $5, $6, $7, now(), $8, $9)`,
    [
      id,
      input.visitId,
      input.agentId,
      status,
      input.start,
      input.end,
      newId(),
      status === 'removed' ? input.start : null,
      status === 'removed' ? 'visit_cancelled' : null,
    ],
  );
  return id;
}

/** Débit du wallet resté « en cours » pour une séance (15.4). */
export async function seedPendingSessionDebit(
  pool: Pool,
  input: { ownerId: string; requestId: string; sessionId: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_operations (id, kind, purpose, idempotency_key, wallet_owner_kind, wallet_owner_id, amount, label, request_id, session_id, status, created_at)
     VALUES ($1, 'debit', 'session_payment', $2, 'user', $3, 10000, 'Nettoyage — séance', $4, $5, 'pending', now())`,
    [newId(), `cleaning_session:${input.sessionId}`, input.ownerId, input.requestId, input.sessionId],
  );
}

/** Paiement direct par Mobile Money des frais de visite, page ouverte jusqu'à `expiresAt`. */
export async function seedVisitFeePaymentPage(
  pool: Pool,
  input: {
    ownerId: string;
    requestId: string;
    visitFeeId: string;
    expiresAt: string | null;
    createdAt: string;
  },
): Promise<void> {
  const id = newId();
  await pool.query(
    `INSERT INTO direct_payments (id, idempotency_key, purpose, payer_kind, payer_id, amount, request_id, visit_fee_id, status, expires_at, created_at)
     VALUES ($1, $2, 'visit_fee', 'user', $3, 5000, $4, $5, 'pending', $6, $7)`,
    [
      id,
      `cleaning_visit_fee_mm:${id}`,
      input.ownerId,
      input.requestId,
      input.visitFeeId,
      input.expiresAt,
      input.createdAt,
    ],
  );
}

/** Facture mensuelle d'une organisation, connue par les événements de billing. */
export async function seedOrganizationInvoice(
  pool: Pool,
  organizationId: string,
  standing: 'overdue' | 'paid',
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_invoices (invoice_id, organization_id, standing, updated_at) VALUES ($1, $2, $3, now())`,
    [newId(), organizationId, standing],
  );
}
