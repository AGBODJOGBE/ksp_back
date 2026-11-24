import { type PrismaService } from '../../prisma/prisma.service';
import { PrismaPersonalDataRepository } from './prisma-personal-data.repository';

/**
 * Dépôt des données personnelles sur un faux client : ordre des écritures, comptes rendus et
 * correspondances, sans base. Le SQL lui-même est éprouvé par test/donnees-personnelles.int.spec.ts.
 */
const NOW = new Date('2030-06-03T08:00:00Z');
const CUTOFF = new Date('2029-06-03T08:00:00Z');

interface Statement {
  sql: string;
  values: unknown[];
}

/** Faux client : garde chaque requête ; `answer` rend les lignes lues ou le nombre de lignes écrites. */
function fakeClient(answer: (sql: string) => unknown = () => 1) {
  const statements: Statement[] = [];
  const transactions = { opened: 0, rolledBack: 0 };
  const client = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions.opened += 1;
      try {
        return await work(client);
      } catch (error) {
        transactions.rolledBack += 1;
        throw error;
      }
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: strings.join('?'), values });
      return answer(strings.join('?'));
    },
    $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
      statements.push({ sql, values });
      return answer(sql);
    },
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) => {
      statements.push({ sql, values });
      return answer(sql);
    },
  };
  const tables = () =>
    statements.map(({ sql }) => /^(?:UPDATE|INSERT INTO|DELETE FROM) (\w+)/.exec(sql)?.[1]);
  return {
    repository: new PrismaPersonalDataRepository(client as unknown as PrismaService),
    statements,
    tables,
    transactions,
  };
}

