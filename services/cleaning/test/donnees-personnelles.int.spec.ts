import { type AppError, runWithContext } from '@ksp/platform';
import { type Pool } from 'pg';
import { ConcurrentUpdateError } from '../src/application/agents/agent.ports';
import { type PrivacyDeps } from '../src/application/deps';
import { EraseAccountDataUseCase } from '../src/application/privacy/account-erasure.use-case';
import { HasPendingObligationsUseCase } from '../src/application/privacy/obligations.use-case';
import { PurgeExpiredDataUseCase } from '../src/application/privacy/retention.use-case';
import {
  PrismaPersonalDataRepository,
  RETENTION_PURGE_LOCK,
} from '../src/infrastructure/persistence/privacy/prisma-personal-data.repository';
import { PrismaCaseRepository } from '../src/infrastructure/persistence/requests/prisma-case.repository';
import { PrismaClientPlacesRepository } from '../src/infrastructure/persistence/requests/prisma-client-places.repository';
import { PrismaSettingsRepository } from '../src/infrastructure/persistence/settings/prisma-settings.repository';
import { type PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import { RetentionPurgeService } from '../src/infrastructure/scheduling/retention-purge.service';
import { ObligationGrpcController } from '../src/interfaces/grpc/obligation.controller';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';
import {
  CIPHERTEXT,
  seedOrganizationInvoice,
  seedPendingSessionDebit,
  seedPlace,
  seedRequest,
  seedSentQuote,
  seedVisit,
  seedVisitAssignment,
  seedVisitFee,
  seedVisitFeePaymentPage,
} from './support/donnees-personnelles';
import { TestClock } from './support/lot-e';
import { loadDemo, newId, seedAgent, seedAssignment, seedProgram, seedSession } from './support/lot-g-seed';

/**
 * Piste S contre un vrai PostgreSQL : contrôle avant la suppression d'un compte
 * (ksp.common.v1.ObligationService), effacement à la suppression (R-DP-02), purge des positions et
 * des photos expirées (UC-NT-48, R-DP-01). Ignoré sans TEST_DATABASE_URL.
 */
const NOW = '2030-06-03T08:00:00Z';

describeWithDatabase('données personnelles : suppression d’un compte et conservation (PostgreSQL)', () => {
  let db: TestDatabase;
  let pool: Pool;
  let prisma: PrismaService;
  let clock: TestClock;
  let deps: PrivacyDeps;
  /** Fichiers supprimés chez file (« type:objet:fichier »), et fichiers dont la suppression échoue. */
  let removedFiles: string[];
  let brokenFiles: Set<string>;

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_piste_s');
    ({ pool, prisma } = db);
    await loadDemo(pool);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  beforeEach(() => {
    clock = new TestClock(new Date(NOW));
    deps = {
      cases: new PrismaCaseRepository(prisma, new UuidV7Generator()),
      clientPlaces: new PrismaClientPlacesRepository(prisma, new UuidV7Generator()),
      personalData: new PrismaPersonalDataRepository(prisma),
      moduleSettings: new PrismaSettingsRepository(prisma, new UuidV7Generator()),
      photos: {
        attach: async () => undefined,
        list: async () => [],
        remove: async (fileId: string, subject: { type: string; id: string }) => {
          if (brokenFiles.has(fileId)) throw new Error('file injoignable');
          removedFiles.push(`${subject.type}:${subject.id}:${fileId}`);
        },
      },
      clock,
    } as unknown as PrivacyDeps;
    removedFiles = [];
    brokenFiles = new Set();
  });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: AppError) => error,
    );
  const asService = <T>(callerService: string, fn: () => Promise<T>) =>
    runWithContext({ correlationId: 'test', callerService }, fn);
  /** Position, repère et adresses d'un lieu ou d'une demande : présents, ou effacés à l'heure du test. */
  const PRESENT = {
    gpsEncrypted: CIPHERTEXT,
    landmarkEncrypted: CIPHERTEXT,
    addressEncrypted: CIPHERTEXT,
    readableAddressEncrypted: CIPHERTEXT,
    locationErasedAt: null,
  };
  const ERASED = {
    gpsEncrypted: null,
    landmarkEncrypted: null,
    addressEncrypted: null,
    readableAddressEncrypted: null,
    locationErasedAt: new Date(NOW),
  };
  const place = (id: string) => prisma.place.findUniqueOrThrow({ where: { id } });
  const request = (id: string) => prisma.cleaningRequest.findUniqueOrThrow({ where: { id } });
  const visit = (id: string) => prisma.visit.findUniqueOrThrow({ where: { id } });
  const session = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } });
  const agent = (id: string) => prisma.agent.findUniqueOrThrow({ where: { id } });

  describe('1. obligations avant la suppression d’un compte', () => {
    const obligations = (userId: string, organizationId = '') =>
      asService('identity', () => new HasPendingObligationsUseCase(deps).execute({ userId, organizationId }));
    /** Programme terminé avant maintenant, toutes ses séances réalisées. */
    const finishedProgram = async (ownerId: string) => {
      const seeded = await seedProgram(pool, {
        ownerId,
        sessions: [{ start: '2030-05-20T08:00:00Z', end: '2030-05-20T10:00:00Z', status: 'completed' }],
      });
      await pool.query(`UPDATE programs SET status = 'completed', completed_at = $2 WHERE id = $1`, [
        seeded.programId,
        '2030-05-20T10:00:00Z',
      ]);
      return seeded;
    };
    const programNumber = async (programId: string) =>
      (await prisma.program.findUniqueOrThrow({ where: { id: programId } })).number;

    it('compte sans rien, ou dont tout est clos : has_pending = false', async () => {
      const controller = new ObligationGrpcController(deps);
      const stranger = newId();
      await expect(
        asService('identity', () =>
          controller.hasPendingObligations({ userId: stranger, organizationId: '' }),
        ),
      ).resolves.toEqual({ hasPending: false, obligations: [] });

      // Demande annulée, devis périmé (statut effectif, RV-14), programme terminé et payé.
      const owner = newId();
      const placeId = await seedPlace(pool, { ownerId: owner });
      await seedRequest(pool, {
        ownerId: owner,
        placeId,
        status: 'cancelled',
        closedAt: '2030-05-01T08:00:00Z',
      });
      const expired = await seedRequest(pool, { ownerId: owner, placeId, status: 'quote_sent' });
      await seedSentQuote(pool, expired.id, '2030-06-03T07:59:59Z');
      await finishedProgram(owner);
      await expect(
        asService('identity', () => controller.hasPendingObligations({ userId: owner, organizationId: '' })),
      ).resolves.toEqual({ hasPending: false, obligations: [] });
    });

    it('demande ouverte : une obligation, avec le numéro du dossier', async () => {
      const owner = newId();
      const placeId = await seedPlace(pool, { ownerId: owner });
      const open = await seedRequest(pool, { ownerId: owner, placeId, status: 'visit_to_schedule' });
      const sent = await seedRequest(pool, { ownerId: owner, placeId, status: 'quote_sent' });
      await seedSentQuote(pool, sent.id, '2030-06-10T08:00:00Z');
      // Dossier d'un autre compte : jamais compté.
      const other = newId();
      await seedRequest(pool, {
        ownerId: other,
        placeId: await seedPlace(pool, { ownerId: other }),
        status: 'visit_done',
      });

      const controller = new ObligationGrpcController(deps);
      const response = await asService('identity', () =>
        controller.hasPendingObligations({ userId: owner, organizationId: '' }),
      );
      expect(response.hasPending).toBe(true);
      expect(response.obligations).toEqual(
        [open.number, sent.number].sort().map((number) => ({
          kind: 'open_cleaning_request',
          reference: number,
          description: `La demande de nettoyage ${number} est en cours : annulez-la ou attendez sa clôture.`,
        })),
      );
    });

    it('programme en cours : une obligation, avec le numéro du programme', async () => {
      const seeded = await seedProgram(pool, {
        sessions: [{ start: '2030-06-10T08:00:00Z', end: '2030-06-10T10:00:00Z' }],
      });
      const number = await programNumber(seeded.programId);
      expect(await obligations(seeded.ownerId)).toEqual([
        {
          kind: 'open_cleaning_program',
          reference: number,
          description: `Le programme de nettoyage ${number} n'est pas terminé : arrêtez-le ou attendez sa fin.`,
        },
      ]);
    });

    it('séance impayée (à payer ou en retard) d’un programme terminé : une obligation', async () => {
      const seeded = await finishedProgram(newId());
      await pool.query(
        `UPDATE sessions SET payment_status = 'overdue', amount_due = price, payment_due_at = $2 WHERE id = $1`,
        [seeded.sessionIds[0], '2030-05-21T10:00:00Z'],
      );
      const number = await programNumber(seeded.programId);
      expect(await obligations(seeded.ownerId)).toEqual([
        {
          kind: 'unpaid_cleaning_session',
          reference: number,
          description: `Une séance du programme ${number} reste à payer.`,
        },
      ]);
      await pool.query(`UPDATE sessions SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [
        seeded.sessionIds[0],
      ]);
      expect(await obligations(seeded.ownerId)).toEqual([]);
    });

    it('argent en cours : débit du wallet sans issue, page de paiement encore ouverte', async () => {
      const seeded = await finishedProgram(newId());
      await seedPendingSessionDebit(pool, {
        ownerId: seeded.ownerId,
        requestId: seeded.requestId,
        sessionId: seeded.sessionIds[0]!,
      });
      // Demande close d'après l'heure (frais impayés à l'échéance), mais page de paiement ouverte.
      const awaiting = await seedRequest(pool, {
        ownerId: seeded.ownerId,
        placeId: seeded.placeId,
        status: 'awaiting_visit_fee',
      });
      const feeId = await seedVisitFee(pool, { requestId: awaiting.id, dueAt: '2030-06-03T07:00:00Z' });
      await seedVisitFeePaymentPage(pool, {
        ownerId: seeded.ownerId,
        requestId: awaiting.id,
        visitFeeId: feeId,
        createdAt: '2030-06-03T06:00:00Z',
        expiresAt: '2030-06-03T09:00:00Z',
      });
      const number = await programNumber(seeded.programId);
      expect(await obligations(seeded.ownerId)).toEqual([
        {
          kind: 'cleaning_payment_in_progress',
          reference: awaiting.number,
          description: `Un paiement est en cours pour la demande ${awaiting.number} : attendez qu'il aboutisse.`,
        },
        {
          kind: 'cleaning_payment_in_progress',
          reference: number,
          description: `Un paiement est en cours pour le programme ${number} : attendez qu'il aboutisse.`,
        },
      ]);
      // La page expirée, il ne reste que le débit en cours.
      clock.set('2030-06-03T09:00:00Z');
      expect((await obligations(seeded.ownerId)).map((item) => item.reference)).toEqual([number]);
    });

    it('organisation : ses dossiers et ses factures mensuelles impayées, pas ceux du compte', async () => {
      const organization = newId();
      const member = newId();
      const seeded = await seedProgram(pool, {
        ownerKind: 'organization',
        ownerId: organization,
        submittedBy: member,
        sessions: [{ start: '2030-06-12T08:00:00Z', end: '2030-06-12T10:00:00Z' }],
      });
      await seedOrganizationInvoice(pool, organization, 'overdue');
      await seedOrganizationInvoice(pool, organization, 'overdue');
      await seedOrganizationInvoice(pool, organization, 'paid');
      const number = await programNumber(seeded.programId);
      expect(await obligations(member, organization)).toEqual([
        expect.objectContaining({ kind: 'open_cleaning_program', reference: number }),
        {
          kind: 'unpaid_cleaning_invoice',
          reference: '',
          description: "2 factures mensuelles de nettoyage de l'organisation sont impayées.",
        },
      ]);
      // Contexte personnel du membre : les dossiers de l'organisation ne sont pas les siens.
      expect(await obligations(member)).toEqual([]);
    });

    it('agent : une affectation à venir bloque, une affectation passée ou retirée non (R-AG-03)', async () => {
      const agentId = await seedAgent(pool, { name: 'Awa' });
      const { userId } = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      const seeded = await seedProgram(pool, {
        sessions: [
          { start: '2030-06-01T08:00:00Z', end: '2030-06-01T10:00:00Z', status: 'completed' },
          { start: '2030-06-05T08:00:00Z', end: '2030-06-05T10:00:00Z', status: 'assigned' },
        ],
      });
      const [past, upcoming] = seeded.sessionIds as [string, string];
      await seedAssignment(pool, {
        sessionId: past,
        agentId,
        start: '2030-06-01T08:00:00Z',
        end: '2030-06-01T10:00:00Z',
      });
      expect(await obligations(userId)).toEqual([]);

      const assignmentId = await seedAssignment(pool, {
        sessionId: upcoming,
        agentId,
        start: '2030-06-05T07:30:00Z',
        end: '2030-06-05T10:00:00Z',
      });
      const number = await programNumber(seeded.programId);
      expect(await obligations(userId)).toEqual([
        {
          kind: 'upcoming_cleaning_assignment',
          reference: number,
          description: `Vous êtes attendu sur une séance du programme ${number} : demandez d'abord votre remplacement.`,
        },
      ]);

      // Une visite à venir bloque aussi ; l'affectation retirée ne compte plus.
      await pool.query(
        `UPDATE assignments SET status = 'removed', removed_at = now(), removal_reason = 'test' WHERE id = $1`,
        [assignmentId],
      );
      const owner = newId();
      const request = await seedRequest(pool, {
        ownerId: owner,
        placeId: await seedPlace(pool, { ownerId: owner }),
        status: 'visit_done',
      });
      const visitId = await seedVisit(pool, {
        requestId: request.id,
        visitFeeId: await seedVisitFee(pool, { requestId: request.id }),
        start: '2030-06-04T09:00:00Z',
        arrival: false,
      });
      await seedVisitAssignment(pool, {
        visitId,
        agentId,
        start: '2030-06-04T08:30:00Z',
        end: '2030-06-04T10:00:00Z',
      });
      expect(await obligations(userId)).toEqual([
        expect.objectContaining({ kind: 'upcoming_cleaning_assignment', reference: request.number }),
      ]);
    });

    it('appelant autre qu’identity : CLEANING_CALLER_FORBIDDEN ; identifiant invalide : refusé', async () => {
      const useCase = new HasPendingObligationsUseCase(deps);
      for (const caller of ['gateway', 'wallet', 'billing']) {
        expect(
          await failure(asService(caller, () => useCase.execute({ userId: newId(), organizationId: '' }))),
        ).toMatchObject({ kind: 'PERMISSION_DENIED', code: 'CLEANING_CALLER_FORBIDDEN' });
      }
      expect(
        await failure(asService('identity', () => useCase.execute({ userId: 'x', organizationId: '' }))),
      ).toMatchObject({ code: 'CLEANING_VALIDATION_FAILED', details: { field: 'userId' } });
      expect(
        await failure(asService('identity', () => useCase.execute({ userId: newId(), organizationId: 'x' }))),
      ).toMatchObject({ code: 'CLEANING_VALIDATION_FAILED', details: { field: 'organizationId' } });
    });

    it('lecture en échec : une erreur, jamais « rien en cours »', async () => {
      const broken = {
        ...deps,
        personalData: {
          storedObligations: () => Promise.reject(new Error('base injoignable')),
        },
      } as unknown as PrivacyDeps;
      await expect(
        asService('identity', () =>
          new HasPendingObligationsUseCase(broken).execute({ userId: newId(), organizationId: '' }),
        ),
      ).rejects.toThrow('base injoignable');
    });
  });

  describe('2. effacement à la suppression du compte (R-DP-02)', () => {
    const NOTHING = { places: 0, requests: 0, visitArrivals: 0, sessionArrivals: 0, agentProfiles: 0 };
    const erase = (userId: string, eventId = newId()) =>
      new EraseAccountDataUseCase(deps).execute({ eventId, userId });
    /** Versions et dates de toutes les lignes que l'effacement peut écrire. */
    const snapshot = async () => {
      const { rows } = await pool.query(
        `SELECT 'place' AS kind, id, version, location_erased_at AS erased_at, updated_at FROM places
         UNION ALL SELECT 'request', id, version, location_erased_at, updated_at FROM cleaning_requests
         UNION ALL SELECT 'visit', id, version, NULL, updated_at FROM visits
         UNION ALL SELECT 'session', id, version, NULL, updated_at FROM sessions
         UNION ALL SELECT 'agent', id, version, NULL, updated_at FROM agents
         ORDER BY 1, 2`,
      );
      return rows;
    };
    const inboxMarks = (eventId: string) => prisma.processedEvent.count({ where: { eventId } });

    /** Agent du compte donné, avec sa pièce d'identité, sa personne à prévenir et son Mobile Money. */
    const seedAgentOf = async (userId: string, name: string) => {
      const agentId = await seedAgent(pool, { name });
      await pool.query(
        `UPDATE agents SET user_id = $2, id_document_encrypted = $3, emergency_contact_encrypted = $3, mobile_money_encrypted = $3 WHERE id = $1`,
        [agentId, userId, CIPHERTEXT],
      );
      return agentId;
    };
    /** Visite terminée chez un autre client, avec la position d'arrivée de l'agent affecté. */
    const seedVisitedRequest = async (agentId: string, start: string) => {
      const customer = newId();
      const visited = await seedRequest(pool, {
        ownerId: customer,
        placeId: await seedPlace(pool, { ownerId: customer }),
        status: 'visit_done',
      });
      const visitId = await seedVisit(pool, {
        requestId: visited.id,
        visitFeeId: await seedVisitFee(pool, { requestId: visited.id }),
        start,
      });
      const end = new Date(new Date(start).getTime() + 3_600_000).toISOString();
      await seedVisitAssignment(pool, { visitId, agentId, start, end });
      return { requestId: visited.id, visitId };
    };
    /** Séance réalisée d'un autre client, avec la position d'arrivée du chef d'équipe affecté. */
    const seedArrivedSession = async (agentId: string, start: string) => {
      const end = new Date(new Date(start).getTime() + 2 * 3_600_000).toISOString();
      const seeded = await seedProgram(pool, { sessions: [{ start, end, status: 'completed' }] });
      const sessionId = seeded.sessionIds[0]!;
      await pool.query(
        `UPDATE sessions SET arrived_at = scheduled_start, arrival_gps_encrypted = $2, arrival_distance_m = 37 WHERE id = $1`,
        [sessionId, CIPHERTEXT],
      );
      await seedAssignment(pool, { sessionId, agentId, start, end, isLead: true });
      return { ...seeded, sessionId };
    };

    it('champs personnels effacés, commune et distance gardées, lieux d’organisation intacts ; rejeu sans effet', async () => {
      // Le compte est client (deux lieux, deux demandes) et agent.
      const user = newId();
      const home = await seedPlace(pool, { ownerId: user });
      const archived = await seedPlace(pool, { ownerId: user, archivedAt: '2030-01-10T08:00:00Z' });
      const cancelled = await seedRequest(pool, {
        ownerId: user,
        placeId: home,
        status: 'cancelled',
        closedAt: '2030-05-01T08:00:00Z',
      });
      const declined = await seedRequest(pool, {
        ownerId: user,
        placeId: archived,
        status: 'declined',
        closedAt: '2030-02-01T08:00:00Z',
      });
      // Organisation dont il est membre : le lieu et la demande qu'il a créés restent à l'organisation.
      const organization = newId();
      const office = await seedPlace(pool, { ownerId: organization, ownerKind: 'organization' });
      const officeRequest = await seedRequest(pool, {
        ownerId: organization,
        ownerKind: 'organization',
        placeId: office,
        status: 'visit_done',
        submittedBy: user,
      });
      await pool.query('UPDATE places SET created_by = $2 WHERE id = $1', [office, user]);
      // Agent : sa fiche, une visite et une séance chez d'autres clients ; un collègue à côté.
      const agentId = await seedAgentOf(user, 'Awa Dossou');
      const colleagueId = await seedAgentOf(newId(), 'Koffi Mensah');
      const visited = await seedVisitedRequest(agentId, '2030-05-10T09:00:00Z');
      const visitedByColleague = await seedVisitedRequest(colleagueId, '2030-05-10T09:00:00Z');
      const arrived = await seedArrivedSession(agentId, '2030-05-12T08:00:00Z');
      const arrivedByColleague = await seedArrivedSession(colleagueId, '2030-05-12T08:00:00Z');

      const eventId = newId();
      await expect(erase(user, eventId)).resolves.toEqual({
        status: 'processed',
        places: 2,
        requests: 2,
        visitArrivals: 1,
        sessionArrivals: 1,
        agentProfiles: 1,
      });
      expect(await inboxMarks(eventId)).toBe(1);

      // Lieux personnels et copies de leurs demandes : effacés, commune gardée, version + 1.
      for (const id of [home, archived]) {
        expect(await place(id)).toMatchObject({
          ...ERASED,
          communeKey: 'cotonou',
          version: 1,
          name: 'Maison',
        });
      }
      expect((await place(archived)).archivedAt).toEqual(new Date('2030-01-10T08:00:00Z'));
      expect(await request(cancelled.id)).toMatchObject({
        ...ERASED,
        communeKey: 'cotonou',
        status: 'cancelled',
        version: 1,
      });
      expect(await request(declined.id)).toMatchObject({ ...ERASED, communeKey: 'cotonou', version: 1 });
      // Lieu et demande de l'organisation : inchangés.
      expect(await place(office)).toMatchObject({ ...PRESENT, version: 0 });
      expect(await request(officeRequest.id)).toMatchObject({ ...PRESENT, version: 0 });

      // Agent : pièce d'identité, personne à prévenir et Mobile Money effacés ; le reste gardé.
      expect(await agent(agentId)).toMatchObject({
        idDocumentEncrypted: null,
        emergencyContactEncrypted: null,
        mobileMoneyEncrypted: null,
        status: 'active',
        homeCommuneKey: 'cotonou',
        version: 1,
      });
      expect(await agent(colleagueId)).toMatchObject({
        idDocumentEncrypted: CIPHERTEXT,
        emergencyContactEncrypted: CIPHERTEXT,
        mobileMoneyEncrypted: CIPHERTEXT,
        version: 0,
      });
      // Ses positions d'arrivée : effacées, la distance reste ; le dossier visité garde sa position.
      expect(await visit(visited.visitId)).toMatchObject({
        arrivalGpsEncrypted: null,
        arrivalDistanceM: 42,
        version: 1,
      });
      expect(await request(visited.requestId)).toMatchObject({ ...PRESENT, version: 1 });
      expect(await session(arrived.sessionId)).toMatchObject({
        arrivalGpsEncrypted: null,
        arrivalDistanceM: 37,
        version: 1,
      });
      // Celles du collègue : inchangées.
      expect(await visit(visitedByColleague.visitId)).toMatchObject({
        arrivalGpsEncrypted: CIPHERTEXT,
        version: 0,
      });
      expect(await request(visitedByColleague.requestId)).toMatchObject({ ...PRESENT, version: 0 });
      expect(await session(arrivedByColleague.sessionId)).toMatchObject({
        arrivalGpsEncrypted: CIPHERTEXT,
        arrivalDistanceM: 37,
        version: 0,
      });

      // Rejeu du même événement : déjà traité, aucune écriture.
      const after = await snapshot();
      await expect(erase(user, eventId)).resolves.toEqual({ status: 'duplicate', ...NOTHING });
      expect(await snapshot()).toEqual(after);
      // Événement rejoué après la purge de l'inbox (autre identifiant) : traité, sans rien écrire.
      await expect(erase(user, newId())).resolves.toEqual({ status: 'processed', ...NOTHING });
      expect(await snapshot()).toEqual(after);
    });

    it('une écriture partie d’une lecture antérieure à l’effacement est refusée, sans rien réécrire', async () => {
      const user = newId();
      const home = await seedPlace(pool, { ownerId: user });
      const open = await seedRequest(pool, { ownerId: user, placeId: home, status: 'visit_to_schedule' });
      const agentId = await seedAgentOf(user, 'Awa Dossou');
      const visited = await seedVisitedRequest(agentId, '2030-05-11T09:00:00Z');
      const stalePlace = (await deps.clientPlaces.findPlace(home))!;
      const staleCase = (await deps.cases.findCase(open.id))!;
      const staleVisited = (await deps.cases.findCase(visited.requestId))!;
      expect(staleVisited.visits[0]?.arrivalGpsEncrypted).toBe(CIPHERTEXT);

      await erase(user);

      const none = { events: [], audit: [] };
      await expect(
        deps.clientPlaces.updatePlace(stalePlace, stalePlace.version, none),
      ).rejects.toBeInstanceOf(ConcurrentUpdateError);
      await expect(
        deps.cases.saveCase(staleCase, staleCase.request.version, { changes: none }),
      ).rejects.toBeInstanceOf(ConcurrentUpdateError);
      await expect(
        deps.cases.saveCase(staleVisited, staleVisited.request.version, { changes: none }),
      ).rejects.toBeInstanceOf(ConcurrentUpdateError);
      expect(await place(home)).toMatchObject(ERASED);
      expect(await request(open.id)).toMatchObject(ERASED);
      expect((await visit(visited.visitId)).arrivalGpsEncrypted).toBeNull();
    });

    it('une seule transaction : un échec n’efface rien et ne marque pas l’événement, qui se rejoue', async () => {
      const user = newId();
      const home = await seedPlace(pool, { ownerId: user });
      const closed = await seedRequest(pool, {
        ownerId: user,
        placeId: home,
        status: 'cancelled',
        closedAt: '2030-05-01T08:00:00Z',
      });
      const agentId = await seedAgentOf(user, 'Awa Dossou');
      // La dernière écriture (fiche de l'agent) échoue : tout ce qui précède est annulé.
      await pool.query(
        `CREATE FUNCTION refuse_agent_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'panne simulée'; END $$ LANGUAGE plpgsql`,
      );
      await pool.query(
        `CREATE TRIGGER refuse_agent_update BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION refuse_agent_update()`,
      );
      const eventId = newId();
      try {
        await expect(erase(user, eventId)).rejects.toThrow('panne simulée');
      } finally {
        await pool.query('DROP TRIGGER refuse_agent_update ON agents');
        await pool.query('DROP FUNCTION refuse_agent_update()');
      }
      expect(await inboxMarks(eventId)).toBe(0);
      expect(await place(home)).toMatchObject({ ...PRESENT, version: 0 });
      expect(await request(closed.id)).toMatchObject({ ...PRESENT, version: 0 });
      expect((await agent(agentId)).idDocumentEncrypted).toBe(CIPHERTEXT);

      // Le message revient (file de reprise) : cette fois tout est effacé.
      await expect(erase(user, eventId)).resolves.toMatchObject({
        status: 'processed',
        places: 1,
        requests: 1,
        agentProfiles: 1,
      });
      expect(await place(home)).toMatchObject(ERASED);
      expect((await agent(agentId)).idDocumentEncrypted).toBeNull();
    });

    it('compte sans rien chez cleaning : événement traité, rien n’est écrit ni publié', async () => {
      const before = await snapshot();
      const events = await prisma.outboxEvent.count();
      await expect(erase(newId())).resolves.toEqual({ status: 'processed', ...NOTHING });
      expect(await snapshot()).toEqual(before);
      expect(await prisma.outboxEvent.count()).toBe(events);
    });
  });

  describe('3. purge des positions et des photos expirées (UC-NT-48, R-DP-01)', () => {
    /** N = 12 mois (réglage par défaut) : il y a N mois + 1 jour, et N mois − 1 jour. */
    const EXPIRED = '2029-06-02T08:00:00Z';
    const RECENT = '2029-06-04T08:00:00Z';
    const NOTHING = {
      ran: true,
      requestLocations: 0,
      visitArrivals: 0,
      sessionArrivals: 0,
      placeLocations: 0,
      photos: 0,
      idempotencyRecords: 0,
      failed: 0,
    };
    /** Position encore présente, quel que soit le jeu d'essai qui a créé la ligne. */
    const KEPT = {
      gpsEncrypted: expect.any(String),
      landmarkEncrypted: expect.any(String),
      locationErasedAt: null,
    };
    const purge = () => new PurgeExpiredDataUseCase(deps).execute();

    /** Ce que les tests précédents ont laissé d'expiré part d'abord : les comptes sont ensuite exacts. */
    beforeEach(async () => {
      await purge();
      removedFiles = [];
    });

    const closedRequest = async (closedAt: string, status = 'cancelled') => {
      const ownerId = newId();
      const placeId = await seedPlace(pool, { ownerId });
      return { ...(await seedRequest(pool, { ownerId, placeId, status, closedAt })), ownerId, placeId };
    };
    /** Visite d'une demande : terminée avec sa position d'arrivée, sauf indication contraire. */
    const visitOf = async (requestId: string, options: Partial<Parameters<typeof seedVisit>[1]> = {}) =>
      seedVisit(pool, {
        requestId,
        visitFeeId: await seedVisitFee(pool, { requestId, rank: options.attempt ?? 1 }),
        start: '2029-05-20T09:00:00Z',
        ...options,
      });
    const endProgram = (programId: string, status: 'completed' | 'cancelled', at: string) =>
      status === 'completed'
        ? pool.query(`UPDATE programs SET status = 'completed', completed_at = $2 WHERE id = $1`, [
            programId,
            at,
          ])
        : pool.query(
            `UPDATE programs SET status = 'cancelled', cancelled_at = $2, cancelled_by = 'customer' WHERE id = $1`,
            [programId, at],
          );
    /**
     * Programme d'une séance réalisée (une photo « avant », une photo « après »), fini ou annulé à la
     * date donnée ; l'arrivée du chef d'équipe est enregistrée sauf indication contraire.
     */
    const endedProgram = async (status: 'completed' | 'cancelled', at: string, arrived = true) => {
      const seeded = await seedProgram(pool, {
        sessions: [{ start: '2029-05-10T08:00:00Z', end: '2029-05-10T10:00:00Z', status: 'completed' }],
      });
      const sessionId = seeded.sessionIds[0]!;
      if (arrived) {
        await pool.query(
          `UPDATE sessions SET arrived_at = scheduled_start, arrival_gps_encrypted = $2, arrival_distance_m = 37 WHERE id = $1`,
          [sessionId, CIPHERTEXT],
        );
      }
      await endProgram(seeded.programId, status, at);
      return { ...seeded, sessionId };
    };
    /** Renouvellement en cours d'un programme (R-PG-07), rattaché à la même demande. */
    const seedRenewal = async (seeded: {
      programId: string;
      requestId: string;
      placeId: string;
      ownerId: string;
    }) => {
      const [quoteId, programId] = [newId(), newId()];
      await pool.query(
        `INSERT INTO quotes (id, request_id, version, kind, program_id, lines, session_price, sessions_count, total, team_size, duration_minutes, schedule_plan, created_by, created_at)
         VALUES ($1, $2, 2, 'renewal', $3, '[]', 10000, 1, 10000, 1, 120, '{}', $4, now())`,
        [quoteId, seeded.requestId, seeded.programId, seeded.ownerId],
      );
      await pool.query(
        `INSERT INTO programs (id, request_id, quote_id, owner_kind, owner_id, payer_kind, place_id, commune_key, session_price, team_size, duration_minutes, schedule_plan, status, renewal_of_program_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'user', $4, 'individual', $5, 'cotonou', 10000, 1, 120, '{}', 'in_progress', $6, now(), now())`,
        [programId, seeded.requestId, quoteId, seeded.ownerId, seeded.placeId, seeded.programId],
      );
      return programId;
    };
    /** Séance manquée (accès impossible), avec la photo du lieu. */
    const seedMissedSession = async (programId: string, rank: number, photoFileId: string) => {
      const id = newId();
      await pool.query(
        `INSERT INTO sessions (id, program_id, rank, commune_key, scheduled_start, scheduled_end, price, status, missed_cause, missed_at, missed_photo_file_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'cotonou', $4, $5, 10000, 'missed', 'access_impossible', $5, $6, now(), now())`,
        [id, programId, rank, '2029-05-11T08:00:00Z', '2029-05-11T10:00:00Z', photoFileId],
      );
      return id;
    };
    const archive = (placeId: string, at: string) =>
      pool.query('UPDATE places SET archived_at = $2 WHERE id = $1', [placeId, at]);

    it('demande close depuis N mois + 1 jour : copie de la position effacée ; depuis N mois − 1 jour : gardée', async () => {
      const expired = await closedRequest(EXPIRED);
      const recent = await closedRequest(RECENT, 'declined');
      const expiredVisit = await visitOf(expired.id);
      const recentVisit = await visitOf(recent.id);
      // La dernière modification ne compte pas : récente pour l'une, très ancienne pour l'autre.
      await pool.query('UPDATE cleaning_requests SET updated_at = $2 WHERE id = $1', [
        expired.id,
        '2030-06-02T08:00:00Z',
      ]);
      await pool.query('UPDATE cleaning_requests SET updated_at = $2, created_at = $2 WHERE id = $1', [
        recent.id,
        '2020-01-01T00:00:00Z',
      ]);

      await expect(purge()).resolves.toEqual({ ...NOTHING, requestLocations: 1, visitArrivals: 1 });
      expect(await request(expired.id)).toMatchObject({
        ...ERASED,
        communeKey: 'cotonou',
        status: 'cancelled',
        updatedAt: new Date('2030-06-02T08:00:00Z'),
        version: 1,
      });
      // Position d'arrivée de la visite : effacée avec le dossier, la distance reste.
      expect(await visit(expiredVisit)).toMatchObject({
        arrivalGpsEncrypted: null,
        arrivalDistanceM: 42,
        version: 1,
      });
      expect(await request(recent.id)).toMatchObject({ ...PRESENT, version: 0 });
      expect(await visit(recentVisit)).toMatchObject({ arrivalGpsEncrypted: CIPHERTEXT, version: 0 });
      // Un lieu non archivé est gardé tant que le compte existe.
      expect(await place(expired.placeId)).toMatchObject({ ...PRESENT, version: 0 });

      // Passage suivant : rien à refaire. Deux jours plus tard, la seconde demande a dépassé N mois.
      await expect(purge()).resolves.toEqual(NOTHING);
      clock.set('2030-06-05T08:00:00Z');
      await purge();
      expect(await request(recent.id)).toMatchObject({
        gpsEncrypted: null,
        locationErasedAt: new Date('2030-06-05T08:00:00Z'),
        version: 1,
      });
      expect((await visit(recentVisit)).arrivalGpsEncrypted).toBeNull();
    });

    it('copie déjà effacée à la suppression du compte : la position d’arrivée de la visite part à son tour', async () => {
      const closed = await closedRequest(EXPIRED);
      const visitId = await visitOf(closed.id);
      await pool.query(
        `UPDATE cleaning_requests SET gps_encrypted = NULL, landmark_encrypted = NULL, address_encrypted = NULL, readable_address_encrypted = NULL, location_erased_at = $2 WHERE id = $1`,
        [closed.id, '2029-07-01T00:00:00Z'],
      );
      await expect(purge()).resolves.toEqual({ ...NOTHING, visitArrivals: 1 });
      expect(await request(closed.id)).toMatchObject({
        locationErasedAt: new Date('2029-07-01T00:00:00Z'),
        version: 1,
      });
      expect((await visit(visitId)).arrivalGpsEncrypted).toBeNull();
    });

    it('réactivation en attente : le dossier expiré garde sa position jusqu’à la décision', async () => {
      const expired = await closedRequest(EXPIRED, 'expired');
      const reactivationId = newId();
      await pool.query(
        `INSERT INTO request_reactivations (id, request_id, requested_by, requested_at) VALUES ($1, $2, $3, $4)`,
        [reactivationId, expired.id, expired.ownerId, '2030-06-01T08:00:00Z'],
      );
      await expect(purge()).resolves.toEqual(NOTHING);
      expect(await request(expired.id)).toMatchObject(PRESENT);
      await pool.query(
        `UPDATE request_reactivations SET status = 'refused', decided_by = $2, decided_at = $3 WHERE id = $1`,
        [reactivationId, newId(), '2030-06-02T08:00:00Z'],
      );
      await expect(purge()).resolves.toEqual({ ...NOTHING, requestLocations: 1 });
      expect(await request(expired.id)).toMatchObject(ERASED);
    });

    it('programme fini depuis N mois + 1 jour : arrivées de ses séances et copie de sa demande effacées ; annulé depuis N mois − 1 jour : gardées', async () => {
      const expired = await endedProgram('completed', EXPIRED);
      const recent = await endedProgram('cancelled', RECENT);

      await expect(purge()).resolves.toEqual({
        ...NOTHING,
        requestLocations: 1,
        sessionArrivals: 1,
        photos: 2,
      });
      expect(await session(expired.sessionId)).toMatchObject({
        arrivalGpsEncrypted: null,
        arrivalDistanceM: 37,
        status: 'completed',
      });
      // Demande acceptée : la clôture du dossier est la fin de son dernier programme.
      expect(await request(expired.requestId)).toMatchObject({
        ...ERASED,
        status: 'accepted',
        communeKey: 'cotonou',
        version: 1,
      });
      expect(await session(recent.sessionId)).toMatchObject({
        arrivalGpsEncrypted: CIPHERTEXT,
        photosErasedAt: null,
        version: 0,
      });
      expect(await request(recent.requestId)).toMatchObject({ ...KEPT, version: 0 });
      // Les lieux, non archivés, sont gardés.
      expect(await place(expired.placeId)).toMatchObject({ ...KEPT, version: 0 });
    });

    it('rien n’est effacé tant qu’un programme non terminé ou une séance à venir s’en sert', async () => {
      // Programme fini depuis plus de N mois, renouvelé : le renouvellement en cours se sert de la
      // copie de la demande ; les arrivées des séances de l'ancien programme, elles, ont expiré.
      const renewed = await endedProgram('completed', EXPIRED);
      await seedRenewal(renewed);
      // Programme fini depuis plus de N mois auquel une repasse gratuite reste à venir (R-RC-03).
      const redo = await endedProgram('completed', EXPIRED);
      await seedSession(pool, {
        programId: redo.programId,
        rank: 2,
        start: '2030-06-10T08:00:00Z',
        end: '2030-06-10T10:00:00Z',
      });

      await expect(purge()).resolves.toEqual({ ...NOTHING, sessionArrivals: 1, photos: 2 });
      expect((await session(renewed.sessionId)).arrivalGpsEncrypted).toBeNull();
      expect(await request(renewed.requestId)).toMatchObject({ ...KEPT, version: 0 });
      expect(await session(redo.sessionId)).toMatchObject({
        arrivalGpsEncrypted: CIPHERTEXT,
        photosErasedAt: null,
        version: 0,
      });
      expect(await request(redo.requestId)).toMatchObject({ ...KEPT, version: 0 });
    });

    it('lieu archivé : effacé N mois après son archivage ; gardé tant qu’un programme en cours ou une demande ouverte l’utilise', async () => {
      const owner = newId();
      const unused = await seedPlace(pool, { ownerId: owner, archivedAt: EXPIRED });
      const recent = await seedPlace(pool, { ownerId: owner, archivedAt: RECENT });
      // Lieu non archivé, même très ancien : gardé tant que le compte existe.
      const active = await seedPlace(pool, { ownerId: owner });
      await pool.query('UPDATE places SET created_at = $2, updated_at = $2 WHERE id = $1', [
        active,
        '2020-01-01T00:00:00Z',
      ]);
      // Archivé depuis plus de N mois, mais utilisé par un programme en cours.
      const running = await seedProgram(pool, {
        status: 'in_progress',
        sessions: [{ start: '2030-06-10T08:00:00Z', end: '2030-06-10T10:00:00Z' }],
      });
      await archive(running.placeId, EXPIRED);
      // … par une demande ouverte.
      const withOpenRequest = await seedPlace(pool, { ownerId: owner, archivedAt: EXPIRED });
      await seedRequest(pool, { ownerId: owner, placeId: withOpenRequest, status: 'visit_scheduled' });
      // … par la repasse gratuite à venir d'un programme terminé.
      const redo = await endedProgram('completed', '2030-05-01T08:00:00Z', false);
      await seedSession(pool, {
        programId: redo.programId,
        rank: 2,
        start: '2030-06-10T08:00:00Z',
        end: '2030-06-10T10:00:00Z',
      });
      await archive(redo.placeId, EXPIRED);
      // Archivé depuis plus de N mois, son seul dossier est clos : plus rien ne l'utilise.
      const withClosedRequest = await seedPlace(pool, { ownerId: owner, archivedAt: EXPIRED });
      const closed = await seedRequest(pool, {
        ownerId: owner,
        placeId: withClosedRequest,
        status: 'cancelled',
        closedAt: '2030-05-01T08:00:00Z',
      });

      await expect(purge()).resolves.toEqual({ ...NOTHING, placeLocations: 2 });
      expect(await place(unused)).toMatchObject({
        ...ERASED,
        communeKey: 'cotonou',
        archivedAt: new Date(EXPIRED),
        version: 1,
      });
      expect(await place(withClosedRequest)).toMatchObject({ ...ERASED, version: 1 });
      // La copie de la demande close suit sa propre échéance.
      expect(await request(closed.id)).toMatchObject({ ...PRESENT, version: 0 });
      for (const id of [recent, active, withOpenRequest]) {
        expect(await place(id)).toMatchObject({ ...PRESENT, version: 0 });
      }
      expect(await place(running.placeId)).toMatchObject({ ...KEPT, version: 0 });
      expect(await place(redo.placeId)).toMatchObject({ ...KEPT, version: 0 });

      // Le programme en cours est arrêté : son lieu, archivé depuis plus de N mois, peut partir ;
      // la copie de sa demande attend N mois après l'arrêt.
      await endProgram(running.programId, 'cancelled', '2030-06-03T07:00:00Z');
      await pool.query(
        `UPDATE sessions SET status = 'cancelled', cancelled_at = $2, cancel_cause = 'program_stopped' WHERE program_id = $1`,
        [running.programId, '2030-06-03T07:00:00Z'],
      );
      await expect(purge()).resolves.toEqual({ ...NOTHING, placeLocations: 1 });
      expect(await place(running.placeId)).toMatchObject(ERASED);
      expect(await request(running.requestId)).toMatchObject({ ...KEPT, version: 0 });
    });

    it('la durée est le réglage retentionMonths du back-office', async () => {
      const closed = await closedRequest('2030-05-02T08:00:00Z');
      await expect(purge()).resolves.toEqual(NOTHING);
      expect(await request(closed.id)).toMatchObject(PRESENT);
      await pool.query('UPDATE cleaning_settings SET retention_months = 1 WHERE id = 1');
      try {
        await expect(purge()).resolves.toMatchObject({ ran: true, failed: 0 });
        expect(await request(closed.id)).toMatchObject(ERASED);
      } finally {
        await pool.query('UPDATE cleaning_settings SET retention_months = 12 WHERE id = 1');
      }
    });

    it('photos des visites et des séances : supprimées chez file, puis leurs références, après la même durée', async () => {
      // Demande close depuis N mois + 1 jour : une visite manquée (photo du lieu), puis une visite faite.
      const closed = await closedRequest(EXPIRED);
      const [absence, photoA, photoB, keptPhoto] = [newId(), newId(), newId(), newId()];
      const missedVisit = await visitOf(closed.id, {
        status: 'missed',
        missedPhotoFileId: absence,
        arrival: false,
      });
      const doneVisit = await visitOf(closed.id, {
        attempt: 2,
        photoFileIds: [photoA, photoB],
        arrival: false,
      });
      // Demande close depuis N mois − 1 jour : photos gardées.
      const recent = await closedRequest(RECENT);
      const recentVisit = await visitOf(recent.id, { photoFileIds: [keptPhoto], arrival: false });
      // Programme fini depuis N mois + 1 jour : séance réalisée (avant, après, signature, incident)
      // et séance manquée (photo du lieu).
      const program = await seedProgram(pool, {
        sessions: [{ start: '2029-05-10T08:00:00Z', end: '2029-05-10T10:00:00Z', status: 'completed' }],
      });
      const done = program.sessionIds[0]!;
      const [incidentPhoto, signature, missedPhoto] = [newId(), newId(), newId()];
      await pool.query('UPDATE sessions SET signature_file_id = $2 WHERE id = $1', [done, signature]);
      await pool.query(
        `INSERT INTO session_incidents (id, session_id, kind, note, photo_file_ids, reported_by, occurred_at)
         VALUES ($1, $2, 'access', 'Portail fermé', $3, $4, $5)`,
        [newId(), done, [incidentPhoto], newId(), '2029-05-10T08:30:00Z'],
      );
      const missed = await seedMissedSession(program.programId, 2, missedPhoto);
      await endProgram(program.programId, 'completed', EXPIRED);
      const { beforePhotoFileIds, afterPhotoFileIds } = await session(done);
      // Séance visée par une réclamation ouverte : ses photos restent (R-EX-10).
      const claimed = await endedProgram('completed', EXPIRED, false);
      await pool.query(
        `INSERT INTO claims (id, session_id, opened_by, reason, text, created_at, updated_at)
         VALUES ($1, $2, $3, 'damage', 'Vase cassé', now(), now())`,
        [newId(), claimed.sessionId, claimed.ownerId],
      );
      // Programme annulé depuis N mois − 1 jour : photos gardées.
      const recentProgram = await endedProgram('cancelled', RECENT, false);

      await expect(purge()).resolves.toEqual({ ...NOTHING, requestLocations: 3, photos: 7 });
      expect([...removedFiles].sort()).toEqual(
        [
          `cleaning_visit:${missedVisit}:${absence}`,
          `cleaning_visit:${doneVisit}:${photoA}`,
          `cleaning_visit:${doneVisit}:${photoB}`,
          `cleaning_session:${done}:${beforePhotoFileIds[0]}`,
          `cleaning_session:${done}:${afterPhotoFileIds[0]}`,
          `cleaning_session:${done}:${incidentPhoto}`,
          `cleaning_session:${missed}:${missedPhoto}`,
        ].sort(),
      );
      // Visites : plus aucune référence, effacement daté ; une visite manquée reste « manquée ».
      expect(await visit(missedVisit)).toMatchObject({
        status: 'missed',
        photoFileIds: [],
        missedPhotoFileId: null,
        photosErasedAt: new Date(NOW),
        version: 1,
      });
      expect(await visit(doneVisit)).toMatchObject({ photoFileIds: [], photosErasedAt: new Date(NOW) });
      expect(await visit(recentVisit)).toMatchObject({
        photoFileIds: [keptPhoto],
        photosErasedAt: null,
        version: 0,
      });
      // Séances : avant, après, absence et incidents partis ; la signature est conservée.
      expect(await session(done)).toMatchObject({
        status: 'completed',
        beforePhotoFileIds: [],
        afterPhotoFileIds: [],
        signatureFileId: signature,
        photosErasedAt: new Date(NOW),
      });
      expect(await prisma.sessionIncident.findMany({ where: { sessionId: done } })).toEqual([
        expect.objectContaining({ photoFileIds: [], note: 'Portail fermé' }),
      ]);
      expect(await session(missed)).toMatchObject({
        status: 'missed',
        missedPhotoFileId: null,
        photosErasedAt: new Date(NOW),
      });
      for (const id of [claimed.sessionId, recentProgram.sessionId]) {
        const kept = await session(id);
        expect([kept.beforePhotoFileIds.length, kept.afterPhotoFileIds.length]).toEqual([1, 1]);
        expect(kept.photosErasedAt).toBeNull();
      }

      // Rejeu : plus rien à supprimer chez file ni en base.
      removedFiles = [];
      await expect(purge()).resolves.toEqual(NOTHING);
      expect(removedFiles).toEqual([]);
      // La réclamation close, les photos de sa séance partent au passage suivant.
      await pool.query(
        `UPDATE claims SET status = 'rejected', decision = 'rejected', decision_reason = 'Non fondée', decided_by = $2, decided_at = now(), closed_at = now() WHERE session_id = $1`,
        [claimed.sessionId, newId()],
      );
      await expect(purge()).resolves.toEqual({ ...NOTHING, photos: 2 });
      expect((await session(claimed.sessionId)).photosErasedAt).toEqual(new Date(NOW));
    });

    it('file en échec sur une photo : la séance garde ses références, les autres passent ; reprise au passage suivant', async () => {
      const failing = await endedProgram('completed', EXPIRED, false);
      const other = await endedProgram('completed', EXPIRED, false);
      const { beforePhotoFileIds, afterPhotoFileIds } = await session(failing.sessionId);
      brokenFiles.add(afterPhotoFileIds[0]!);
      const errors: string[] = [];
      const report = await new PurgeExpiredDataUseCase(deps, (step, error) =>
        errors.push(`${step} : ${(error as Error).message}`),
      ).execute();
      expect(report).toEqual({ ...NOTHING, requestLocations: 2, photos: 2, failed: 1 });
      expect(errors).toEqual(['session_photos : file injoignable']);
      expect(await session(failing.sessionId)).toMatchObject({
        beforePhotoFileIds,
        afterPhotoFileIds,
        photosErasedAt: null,
        version: 0,
      });
      expect((await session(other.sessionId)).photosErasedAt).toEqual(new Date(NOW));

      // file répond de nouveau : la suppression est rejouée (sans effet chez file), les références partent.
      brokenFiles.clear();
      removedFiles = [];
      await expect(purge()).resolves.toEqual({ ...NOTHING, photos: 2 });
      expect([...removedFiles].sort()).toEqual(
        [
          `cleaning_session:${failing.sessionId}:${beforePhotoFileIds[0]}`,
          `cleaning_session:${failing.sessionId}:${afterPhotoFileIds[0]}`,
        ].sort(),
      );
      expect(await session(failing.sessionId)).toMatchObject({
        beforePhotoFileIds: [],
        afterPhotoFileIds: [],
        photosErasedAt: new Date(NOW),
      });
    });

    it('clés d’idempotence : supprimées après 7 jours', async () => {
      const actor = newId();
      const key = (suffix: string, createdAt: string) =>
        pool.query(
          `INSERT INTO idempotency_records (actor_id, operation, idempotency_key, request_hash, response, created_at)
           VALUES ($1, 'place.create', $2, 'empreinte', '{}', $3)`,
          [actor, `cle-${suffix}`, createdAt],
        );
      await key('ancienne', '2030-05-27T07:59:59Z');
      await key('recente', '2030-05-27T08:00:01Z');
      await expect(purge()).resolves.toEqual({ ...NOTHING, idempotencyRecords: 1 });
      const left = await prisma.idempotencyRecord.findMany({ where: { actorId: actor } });
      expect(left.map((row) => row.idempotencyKey)).toEqual(['cle-recente']);
    });

    it('deux répliques : un seul passage à la fois, chaque ligne écrite une seule fois', async () => {
      const first = await closedRequest(EXPIRED);
      // Une autre réplique tient le verrou du passage : rien n'est fait.
      const other = await pool.connect();
      try {
        await other.query('SELECT pg_advisory_lock($1)', [RETENTION_PURGE_LOCK]);
        await expect(purge()).resolves.toEqual({ ...NOTHING, ran: false });
        expect(await request(first.id)).toMatchObject({ ...PRESENT, version: 0 });
      } finally {
        await other.query('SELECT pg_advisory_unlock($1)', [RETENTION_PURGE_LOCK]);
        other.release();
      }
      // Deux passages lancés ensemble : chaque demande n'est effacée qu'une fois.
      const second = await closedRequest(EXPIRED);
      const reports = await Promise.all([purge(), purge()]);
      expect(reports.some((report) => report.ran)).toBe(true);
      expect(reports.reduce((sum, report) => sum + report.requestLocations, 0)).toBe(2);
      expect(reports.reduce((sum, report) => sum + report.failed, 0)).toBe(0);
      for (const id of [first.id, second.id]) {
        expect(await request(id)).toMatchObject({ ...ERASED, version: 1 });
      }
    });

    it('tâche planifiée : un passage par appel ; intervalle 0 = désactivée', async () => {
      const closed = await closedRequest(EXPIRED);
      const service = new RetentionPurgeService(deps, 0);
      service.onApplicationBootstrap();
      expect(await request(closed.id)).toMatchObject(PRESENT);
      await service.tick();
      expect(await request(closed.id)).toMatchObject({ ...ERASED, version: 1 });
      service.beforeApplicationShutdown();
    });
  });
});
