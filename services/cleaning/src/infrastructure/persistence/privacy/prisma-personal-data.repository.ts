import { type SqlExecutor, SqlInboxStore, type TransactionalSqlClient } from '@ksp/platform';
import {
  type AccountErasure,
  type ExpiredPhotos,
  type PersonalDataRepository,
  type ProcessedEventRef,
  type RequestPurgeLot,
  type SessionPurgeLot,
  type StoredObligations,
} from '../../../application/privacy/privacy.ports';
import { type Owner } from '../../../application/requests/requests.ports';
import { type AssignmentFact, type MoneySubject } from '../../../domain/privacy/obligations';
import { type PrismaService } from '../../prisma/prisma.service';
import { IN_FORCE } from '../planning/planning-rows';

/** Programme fini (partie 15.2) et séance close (partie 8) : le reste est encore en cours. */
const TERMINAL_PROGRAM_STATUSES = ['completed', 'cancelled'] as const;
const CLOSED_SESSION_STATUSES = ['completed', 'missed', 'cancelled'] as const;
/** Séance impayée d'un particulier (partie 11.1). */
const UNPAID_STATUSES = ['due', 'overdue'] as const;

/** Numéro lisible d'une demande (DN-…) ou d'un programme (PN-…). */
const NUMBER = { select: { number: true } } as const;
const SESSION_PROGRAM = { select: { program: NUMBER } } as const;

/** Dossier visé par un mouvement d'argent : le programme de la séance, sinon la demande. */
function moneySubject(row: {
  request: { number: string } | null;
  session: { program: { number: string } } | null;
  claim?: { session: { program: { number: string } } } | null;
}): MoneySubject {
  const program = row.session?.program.number ?? row.claim?.session.program.number;
  if (program) return { subject: 'program', reference: program };
  return row.request
    ? { subject: 'request', reference: row.request.number }
    : { subject: null, reference: null };
}

/**
 * Effacement d'une position de lieu ou de dossier (contraintes *_location_erased_check) : position,
 * repère, adresse saisie et adresse lisible ensemble, date d'effacement, version + 1 pour qu'une
 * écriture concurrente partie d'une lecture plus ancienne soit refusée au lieu de les réécrire. La
 * commune reste.
 */
const LOCATION_COLUMNS =
  'gps_encrypted = NULL, landmark_encrypted = NULL, address_encrypted = NULL, ' +
  'readable_address_encrypted = NULL';
const ERASE_LOCATION = `${LOCATION_COLUMNS}, location_erased_at = $2::timestamptz, version = version + 1`;
/** Position d'arrivée d'un agent ; la distance d'arrivée reste. */
const ERASE_ARRIVAL = 'arrival_gps_encrypted = NULL, version = version + 1';
/** Lieux et demandes personnels d'un compte ($1) : jamais ceux d'une organisation. */
const PERSONAL_OWNER = "owner_kind = 'user' AND owner_id = $1::uuid";
/** Visites ou séances auxquelles l'agent du compte ($1) a été affecté, quel que soit le statut. */
const agentTargets = (column: 'visit_id' | 'session_id') =>
  `SELECT a.${column} FROM assignments a JOIN agents g ON g.id = a.agent_id ` +
  `WHERE g.user_id = $1::uuid AND a.${column} IS NOT NULL`;

// --- Purge par durée de conservation (R-DP-01). $1 : date limite, maintenant − N mois. -----------

/** Clé du verrou consultatif de la purge (UC-NT-48), propre à cleaning. */
export const RETENTION_PURGE_LOCK = 54_054_048;
/** Durée maximale d'un passage, verrou compris. */
const PURGE_PASS_TIMEOUT_MS = 10 * 60_000;
/** Une transaction de lot attend au plus 10 s son tour et dure au plus 60 s. */
const LOT_TRANSACTION = { maxWait: 10_000, timeout: 60_000 };

/** Séance `s` encore à venir : ni réalisée, ni manquée, ni annulée (partie 8). */
const OPEN_SESSION = "s.status NOT IN ('completed', 'missed', 'cancelled')";
/** Demande `r` encore ouverte : ni close, ni acceptée (un dossier accepté vit par son programme). */
const OPEN_REQUEST = "r.status NOT IN ('accepted', 'declined', 'expired', 'cancelled', 'rejected')";
/**
 * Programme `p` fini ou annulé avant la limite, sans séance encore à venir (une repasse gratuite
 * peut s'ajouter à un programme terminé, R-RC-03). Le départ est sa fin ou son annulation, jamais sa
 * dernière modification.
 */
