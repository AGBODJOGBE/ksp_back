import { type Zone } from '../src/application/catalog/catalog.ports';
import { DuplicateKeyError } from '../src/application/ports';
import { countOpenRequests } from '../src/domain/requests/request-status';
import { PrismaZoneRepository } from '../src/infrastructure/persistence/catalog/prisma-zone.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/** Zones desservies sur un vrai PostgreSQL : une par commune, activité lue avant désactivation. */
describeWithDatabase('PrismaZoneRepository (PostgreSQL)', () => {
  let db: TestDatabase;
  let zones: PrismaZoneRepository;
  const ids = new UuidV7Generator();
  const at = new Date('2026-11-20T10:00:00.000Z');
  const actor = '0192f1c4-0000-7000-8000-00000000ad01';
  const owner = '0192f1c4-0000-7000-8000-00000000c001';
  const none = { events: [], audit: [] };

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_zones');
    zones = new PrismaZoneRepository(db.prisma, ids);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const zone = (patch: Partial<Zone> = {}): Zone => ({
    id: ids.next(),
    communeKey: 'cotonou',
    name: 'Cotonou',
    coefficientBps: 10_000,
    visitFeeSurcharge: null,
    planningMode: null,
    active: true,
    updatedAt: at,
    updatedBy: actor,
    ...patch,
  });

  it('zone : créée, relue par identifiant et par commune, modifiée ; une par commune', async () => {
    const cotonou = zone();
    await zones.saveZone(cotonou, 'create', {
      events: [],
      audit: [{ actorId: actor, action: 'zone.created', entityType: 'zone', entityId: cotonou.id, at }],
    });
    expect(await zones.getZone(cotonou.id)).toEqual(cotonou);
    expect(await zones.findByCommune('cotonou')).toEqual(cotonou);
    const updated = {
      ...cotonou,
      coefficientBps: 11_000,
      visitFeeSurcharge: 1000,
      planningMode: 'automatic' as const,
    };
    await zones.saveZone(updated, 'update', none);
    expect(await zones.getZone(cotonou.id)).toEqual(updated);
    await expect(zones.saveZone(zone(), 'create', none)).rejects.toEqual(new DuplicateKeyError('code'));
    expect(await zones.findByCommune('parakou')).toBeNull();
    expect(await zones.getZone('x')).toBeNull();
    expect(await db.prisma.auditEntry.count()).toBe(1);
  });

  it('activité : demandes peut-être ouvertes avec leurs échéances, programmes en cours', async () => {
    const category = ids.next();
    const placeType = ids.next();
    const area = ids.next();
    const place = ids.next();
    await db.pool.query(
      `INSERT INTO parameters (id, code, label, kind, unit, created_at, updated_at) VALUES ($1, 'surface', 'Surface', 'number', 'm²', now(), now())`,
      [area],
    );
    await db.pool.query(
      `INSERT INTO place_categories (id, code, name, icon, created_at, updated_at) VALUES ($1, 'maison', 'Maison', '', now(), now())`,
      [category],
    );
    await db.pool.query(
      `INSERT INTO place_types (id, category_id, code, name, icon, area_parameter_id, created_at, updated_at)
       VALUES ($1, $2, 'villa', 'Villa', '', $3, now(), now())`,
      [placeType, category, area],
    );
    await db.pool.query(
      `INSERT INTO places (id, owner_kind, owner_id, place_type_id, name, commune_key, gps_encrypted, landmark_encrypted, declared_values, created_by, created_at, updated_at)
       VALUES ($1, 'user', $2, $3, 'Maison', 'cotonou', 'v1.x', 'v1.y', '{}', $2, now(), now())`,
      [place, owner, placeType],
    );
    const request = async (status: string) => {
      const id = ids.next();
      await db.pool.query(
        `INSERT INTO cleaning_requests (id, owner_kind, owner_id, submitted_by, place_id, place_type_id, commune_key, status,
           gps_encrypted, landmark_encrypted, declared_values, schedule_plan, visit_slots, created_at, updated_at)
         VALUES ($1, 'user', $2, $2, $3, $4, 'cotonou', $5, 'v1.x', 'v1.y', '{}', '{}',
           '[{"start":"2026-12-01T08:00:00Z","end":"2026-12-01T10:00:00Z"}]', now(), now())`,
        [id, owner, place, placeType, status],
      );
      return id;
    };
    await request('visit_scheduled');
    await request('accepted');
    const awaiting = await request('awaiting_visit_fee');
    await db.pool.query(
      `INSERT INTO visit_fees (id, request_id, rank, amount, status, due_at, created_at, updated_at)
       VALUES ($1, $2, 1, 5000, 'awaiting_payment', '2026-11-19T10:00:00Z', now(), now())`,
      [ids.next(), awaiting],
    );
    const quoted = await request('quote_sent');
    const quote = ids.next();
    await db.pool.query(
      `INSERT INTO quotes (id, request_id, version, status, lines, session_price, sessions_count, total, team_size, duration_minutes,
         schedule_plan, sent_at, valid_until, created_by, created_at)
       VALUES ($1, $2, 1, 'sent', '[]', 10000, 1, 10000, 1, 60, '{}', now(), '2026-12-05T00:00:00Z', $3, now())`,
      [quote, quoted, actor],
    );
    await db.pool.query(
      `INSERT INTO programs (id, request_id, quote_id, owner_kind, owner_id, payer_kind, place_id, commune_key, session_price,
         team_size, duration_minutes, schedule_plan, created_at, updated_at)
       VALUES ($1, $2, $3, 'user', $4, 'individual', $5, 'cotonou', 10000, 1, 60, '{}', now(), now())`,
      [ids.next(), quoted, quote, owner, place],
    );

    const activity = await zones.activityOf(['cotonou', 'parakou']);
    const cotonou = activity.get('cotonou')!;
    expect(cotonou.requests).toHaveLength(3);
    expect(cotonou.requests).toContainEqual({
      status: 'awaiting_visit_fee',
      sentQuoteValidUntil: null,
      pendingVisitFeeDueAt: new Date('2026-11-19T10:00:00Z'),
    });
    expect(countOpenRequests(cotonou.requests, at)).toBe(2);
    expect(cotonou.activePrograms).toBe(1);
    expect(activity.get('parakou')).toEqual({ requests: [], activePrograms: 0 });
  });
});