describe('PrismaPersonalDataRepository (faux client)', () => {
  describe('eraseAccount (R-DP-02)', () => {
    it('une transaction : marque d’inbox, puis demandes, visites, séances, lieux et fiche d’agent', async () => {
      const { repository, statements, tables, transactions } = fakeClient((sql) =>
        sql.startsWith('UPDATE places') ? 2 : sql.startsWith('UPDATE visits') ? 3 : 1,
      );
      const outcome = await repository.eraseAccount('u1', { eventId: 'e1', consumer: 'c1' }, NOW);
      expect(outcome).toEqual({
        status: 'processed',
        places: 2,
        requests: 1,
        visitArrivals: 3,
        sessionArrivals: 1,
        agentProfiles: 1,
      });
      expect(transactions).toEqual({ opened: 1, rolledBack: 0 });
      // La demande d'une visite est écrite (version + 1) avant la visite ; les lieux après les demandes.
      expect(tables()).toEqual([
        'processed_events',
        'cleaning_requests',
        'cleaning_requests',
        'visits',
        'sessions',
        'places',
        'agents',
      ]);
      expect(statements[0]?.values).toEqual(['e1', 'c1']);
      // Seuls les lieux et les demandes personnels, et seulement ce qui porte encore une donnée.
      for (const { sql } of statements.slice(1)) {
        expect(sql).toMatch(/IS (NOT )?NULL/);
        expect(sql).not.toContain("'organization'");
      }
      expect(statements[5]?.sql).toContain("owner_kind = 'user' AND owner_id = $1::uuid");
      expect(statements[5]?.values).toEqual(['u1', NOW.toISOString()]);
      // La commune et la distance d'arrivée ne sont jamais écrites.
      expect(statements.map(({ sql }) => sql).join(' ')).not.toMatch(/commune_key|arrival_distance_m/);
    });

    it('événement déjà traité : aucune écriture, compte rendu à zéro', async () => {
      const { repository, tables } = fakeClient((sql) =>
        sql.startsWith('INSERT INTO processed_events') ? 0 : 5,
      );
      await expect(repository.eraseAccount('u1', { eventId: 'e1', consumer: 'c1' }, NOW)).resolves.toEqual({
        status: 'duplicate',
        places: 0,
        requests: 0,
        visitArrivals: 0,
        sessionArrivals: 0,
        agentProfiles: 0,
      });
      expect(tables()).toEqual(['processed_events']);
    });

    it('une écriture en échec annule la transaction, marque d’inbox comprise', async () => {
      const { repository, transactions } = fakeClient((sql) => {
        if (sql.startsWith('UPDATE agents')) throw new Error('panne');
        return 1;
      });
      await expect(repository.eraseAccount('u1', { eventId: 'e1', consumer: 'c1' }, NOW)).rejects.toThrow(
        'panne',
      );
      expect(transactions).toEqual({ opened: 1, rolledBack: 1 });
    });
  });

  describe('purge par durée de conservation (R-DP-01)', () => {
    it('verrou du passage : le travail ne s’exécute que s’il est pris', async () => {
      const taken = fakeClient(() => [{ locked: true }]);
      const work = jest.fn(async () => undefined);
      await expect(taken.repository.withPurgeLock(work)).resolves.toBe(true);
      expect(work).toHaveBeenCalledTimes(1);
      expect(taken.statements[0]).toEqual({
        sql: 'SELECT pg_try_advisory_xact_lock(?::bigint) AS locked',
        values: [54_054_048],
      });
      const busy = fakeClient(() => [{ locked: false }]);
      await expect(busy.repository.withPurgeLock(work)).resolves.toBe(false);
      expect(work).toHaveBeenCalledTimes(1);
    });

    it('dossiers clos : demandes verrouillées, visites puis demandes écrites ; copies déjà effacées non comptées', async () => {
      const { repository, statements, tables } = fakeClient((sql) =>
        sql.startsWith('SELECT')
          ? [
              { id: 'r1', has_copy: true },
              { id: 'r2', has_copy: false },
            ]
          : 4,
      );
      await expect(repository.purgeRequestLocations(CUTOFF, NOW, 200)).resolves.toEqual({
        taken: 2,
        requests: 1,
        visitArrivals: 4,
      });
      expect(statements[0]?.sql).toMatch(/LIMIT \$2 FOR NO KEY UPDATE OF r SKIP LOCKED$/);
      expect(statements[0]?.values).toEqual([CUTOFF.toISOString(), 200]);
      expect(tables().slice(1)).toEqual(['visits', 'cleaning_requests']);
      expect(statements[2]?.sql).toContain('COALESCE(location_erased_at, $2::timestamptz)');
      expect(statements[2]?.values).toEqual([['r1', 'r2'], NOW.toISOString()]);
    });

    it('lot vide : rien n’est écrit', async () => {
      const { repository, statements } = fakeClient((sql) => (sql.startsWith('SELECT') ? [] : 9));
      await expect(repository.purgeRequestLocations(CUTOFF, NOW, 200)).resolves.toEqual({
        taken: 0,
        requests: 0,
        visitArrivals: 0,
      });
      await expect(repository.purgeSessionArrivals(CUTOFF, 200)).resolves.toEqual({
        taken: 0,
        sessionArrivals: 0,
      });
      expect(statements.every(({ sql }) => sql.startsWith('SELECT'))).toBe(true);
    });

    it('programmes finis : verrouillés, puis arrivées de leurs séances effacées', async () => {
      const { repository, statements } = fakeClient((sql) => (sql.startsWith('SELECT') ? [{ id: 'p1' }] : 6));
      await expect(repository.purgeSessionArrivals(CUTOFF, 200)).resolves.toEqual({
        taken: 1,
        sessionArrivals: 6,
      });
      expect(statements[0]?.sql).toMatch(/FOR NO KEY UPDATE OF p SKIP LOCKED$/);
      expect(statements[1]).toEqual({
        sql: expect.stringContaining(
          'UPDATE sessions SET arrival_gps_encrypted = NULL, version = version + 1',
        ),
        values: [['p1']],
      });
    });

    it('lieux archivés et clés d’idempotence : un lot conditionnel, date limite et taille du lot', async () => {
      const { repository, statements } = fakeClient(() => 3);
      await expect(repository.purgePlaceLocations(CUTOFF, NOW, 200)).resolves.toBe(3);
      await expect(repository.purgeIdempotencyRecords(CUTOFF, 200)).resolves.toBe(3);
      expect(statements[0]?.sql).toContain(
        'l.archived_at < $1::timestamptz AND l.location_erased_at IS NULL',
      );
      expect(statements[0]?.values).toEqual([CUTOFF.toISOString(), NOW.toISOString(), 200]);
      expect(statements[1]?.values).toEqual([CUTOFF.toISOString(), 200]);
    });

    it('photos expirées : toutes celles de la cible, sans doublon, incidents compris', async () => {
      const { repository } = fakeClient((sql) =>
        sql.startsWith('SELECT v.id')
          ? [{ id: 'v1', photo_file_ids: ['a', 'b', 'a'], missed_photo_file_id: 'c' }]
          : [
              {
                id: 's1',
                before_photo_file_ids: ['d'],
                after_photo_file_ids: null,
                missed_photo_file_id: null,
                incident_photo_file_ids: ['e', 'd'],
              },
            ],
      );
      await expect(repository.expiredVisitPhotos(CUTOFF, 200)).resolves.toEqual([
        { subject: { type: 'cleaning_visit', id: 'v1' }, fileIds: ['a', 'b', 'c'] },
      ]);
      await expect(repository.expiredSessionPhotos(CUTOFF, 200)).resolves.toEqual([
        { subject: { type: 'cleaning_session', id: 's1' }, fileIds: ['d', 'e'] },
      ]);
    });

    it('références d’une visite : la demande d’abord, puis la visite ; cible changée : rien n’est gardé', async () => {
      const photos = { subject: { type: 'cleaning_visit' as const, id: 'v1' }, fileIds: ['a', 'b'] };
      const erased = fakeClient(() => 1);
      await expect(erased.repository.erasePhotoReferences(photos, NOW)).resolves.toBe(true);
      expect(erased.tables()).toEqual(['cleaning_requests', 'visits']);
      expect(erased.statements[1]?.values).toEqual(['v1', ['a', 'b'], NOW.toISOString()]);

      const changed = fakeClient((sql) => (sql.startsWith('UPDATE visits') ? 0 : 1));
      await expect(changed.repository.erasePhotoReferences(photos, NOW)).resolves.toBe(false);
      expect(changed.transactions).toEqual({ opened: 1, rolledBack: 1 });
    });

    it('références d’une séance : programme verrouillé, séance, puis incidents ; une panne remonte', async () => {
      const photos = { subject: { type: 'cleaning_session' as const, id: 's1' }, fileIds: ['d', 'e'] };
      const erased = fakeClient((sql) => (sql.startsWith('SELECT') ? [{ id: 'p1' }] : 1));
      await expect(erased.repository.erasePhotoReferences(photos, NOW)).resolves.toBe(true);
      expect(erased.statements[0]?.sql).toMatch(/^SELECT p\.id FROM programs p .* FOR NO KEY UPDATE$/);
      expect(erased.tables().slice(1)).toEqual(['sessions', 'session_incidents']);

      const changed = fakeClient((sql) => (sql.startsWith('UPDATE sessions') ? 0 : []));
      await expect(changed.repository.erasePhotoReferences(photos, NOW)).resolves.toBe(false);
      expect(changed.tables()).not.toContain('session_incidents');

      const broken = fakeClient((sql) => {
        if (sql.startsWith('UPDATE sessions')) throw new Error('verrou perdu');
        return [];
      });
      await expect(broken.repository.erasePhotoReferences(photos, NOW)).rejects.toThrow('verrou perdu');
    });
  });

  describe('storedObligations', () => {
    const number = (value: string) => ({ number: value });
    /** Faux modèles Prisma : lignes rendues par table, filtres reçus gardés. */
    function models(rows: Record<string, unknown[] | number>) {
      const wheres: Record<string, unknown> = {};
      const model = (name: string) => ({
        findMany: async (args: { where: unknown }) => {
          wheres[name] = args.where;
          return rows[name] ?? [];
        },
        count: async (args: { where: unknown }) => {
          wheres[name] = args.where;
          return rows[name] ?? 0;
        },
      });
      const client = {
        program: model('program'),
        session: model('session'),
        walletOperation: model('walletOperation'),
        directPayment: model('directPayment'),
        organizationInvoice: model('organizationInvoice'),
        assignment: model('assignment'),
      };
      return { repository: new PrismaPersonalDataRepository(client as unknown as PrismaService), wheres };
    }

    it('compte personnel : programmes, séances impayées, argent en cours et affectations de l’agent', async () => {
      const createdAt = new Date('2030-06-02T08:00:00Z');
      const { repository, wheres } = models({
        program: [{ number: 'PN-000001', status: 'in_progress', _count: { sessions: 2 } }],
        session: [{ rank: 3, program: number('PN-000002') }],
        walletOperation: [
          { request: number('DN-000001'), session: { program: number('PN-000003') }, claim: null },
          { request: number('DN-000002'), session: null, claim: null },
          { request: null, session: null, claim: { session: { program: number('PN-000004') } } },
          { request: null, session: null, claim: null },
        ],
        directPayment: [{ createdAt, expiresAt: null, request: number('DN-000003'), session: null }],
        organizationInvoice: 7,
        assignment: [
          {
            status: 'confirmed',
            responseDueAt: null,
            occupiedUntil: NOW,
            session: { program: number('PN-000005') },
            visit: null,
          },
          {
            status: 'pending_confirmation',
            responseDueAt: createdAt,
            occupiedUntil: NOW,
            session: null,
            visit: { request: number('DN-000004') },
          },
        ],
      });
      const holder = { kind: 'user' as const, id: 'u1' };
      await expect(repository.storedObligations(holder, 'u1', NOW)).resolves.toEqual({
        programs: [{ number: 'PN-000001', status: 'in_progress', openSessions: 2 }],
        unpaidSessions: [{ programNumber: 'PN-000002', rank: 3 }],
        // Le programme de la séance ou de la réclamation d'abord, sinon la demande.
        walletOperations: [
          { subject: 'program', reference: 'PN-000003' },
          { subject: 'request', reference: 'DN-000002' },
          { subject: 'program', reference: 'PN-000004' },
          { subject: null, reference: null },
        ],
        directPayments: [{ subject: 'request', reference: 'DN-000003', createdAt, expiresAt: null }],
        // Les factures mensuelles ne concernent qu'une organisation : non lues.
        overdueInvoices: 0,
        assignments: [
          { status: 'confirmed', respondBefore: null, end: NOW, target: 'session', reference: 'PN-000005' },
          {
            status: 'pending_confirmation',
            respondBefore: createdAt,
            end: NOW,
            target: 'visit',
            reference: 'DN-000004',
          },
        ],
      });
      expect(wheres.organizationInvoice).toBeUndefined();
      expect(wheres.walletOperation).toEqual({
        status: 'pending',
        walletOwnerKind: 'user',
        walletOwnerId: 'u1',
      });
      expect(wheres.directPayment).toEqual({ status: 'pending', payerKind: 'user', payerId: 'u1' });
      expect(wheres.assignment).toMatchObject({ agent: { userId: 'u1' }, occupiedUntil: { gt: NOW } });
    });

    it('organisation : ses factures impayées, jamais les affectations d’un compte', async () => {
      const { repository, wheres } = models({
        organizationInvoice: 2,
        assignment: [{ status: 'confirmed' }],
      });
      const holder = { kind: 'organization' as const, id: 'o1' };
      await expect(repository.storedObligations(holder, null, NOW)).resolves.toMatchObject({
        overdueInvoices: 2,
        assignments: [],
      });
      expect(wheres.organizationInvoice).toEqual({ organizationId: 'o1', standing: 'overdue' });
      expect(wheres.assignment).toBeUndefined();
      expect(wheres.program).toMatchObject({ ownerKind: 'organization', ownerId: 'o1' });
    });
  });
});