const ENDED_PROGRAM =
  "(p.status IN ('completed', 'cancelled') " +
  "AND (CASE p.status WHEN 'completed' THEN p.completed_at ELSE p.cancelled_at END) < $1::timestamptz " +
  `AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.program_id = p.id AND ${OPEN_SESSION}))`;
/**
 * Dossier `r` clos avant la limite : demande close (refusée, expirée, annulée) sans réactivation en
 * attente, ou demande acceptée ; dans les deux cas, plus aucun programme qui ne soit fini avant la
 * limite. Pour une demande acceptée, la clôture du dossier est donc la fin de son dernier programme.
 */
const CLOSED_REQUEST =
  '((r.closed_at < $1::timestamptz AND NOT EXISTS (' +
  "SELECT 1 FROM request_reactivations x WHERE x.request_id = r.id AND x.status = 'pending')) " +
  "OR (r.status = 'accepted' AND EXISTS (SELECT 1 FROM programs p WHERE p.request_id = r.id))) " +
  `AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.request_id = r.id AND ${ENDED_PROGRAM} IS NOT TRUE)`;

/** Visite `v` ou séance `t` qui porte encore des photos (prédicats des index partiels de la purge). */
const VISIT_HAS_PHOTOS = '(cardinality(v.photo_file_ids) > 0 OR v.missed_photo_file_id IS NOT NULL)';
const SESSION_HAS_PHOTOS =
  '(cardinality(t.before_photo_file_ids) > 0 OR cardinality(t.after_photo_file_ids) > 0 ' +
  'OR t.missed_photo_file_id IS NOT NULL)';

/** La cible porte une photo qui n'a pas été supprimée chez file : la transaction est annulée. */
class PhotosChangedError extends Error {
  override readonly name = 'PhotosChangedError';
}

/** Identifiants présents, sans doublon. */
function distinct(ids: readonly (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/**
 * Données personnelles de cleaning (partie 16.3). Les lectures des obligations ne prennent aucun
 * verrou et n'écrivent rien ; une erreur de la base remonte telle quelle. Les effacements ne visent
 * que les lignes qui portent encore une donnée : rejoués, ils n'écrivent rien.
 */
export class PrismaPersonalDataRepository implements PersonalDataRepository {
  private readonly inbox: SqlInboxStore;

  constructor(private readonly prisma: PrismaService) {
    this.inbox = new SqlInboxStore(prisma as unknown as TransactionalSqlClient);
  }

  async storedObligations(holder: Owner, agentUserId: string | null, now: Date): Promise<StoredObligations> {
    const owner = { ownerKind: holder.kind, ownerId: holder.id };
    const openSession = { status: { notIn: [...CLOSED_SESSION_STATUSES] } };
    const [programs, sessions, operations, payments, overdueInvoices, assignments] = await Promise.all([
      this.prisma.program.findMany({
        where: {
          ...owner,
          OR: [{ status: { notIn: [...TERMINAL_PROGRAM_STATUSES] } }, { sessions: { some: openSession } }],
        },
        select: { number: true, status: true, _count: { select: { sessions: { where: openSession } } } },
      }),
      this.prisma.session.findMany({
        where: { paymentStatus: { in: [...UNPAID_STATUSES] }, program: owner },
        select: { rank: true, program: NUMBER },
      }),
      this.prisma.walletOperation.findMany({
        where: { status: 'pending', walletOwnerKind: holder.kind, walletOwnerId: holder.id },
        select: {
          request: NUMBER,
          session: SESSION_PROGRAM,
          claim: { select: { session: SESSION_PROGRAM } },
        },
      }),
      this.prisma.directPayment.findMany({
        where: { status: 'pending', payerKind: holder.kind, payerId: holder.id },
        select: { createdAt: true, expiresAt: true, request: NUMBER, session: SESSION_PROGRAM },
      }),
      holder.kind === 'organization'
        ? this.prisma.organizationInvoice.count({ where: { organizationId: holder.id, standing: 'overdue' } })
        : Promise.resolve(0),
      agentUserId
        ? this.prisma.assignment.findMany({
            where: { agent: { userId: agentUserId }, status: { in: IN_FORCE }, occupiedUntil: { gt: now } },
            select: {
              status: true,
              responseDueAt: true,
              occupiedUntil: true,
              session: SESSION_PROGRAM,
              visit: { select: { request: NUMBER } },
            },
          })
        : Promise.resolve([]),
    ]);
    return {
      programs: programs.map((row) => ({
        number: row.number,
        status: row.status,
        openSessions: row._count.sessions,
      })),
      unpaidSessions: sessions.map((row) => ({ programNumber: row.program.number, rank: row.rank })),
      walletOperations: operations.map(moneySubject),
      directPayments: payments.map((row) => ({
        ...moneySubject(row),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      })),
      overdueInvoices,
      assignments: assignments.flatMap((row): AssignmentFact[] => {
        const state = { status: row.status, respondBefore: row.responseDueAt, end: row.occupiedUntil };
        if (row.session) return [{ ...state, target: 'session', reference: row.session.program.number }];
        return row.visit ? [{ ...state, target: 'visit', reference: row.visit.request.number }] : [];
      }),
    };
  }

  /**
   * Ordre des écritures : les demandes avant leurs visites et avant les lieux, comme l'écriture d'un
   * dossier (verrou de la demande d'abord). Une visite est réécrite en entier avec son dossier : la
   * version de sa demande augmente avant l'effacement de sa position d'arrivée.
   */
  async eraseAccount(userId: string, event: ProcessedEventRef, now: Date): Promise<AccountErasure> {
    const erased = { places: 0, requests: 0, visitArrivals: 0, sessionArrivals: 0, agentProfiles: 0 };
    const at = now.toISOString();
    const status = await this.inbox.runOnce(event.eventId, event.consumer, async (tx: SqlExecutor) => {
      erased.requests = await tx.$executeRawUnsafe(
        `UPDATE cleaning_requests SET ${ERASE_LOCATION} WHERE location_erased_at IS NULL AND id IN (` +
          `SELECT id FROM cleaning_requests WHERE ${PERSONAL_OWNER} ` +
          `UNION SELECT r.id FROM cleaning_requests r JOIN places p ON p.id = r.place_id ` +
          `WHERE p.owner_kind = 'user' AND p.owner_id = $1::uuid)`,
        userId,
        at,
      );
      await tx.$executeRawUnsafe(
        'UPDATE cleaning_requests SET version = version + 1 WHERE id IN (' +
          `SELECT v.request_id FROM visits v WHERE v.arrival_gps_encrypted IS NOT NULL ` +
          `AND v.id IN (${agentTargets('visit_id')}))`,
        userId,
      );
      erased.visitArrivals = await tx.$executeRawUnsafe(
        `UPDATE visits SET ${ERASE_ARRIVAL} WHERE arrival_gps_encrypted IS NOT NULL ` +
          `AND id IN (${agentTargets('visit_id')})`,
        userId,
      );
      erased.sessionArrivals = await tx.$executeRawUnsafe(
        `UPDATE sessions SET ${ERASE_ARRIVAL} WHERE arrival_gps_encrypted IS NOT NULL ` +
          `AND id IN (${agentTargets('session_id')})`,
        userId,
      );
      erased.places = await tx.$executeRawUnsafe(
        `UPDATE places SET ${ERASE_LOCATION} WHERE ${PERSONAL_OWNER} AND location_erased_at IS NULL`,
        userId,
        at,
      );
      erased.agentProfiles = await tx.$executeRawUnsafe(
        'UPDATE agents SET id_document_encrypted = NULL, emergency_contact_encrypted = NULL, ' +
          'mobile_money_encrypted = NULL, version = version + 1 WHERE user_id = $1::uuid ' +
          'AND (id_document_encrypted IS NOT NULL OR emergency_contact_encrypted IS NOT NULL ' +
          'OR mobile_money_encrypted IS NOT NULL)',
        userId,
      );
    });
    return status === 'duplicate'
      ? { status, places: 0, requests: 0, visitArrivals: 0, sessionArrivals: 0, agentProfiles: 0 }
      : { status, ...erased };
  }

  /**
   * Verrou consultatif de transaction : tenu par la connexion de la transaction pendant tout le
   * passage, rendu à sa fin (même en cas d'erreur). Une seconde réplique ne l'obtient pas et passe.
   */
  async withPurgeLock(work: () => Promise<void>): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${RETENTION_PURGE_LOCK}::bigint) AS locked`;
        if (!row?.locked) return false;
        await work();
        return true;
      },
      { maxWait: 10_000, timeout: PURGE_PASS_TIMEOUT_MS },
    );
  }

  /**
   * Un lot de dossiers clos avant la limite qui portent encore une position : la copie de la demande
   * ou la position d'arrivée d'une visite. Les demandes du lot sont verrouillées avant toute
   * écriture (les lignes déjà prises par un autre appel attendent le lot suivant) ; leur version
   * augmente, car une visite est réécrite en entier avec son dossier.
   */
  async purgeRequestLocations(cutoff: Date, now: Date, limit: number): Promise<RequestPurgeLot> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string; has_copy: boolean }[]>(
        'SELECT r.id, (r.location_erased_at IS NULL) AS has_copy FROM cleaning_requests r ' +
          `WHERE ${CLOSED_REQUEST} AND (r.location_erased_at IS NULL OR EXISTS (` +
          'SELECT 1 FROM visits v WHERE v.request_id = r.id AND v.arrival_gps_encrypted IS NOT NULL)) ' +
          'LIMIT $2 FOR NO KEY UPDATE OF r SKIP LOCKED',
        cutoff.toISOString(),
        limit,
      );
      if (rows.length === 0) return { taken: 0, requests: 0, visitArrivals: 0 };
      const ids = rows.map((row) => row.id);
      const visitArrivals = await tx.$executeRawUnsafe(
        `UPDATE visits SET ${ERASE_ARRIVAL} WHERE request_id = ANY($1::uuid[]) ` +
          'AND arrival_gps_encrypted IS NOT NULL',
        ids,
      );
      await tx.$executeRawUnsafe(
        `UPDATE cleaning_requests SET ${LOCATION_COLUMNS}, ` +
          'location_erased_at = COALESCE(location_erased_at, $2::timestamptz), version = version + 1 ' +
          'WHERE id = ANY($1::uuid[])',
        ids,
        now.toISOString(),
      );
      return { taken: rows.length, requests: rows.filter((row) => row.has_copy).length, visitArrivals };
    }, LOT_TRANSACTION);
  }

  /** Un lot de programmes finis avant la limite, verrouillés comme pour toute décision sur leurs séances. */
  async purgeSessionArrivals(cutoff: Date, limit: number): Promise<SessionPurgeLot> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT p.id FROM programs p WHERE ${ENDED_PROGRAM} AND EXISTS (` +
          'SELECT 1 FROM sessions a WHERE a.program_id = p.id AND a.arrival_gps_encrypted IS NOT NULL) ' +
          'LIMIT $2 FOR NO KEY UPDATE OF p SKIP LOCKED',
        cutoff.toISOString(),
        limit,
      );
      if (rows.length === 0) return { taken: 0, sessionArrivals: 0 };
      const sessionArrivals = await tx.$executeRawUnsafe(
        `UPDATE sessions SET ${ERASE_ARRIVAL} WHERE program_id = ANY($1::uuid[]) ` +
          'AND arrival_gps_encrypted IS NOT NULL',
        rows.map((row) => row.id),
      );
      return { taken: rows.length, sessionArrivals };
    }, LOT_TRANSACTION);
  }

  /** Un lot de lieux archivés avant la limite, que plus aucun dossier en cours n'utilise. */
  purgePlaceLocations(cutoff: Date, now: Date, limit: number): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      `UPDATE places SET ${ERASE_LOCATION} WHERE id IN (` +
        'SELECT l.id FROM places l WHERE l.archived_at < $1::timestamptz AND l.location_erased_at IS NULL ' +
        `AND NOT EXISTS (SELECT 1 FROM cleaning_requests r WHERE r.place_id = l.id AND ${OPEN_REQUEST}) ` +
        'AND NOT EXISTS (SELECT 1 FROM programs p WHERE p.place_id = l.id ' +
        "AND (p.status NOT IN ('completed', 'cancelled') " +
        `OR EXISTS (SELECT 1 FROM sessions s WHERE s.program_id = p.id AND ${OPEN_SESSION}))) ` +
        'LIMIT $3 FOR NO KEY UPDATE OF l SKIP LOCKED)',
      cutoff.toISOString(),
      now.toISOString(),
      limit,
    );
  }

  async expiredVisitPhotos(cutoff: Date, limit: number): Promise<ExpiredPhotos[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      { id: string; photo_file_ids: string[] | null; missed_photo_file_id: string | null }[]
    >(
      'SELECT v.id, v.photo_file_ids, v.missed_photo_file_id ' +
        'FROM visits v JOIN cleaning_requests r ON r.id = v.request_id ' +
        `WHERE ${VISIT_HAS_PHOTOS} AND ${CLOSED_REQUEST} LIMIT $2`,
      cutoff.toISOString(),
      limit,
    );
    return rows.map((row) => ({
      subject: { type: 'cleaning_visit', id: row.id },
      fileIds: distinct([...(row.photo_file_ids ?? []), row.missed_photo_file_id]),
    }));
  }

  async expiredSessionPhotos(cutoff: Date, limit: number): Promise<ExpiredPhotos[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        id: string;
        before_photo_file_ids: string[] | null;
        after_photo_file_ids: string[] | null;
        missed_photo_file_id: string | null;
        incident_photo_file_ids: string[] | null;
      }[]
    >(
      'SELECT t.id, t.before_photo_file_ids, t.after_photo_file_ids, t.missed_photo_file_id, ' +
        'ARRAY(SELECT unnest(i.photo_file_ids) FROM session_incidents i WHERE i.session_id = t.id) ' +
        'AS incident_photo_file_ids ' +
        'FROM sessions t JOIN programs p ON p.id = t.program_id ' +
        `WHERE (${SESSION_HAS_PHOTOS} OR EXISTS (SELECT 1 FROM session_incidents i ` +
        'WHERE i.session_id = t.id AND cardinality(i.photo_file_ids) > 0)) ' +
        `AND ${ENDED_PROGRAM} AND NOT EXISTS (SELECT 1 FROM claims c ` +
        "WHERE c.session_id = t.id AND c.status IN ('open', 'in_progress')) LIMIT $2",
      cutoff.toISOString(),
      limit,
    );
    return rows.map((row) => ({
      subject: { type: 'cleaning_session', id: row.id },
      fileIds: distinct([
        ...(row.before_photo_file_ids ?? []),
        ...(row.after_photo_file_ids ?? []),
        row.missed_photo_file_id,
        ...(row.incident_photo_file_ids ?? []),
      ]),
    }));
  }

  /**
   * Les références ne sont retirées que si la cible ne porte aucune autre photo que celles
   * supprimées chez file ; sinon rien n'est écrit. Visite : la demande d'abord (sa version augmente,
   * car une visite est réécrite avec son dossier). Séance : le programme verrouillé d'abord, comme
   * pour toute décision sur ses séances.
   */
  async erasePhotoReferences(photos: ExpiredPhotos, now: Date): Promise<boolean> {
    const { id } = photos.subject;
    const at = now.toISOString();
    try {
      await this.prisma.$transaction(async (tx) => {
        if (photos.subject.type === 'cleaning_visit') {
          await tx.$executeRawUnsafe(
            'UPDATE cleaning_requests SET version = version + 1 ' +
              'WHERE id = (SELECT request_id FROM visits WHERE id = $1::uuid)',
            id,
          );
          const erased = await tx.$executeRawUnsafe(
            "UPDATE visits SET photo_file_ids = '{}', missed_photo_file_id = NULL, " +
              'photos_erased_at = $3::timestamptz, version = version + 1 WHERE id = $1::uuid ' +
              'AND photo_file_ids <@ $2::uuid[] ' +
              'AND (missed_photo_file_id IS NULL OR missed_photo_file_id = ANY($2::uuid[]))',
            id,
            photos.fileIds,
            at,
          );
          if (erased !== 1) throw new PhotosChangedError();
          return;
        }
        await tx.$queryRawUnsafe(
          'SELECT p.id FROM programs p WHERE p.id = (SELECT program_id FROM sessions WHERE id = $1::uuid) ' +
            'FOR NO KEY UPDATE',
          id,
        );
        const erased = await tx.$executeRawUnsafe(
          "UPDATE sessions SET before_photo_file_ids = '{}', after_photo_file_ids = '{}', " +
            'missed_photo_file_id = NULL, photos_erased_at = $3::timestamptz, version = version + 1 ' +
            'WHERE id = $1::uuid AND before_photo_file_ids <@ $2::uuid[] ' +
            'AND after_photo_file_ids <@ $2::uuid[] ' +
            'AND (missed_photo_file_id IS NULL OR missed_photo_file_id = ANY($2::uuid[])) ' +
            'AND NOT EXISTS (SELECT 1 FROM session_incidents i WHERE i.session_id = sessions.id ' +
            'AND NOT (i.photo_file_ids <@ $2::uuid[]))',
          id,
          photos.fileIds,
          at,
        );
        if (erased !== 1) throw new PhotosChangedError();
        await tx.$executeRawUnsafe(
          "UPDATE session_incidents SET photo_file_ids = '{}' " +
            'WHERE session_id = $1::uuid AND cardinality(photo_file_ids) > 0',
          id,
        );
      }, LOT_TRANSACTION);
      return true;
    } catch (error) {
      if (error instanceof PhotosChangedError) return false;
      throw error;
    }
  }

  purgeIdempotencyRecords(before: Date, limit: number): Promise<number> {
    return this.prisma.$executeRawUnsafe(
      'DELETE FROM idempotency_records WHERE (actor_id, operation, idempotency_key) IN (' +
        'SELECT actor_id, operation, idempotency_key FROM idempotency_records ' +
        'WHERE created_at < $1::timestamptz LIMIT $2)',
      before.toISOString(),
      limit,
    );
  }
}
