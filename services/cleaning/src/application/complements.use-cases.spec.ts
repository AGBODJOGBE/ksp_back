import { type AppError } from '@ksp/platform';
import { type Intervention, type Mission, remainingToSchedule } from '../domain/mission';
import { newPaymentState } from '../domain/payment';
import { type QuoteRequest, type SiteVisit } from '../domain/quote-request';
import { ScheduleGroupVisitUseCase } from './groups/group-visits.use-cases';
import { ScheduleInterventionUseCase } from './missions/admin-missions.use-cases';
import { ScheduleInterventionBatchUseCase } from './missions/intervention-batch.use-case';
import {
  RescheduleInterventionUseCase,
  UnscheduleInterventionUseCase,
} from './missions/intervention-changes.use-cases';
import {
  AddInterventionPhotoUseCase,
  ListInterventionPhotosUseCase,
  ListMyInterventionPhotosUseCase,
  RemoveInterventionPhotoUseCase,
} from './missions/intervention-photos.use-cases';
import { ScheduleVisitUseCase } from './requests/admin-requests.use-cases';
import { WatchRequestDeadlinesUseCase } from './requests/request-deadlines.use-cases';
import { DeclareUnavailabilityUseCase } from './teams/admin-teams.use-cases';
import {
  DeactivateAgentUseCase,
  DeactivateTeamUseCase,
  ReactivateAgentUseCase,
  ReactivateTeamUseCase,
  RemoveUnavailabilityUseCase,
} from './teams/agent-status.use-cases';
import {
  AGENT_ID,
  as,
  asAdmin,
  asAgent,
  asCustomer,
  asSupervisor,
  CUSTOMER_ID,
  homeCleaning,
  OTHER_AGENT_ID,
  ORGANIZATION_ID,
  OTHER_CUSTOMER_ID,
  testWorld,
  type TestWorld,
} from './testing/fakes';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';
const OTHER_MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1001';
const INTERVENTION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d4000';
const OTHER_INTERVENTION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d4001';
const THIRD_AGENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0004';
const TEAM_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5000';
const FILE_1 = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6001';
const FILE_2 = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6002';
const REQUEST_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7000';
const GROUP_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d8000';
const NOW = new Date('2026-10-23T08:00:00Z');
const DAY = 86_400_000;

function intervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: INTERVENTION_ID,
    status: 'planned',
    scheduledStart: new Date('2026-10-30T08:00:00Z'),
    durationMinutes: 120,
    agentIds: [AGENT_ID],
    checklist: [],
    incidentNote: null,
    beforePhotoFileIds: [],
    afterPhotoFileIds: [],
    startedAt: null,
    completedAt: null,
    cancellationCause: null,
    cancelledAt: null,
    ...overrides,
  };
}

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    requestId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2000',
    quoteId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d3000',
    customerId: CUSTOMER_ID,
    organizationId: null,
    status: 'scheduled',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12',
    location: null,
    landmark: null,
    groupId: null,
    placeType: null,
    chosenSlot: { start: new Date('2026-10-30T08:00:00Z'), end: new Date('2026-10-30T11:00:00Z') },
    recurrence: null,
    plannedInterventions: 1,
    interventions: [intervention()],
    payment: newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 50_000, 30),
    cancellationReason: null,
    daysPerWeek: null,
    suspension: null,
    warningLevel: 0,
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function visit(overrides: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9000',
    status: 'scheduled',
    scheduledAt: new Date('2026-10-30T08:30:00Z'),
    agentId: AGENT_ID,
    report: null,
    completedAt: null,
    ...overrides,
  };
}

function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    id: REQUEST_ID,
    status: 'received',
    customerId: CUSTOMER_ID,
    customerKind: 'individual',
    organizationId: null,
    serviceCode: 'home_cleaning',
    premisesType: 'house',
    quantity: 1,
    options: [],
    answers: null,
    optionSelections: [],
    frequency: null,
    pricingVersion: null,
    calculation: null,
    commune: 'Cotonou',
    address: 'Lot 12',
    groupId: null,
    placeType: null,
    location: null,
    landmark: null,
    geocodingProvider: null,
    geocodedAddress: null,
    preferredSlots: [],
    comment: null,
    recurrence: null,
    requestedTeamSize: 1,
    daysPerWeek: null,
    recommendedTeamSize: 1,
    estimate: null,
    visit: null,
    quote: null,
    missionId: null,
    closingReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

const quote = (id: string, validUntil: Date) => ({
  id,
  lines: [],
  subtotal: 25_000,
  interventionCount: 1,
  total: 25_000,
  proposedSlots: [],
  validUntil,
  depositPercent: 30,
  depositAmount: 7_500,
  recurrence: null,
  teamSize: 1,
  durationMinutes: 120,
  sentAt: new Date(validUntil.getTime() - 15 * DAY),
});

describe('compléments du Nettoyage (ADR-053)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    for (const [agentId, displayName] of [
      [AGENT_ID, 'Awa'],
      [OTHER_AGENT_ID, 'Koffi'],
      [THIRD_AGENT_ID, 'Afi'],
    ] as const) {
      world.agents.agents.set(agentId, { agentId, displayName, active: true, unavailabilities: [] });
    }
    world.missions.missions.set(MISSION_ID, mission());
  });

  const stored = () => world.missions.missions.get(MISSION_ID)!;
  const events = (type: string) => world.recorder.events.filter((event) => event.type === type);

  describe('photos des passages', () => {
    const add = (fileId: string, kind = 'before', as = asAgent) =>
      as(() =>
        new AddInterventionPhotoUseCase(world).execute({ interventionId: INTERVENTION_ID, fileId, kind }),
      );

    it('l’agent du passage rattache sa photo chez file, puis la référence est gardée par type', async () => {
      world.photos.upload(FILE_1, AGENT_ID);
      const view = await add(FILE_1);
      expect(view.mission.interventions[0]!.beforePhotoFileIds).toEqual([FILE_1]);
      expect(world.photos.files.get(FILE_1)!.subjectId).toBe(INTERVENTION_ID);
      expect(world.recorder.audit.at(-1)).toMatchObject({ action: 'intervention.photo_added' });
      // Rejouer le même ajout : rien de plus.
      await add(FILE_1);
      expect(stored().interventions[0]!.beforePhotoFileIds).toEqual([FILE_1]);
      expect(await code(add(FILE_1, 'after'))).toBe('CLEANING_VALIDATION_FAILED');
    });

    it('refus : type inconnu, agent d’un autre passage, fichier d’un autre compte, passage terminé', async () => {
      world.photos.upload(FILE_1, OTHER_AGENT_ID);
      expect(await code(add(FILE_1, 'pendant'))).toBe('CLEANING_VALIDATION_FAILED');
      expect(
        await code(
          asAgent(
            () =>
              new AddInterventionPhotoUseCase(world).execute({
                interventionId: INTERVENTION_ID,
                fileId: FILE_1,
                kind: 'before',
              }),
            OTHER_AGENT_ID,
          ),
        ),
      ).toBe('CLEANING_INTERVENTION_NOT_FOUND');
      expect(await code(add(FILE_1))).toBe('FILE_OWNER_MISMATCH');
      world.missions.missions.set(
        MISSION_ID,
        mission({ interventions: [intervention({ status: 'completed' })] }),
      );
      world.photos.upload(FILE_2, AGENT_ID);
      expect(await code(add(FILE_2))).toBe('CLEANING_INTERVENTION_CLOSED');
    });

    it('nombre maximal réglable par type', async () => {
      world.catalog.settings = { ...world.catalog.settings, maxInterventionPhotos: 1 };
      world.photos.upload(FILE_1, AGENT_ID);
      world.photos.upload(FILE_2, AGENT_ID);
      await add(FILE_1);
      expect(await code(add(FILE_2))).toBe('CLEANING_PHOTO_LIMIT_REACHED');
      await add(FILE_2, 'after');
      expect(stored().interventions[0]!.afterPhotoFileIds).toEqual([FILE_2]);
    });

    it('retrait par la supervision (fichier supprimé chez file), idempotent', async () => {
      world.photos.upload(FILE_1, AGENT_ID);
      await add(FILE_1);
      const remove = () =>
        asSupervisor(() =>
          new RemoveInterventionPhotoUseCase(world).execute({
            interventionId: INTERVENTION_ID,
            fileId: FILE_1,
          }),
        );
      await remove();
      expect(stored().interventions[0]!.beforePhotoFileIds).toEqual([]);
      expect(world.photos.files.get(FILE_1)!.deleted).toBe(true);
      await remove();
      expect(world.photos.calls.filter((call) => call.startsWith('remove'))).toHaveLength(1);
    });

    it('lecture : le client de la mission et la supervision ; pas un autre client', async () => {
      world.photos.upload(FILE_1, AGENT_ID);
      world.photos.upload(FILE_2, AGENT_ID);
      await add(FILE_1);
      await add(FILE_2, 'after');
      const mine = await asCustomer(() =>
        new ListMyInterventionPhotosUseCase(world).execute(INTERVENTION_ID),
      );
      expect(mine.map((photo) => [photo.kind, photo.fileId])).toEqual([
        ['before', FILE_1],
        ['after', FILE_2],
      ]);
      expect(mine[0]!.downloadUrl).toContain(FILE_1);
      const staff = await asSupervisor(() =>
        new ListInterventionPhotosUseCase(world).execute(INTERVENTION_ID),
      );
      expect(staff).toHaveLength(2);
      expect(
        await code(
          asCustomer(
            () => new ListMyInterventionPhotosUseCase(world).execute(INTERVENTION_ID),
            OTHER_CUSTOMER_ID,
          ),
        ),
      ).toBe('CLEANING_INTERVENTION_NOT_FOUND');
    });

    it('mission d’une organisation : photos lues dans son contexte seulement (ADR-049)', async () => {
      world.missions.missions.set(MISSION_ID, mission({ organizationId: ORGANIZATION_ID }));
      const list = (options: Parameters<typeof as>[2]) =>
        code(
          as(CUSTOMER_ID, () => new ListMyInterventionPhotosUseCase(world).execute(INTERVENTION_ID), options),
        );
      expect(await list({})).toBe('CLEANING_INTERVENTION_NOT_FOUND');
      expect(await list({ activeContext: ORGANIZATION_ID, orgRole: 'org_viewer' })).toBe('ok');
    });
  });

  describe('report et annulation pour replanifier', () => {
    const reschedule = (overrides: Partial<Parameters<RescheduleInterventionUseCase['execute']>[0]> = {}) =>
      asSupervisor(() =>
        new RescheduleInterventionUseCase(world).execute({
          interventionId: INTERVENTION_ID,
          scheduledStart: '2026-11-02T08:00:00Z',
          durationMinutes: 0,
          agentIds: [],
          teamId: '',
          reason: 'Client absent',
          ...overrides,
        }),
      );

    it('report : agents gardés, motif sur le passage, événement avec la date d’avant', async () => {
      const view = await reschedule();
      expect(view.mission.interventions[0]).toMatchObject({
        status: 'planned',
        scheduledStart: new Date('2026-11-02T08:00:00Z'),
        durationMinutes: 120,
        agentIds: [AGENT_ID],
        changeReason: 'Client absent',
      });
      expect(events('cleaning.intervention.rescheduled')).toEqual([
        {
          type: 'cleaning.intervention.rescheduled',
          payload: expect.objectContaining({
            previousStart: '2026-10-30T08:00:00.000Z',
            scheduledStart: '2026-11-02T08:00:00.000Z',
            agentIds: [AGENT_ID],
            releasedAgentIds: [],
          }),
        },
      ]);
    });

    it('report avec d’autres agents : agents libérés cités', async () => {
      await reschedule({ agentIds: [OTHER_AGENT_ID], durationMinutes: 90 });
      expect(stored().interventions[0]!.agentIds).toEqual([OTHER_AGENT_ID]);
      expect(events('cleaning.intervention.rescheduled')[0]!.payload).toMatchObject({
        durationMinutes: 90,
        releasedAgentIds: [AGENT_ID],
      });
    });

    it('mêmes contrôles que la planification : passé, conflit, visite, passage commencé, motif', async () => {
      expect(await code(reschedule({ scheduledStart: '2026-10-22T08:00:00Z' }))).toBe(
        'CLEANING_SLOT_INVALID',
      );
      expect(await code(reschedule({ reason: '' }))).toBe('CLEANING_VALIDATION_FAILED');
      world.missions.missions.set(
        OTHER_MISSION_ID,
        mission({
          id: OTHER_MISSION_ID,
          interventions: [
            intervention({ id: OTHER_INTERVENTION_ID, scheduledStart: new Date('2026-11-02T09:00:00Z') }),
          ],
        }),
      );
      expect(await code(reschedule())).toBe('CLEANING_TEAM_UNAVAILABLE');
      world.requests.requests.set(
        REQUEST_ID,
        request({
          status: 'visit_scheduled',
          visit: visit({ scheduledAt: new Date('2026-11-03T08:30:00Z') }),
        }),
      );
      expect(await code(reschedule({ scheduledStart: '2026-11-03T08:00:00Z' }))).toBe(
        'CLEANING_TEAM_UNAVAILABLE',
      );
      world.missions.missions.set(
        MISSION_ID,
        mission({ interventions: [intervention({ status: 'in_progress' })] }),
      );
      expect(await code(reschedule({ scheduledStart: '2026-11-05T08:00:00Z' }))).toBe(
        'CLEANING_INVALID_TRANSITION',
      );
    });

    it('annulation pour replanifier : un passage de nouveau à planifier, argent inchangé', async () => {
      const before = stored().payment;
      const view = await asSupervisor(() =>
        new UnscheduleInterventionUseCase(world).execute({
          interventionId: INTERVENTION_ID,
          reason: 'Pluie',
        }),
      );
      expect(view.mission.status).toBe('to_schedule');
      expect(view.mission.interventions[0]).toMatchObject({
        status: 'cancelled',
        cancellationCause: 'unscheduled',
        changeReason: 'Pluie',
      });
      expect(view.mission.plannedInterventions).toBe(1);
      expect(stored().payment).toEqual(before);
      expect(events('cleaning.intervention.unscheduled')[0]!.payload).toMatchObject({
        previousStart: '2026-10-30T08:00:00.000Z',
        releasedAgentIds: [AGENT_ID],
      });
      // Le passage se replanifie normalement.
      const again = await asSupervisor(() =>
        new ScheduleInterventionUseCase(world).execute({
          missionId: MISSION_ID,
          scheduledStart: '2026-11-04T08:00:00Z',
          durationMinutes: 120,
          agentIds: [AGENT_ID],
          teamId: '',
        }),
      );
      expect(again.mission.status).toBe('scheduled');
    });

    describe('avec un plan de dates (ADR-052)', () => {
      const PLANNED = mission({
        schedule: {
          mode: 'dates',
          dates: ['2026-11-02', '2026-11-09'],
          startDate: '',
          endDate: '',
          weekdays: [],
          everyWeeks: 0,
          monthDays: [],
          weeksOfMonth: [],
          startTime: '09:00',
          excludedDates: [],
          extraDates: [],
        },
        scheduledDates: ['2026-11-02', '2026-11-09'],
        plannedInterventions: 2,
        interventions: [
          intervention({ scheduledStart: new Date('2026-11-02T08:00:00Z') }),
          intervention({ id: OTHER_INTERVENTION_ID, scheduledStart: new Date('2026-11-09T08:00:00Z') }),
        ],
      });
      const batch = () =>
        asSupervisor(() =>
          new ScheduleInterventionBatchUseCase(world).execute({
            missionId: MISSION_ID,
            idempotencyKey: 'lot-complements-1',
            dates: [],
            until: '',
            startTime: '',
            durationMinutes: 120,
            agentIds: [AGENT_ID],
            teamId: '',
            skipConflicts: false,
          }),
        );
      beforeEach(() => world.missions.missions.set(MISSION_ID, PLANNED));

      it('une date libérée par l’annulation pour replanifier redevient une date restante du lot', async () => {
        await asSupervisor(() =>
          new UnscheduleInterventionUseCase(world).execute({
            interventionId: INTERVENTION_ID,
            reason: 'Pluie',
          }),
        );
        const { outcome } = await batch();
        expect(outcome.scheduledDates).toEqual(['2026-11-02']);
        expect(stored().interventions.filter((i) => i.status === 'planned')).toHaveLength(2);
      });

      it('un passage reporté hors des dates du plan compte dans les passages prévus', async () => {
        await asSupervisor(() =>
          new RescheduleInterventionUseCase(world).execute({
            interventionId: OTHER_INTERVENTION_ID,
            scheduledStart: '2026-11-12T08:00:00Z',
            durationMinutes: 0,
            agentIds: [],
            teamId: '',
            reason: 'Jour férié',
          }),
        );
        expect(remainingToSchedule(stored())).toBe(0);
        expect(await code(batch())).toBe('CLEANING_NO_INTERVENTION_LEFT');
      });
    });

    it('réservé à la supervision', async () => {
      expect(
        await code(
          asAgent(() =>
            new UnscheduleInterventionUseCase(world).execute({
              interventionId: INTERVENTION_ID,
              reason: 'x',
            }),
          ),
        ),
      ).toBe('AUTH_FORBIDDEN');
    });
  });

  describe('agents et équipes', () => {
    it('désactivation refusée avec la liste des passages et visites à venir', async () => {
      world.requests.requests.set(REQUEST_ID, request({ status: 'visit_scheduled', visit: visit() }));
      const error = await asAdmin(() => new DeactivateAgentUseCase(world).execute(AGENT_ID)).catch(
        (e: AppError) => e,
      );
      expect((error as AppError).code).toBe('CLEANING_AGENT_HAS_ASSIGNMENTS');
      expect((error as AppError).details?.['assignments']).toEqual([
        expect.objectContaining({ kind: 'intervention', id: INTERVENTION_ID, missionId: MISSION_ID }),
        expect.objectContaining({ kind: 'visit', requestId: REQUEST_ID }),
      ]);
    });

    it('désactivation puis réactivation d’un agent sans affectation à venir', async () => {
      const agent = await asAdmin(() => new DeactivateAgentUseCase(world).execute(OTHER_AGENT_ID));
      expect(agent.active).toBe(false);
      expect(world.agents.agents.get(OTHER_AGENT_ID)!.active).toBe(false);
      expect(
        await code(
          asSupervisor(() =>
            new ScheduleVisitUseCase(world).execute({
              requestId: REQUEST_ID,
              scheduledAt: '2026-11-01T08:00:00Z',
              agentId: OTHER_AGENT_ID,
            }),
          ),
        ),
      ).toBe('CLEANING_REQUEST_NOT_FOUND');
      await asAdmin(() => new ReactivateAgentUseCase(world).execute(OTHER_AGENT_ID));
      expect(world.agents.agents.get(OTHER_AGENT_ID)!.active).toBe(true);
    });

    it('indisponibilité qui chevauche un passage : refus, puis enregistrée avec force et la liste', async () => {
      const declare = (force?: boolean) =>
        asAdmin(() =>
          new DeclareUnavailabilityUseCase(world).execute({
            agentId: AGENT_ID,
            start: '2026-10-30T00:00:00Z',
            end: '2026-10-31T00:00:00Z',
            reason: 'Congé',
            force,
          }),
        );
      expect(await code(declare())).toBe('CLEANING_UNAVAILABILITY_CONFLICT');
      const { agent, overlapping } = await declare(true);
      expect(overlapping.map((item) => item.id)).toEqual([INTERVENTION_ID]);
      expect(agent.unavailabilities).toHaveLength(1);
      // Suppression de l'indisponibilité, puis inconnue.
      const id = agent.unavailabilities[0]!.id;
      const remove = () =>
        asAdmin(() =>
          new RemoveUnavailabilityUseCase(world).execute({ agentId: AGENT_ID, unavailabilityId: id }),
        );
      expect((await remove()).unavailabilities).toEqual([]);
      expect(await code(remove())).toBe('CLEANING_UNAVAILABILITY_NOT_FOUND');
    });

    it('équipe désactivée refusée à la planification ; membres désactivés ignorés', async () => {
      world.agents.teams.set(TEAM_ID, {
        id: TEAM_ID,
        name: 'Équipe A',
        memberIds: [OTHER_AGENT_ID, THIRD_AGENT_ID],
        active: true,
      });
      world.agents.agents.set(THIRD_AGENT_ID, { ...world.agents.agents.get(THIRD_AGENT_ID)!, active: false });
      const view = await asSupervisor(() =>
        new RescheduleInterventionUseCase(world).execute({
          interventionId: INTERVENTION_ID,
          scheduledStart: '2026-11-02T08:00:00Z',
          durationMinutes: 0,
          agentIds: [],
          teamId: TEAM_ID,
          reason: 'Autre équipe',
        }),
      );
      expect(view.mission.interventions[0]!.agentIds).toEqual([OTHER_AGENT_ID]);
      const team = await asAdmin(() => new DeactivateTeamUseCase(world).execute(TEAM_ID));
      expect(team.active).toBe(false);
      expect(
        await code(
          asSupervisor(() =>
            new RescheduleInterventionUseCase(world).execute({
              interventionId: INTERVENTION_ID,
              scheduledStart: '2026-11-03T08:00:00Z',
              durationMinutes: 0,
              agentIds: [],
              teamId: TEAM_ID,
              reason: 'Encore',
            }),
          ),
        ),
      ).toBe('CLEANING_TEAM_INACTIVE');
      expect((await asAdmin(() => new ReactivateTeamUseCase(world).execute(TEAM_ID))).active).toBe(true);
    });
  });

  describe('visites : agenda de l’agent', () => {
    const scheduleVisit = (scheduledAt: string, agentId = AGENT_ID) =>
      asSupervisor(() =>
        new ScheduleVisitUseCase(world).execute({ requestId: REQUEST_ID, scheduledAt, agentId }),
      );

    beforeEach(() => world.requests.requests.set(REQUEST_ID, request()));

    it('conflit avec un passage ou une indisponibilité de l’agent', async () => {
      expect(await code(scheduleVisit('2026-10-30T09:00:00Z'))).toBe('CLEANING_TEAM_UNAVAILABLE');
      world.agents.agents.set(OTHER_AGENT_ID, {
        ...world.agents.agents.get(OTHER_AGENT_ID)!,
        unavailabilities: [
          {
            id: 'u1',
            slot: { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-02T00:00:00Z') },
            reason: null,
          },
        ],
      });
      expect(await code(scheduleVisit('2026-11-01T10:00:00Z', OTHER_AGENT_ID))).toBe(
        'CLEANING_TEAM_UNAVAILABLE',
      );
      expect(await code(scheduleVisit('2026-10-30T10:30:00Z'))).toBe('ok');
    });

    it('replanifier sa propre visite n’est pas un conflit ; une autre visite de l’agent l’est', async () => {
      await scheduleVisit('2026-11-01T08:00:00Z');
      expect(await code(scheduleVisit('2026-11-01T08:30:00Z'))).toBe('ok');
      const other = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7001';
      world.requests.requests.set(other, request({ id: other, groupId: GROUP_ID }));
      world.requests.groups.set(GROUP_ID, {
        id: GROUP_ID,
        customerId: CUSTOMER_ID,
        placeType: 'house',
        commune: 'Cotonou',
        createdAt: NOW,
      });
      expect(
        await code(
          asSupervisor(() =>
            new ScheduleGroupVisitUseCase(world).execute({
              groupId: GROUP_ID,
              scheduledAt: '2026-11-01T09:00:00Z',
              agentId: AGENT_ID,
            }),
          ),
        ),
      ).toBe('CLEANING_TEAM_UNAVAILABLE');
    });
  });

  describe('échéances des demandes (tâche planifiée)', () => {
    const run = () => new WatchRequestDeadlinesUseCase(world).execute();
    const g1 = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7101';
    const g2 = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d7102';

    it('devis expirés : demandes « expirées », un événement par groupe ; rejeu sans effet', async () => {
      for (const id of [g1, g2]) {
        world.requests.requests.set(
          id,
          request({
            id,
            status: 'quote_sent',
            groupId: GROUP_ID,
            quote: quote(id.replace('7d71', '7d72'), NOW),
          }),
        );
      }
      expect(await run()).toMatchObject({ expired: 2, failed: 0 });
      expect(world.requests.requests.get(g1)!.status).toBe('expired');
      expect(events('cleaning.quote.expired')).toEqual([
        {
          type: 'cleaning.quote.expired',
          payload: expect.objectContaining({
            customerId: CUSTOMER_ID,
            groupId: GROUP_ID,
            quotes: [
              expect.objectContaining({ requestId: g1, serviceName: 'Nettoyage à domicile' }),
              expect.objectContaining({ requestId: g2 }),
            ],
          }),
        },
      ]);
      await run();
      expect(events('cleaning.quote.expired')).toHaveLength(1);
    });

    it('rappel N jours avant l’expiration, une seule fois par devis ; 0 le désactive', async () => {
      world.requests.requests.set(
        g1,
        request({
          id: g1,
          status: 'quote_sent',
          quote: quote(`${g1.slice(0, -1)}9`, new Date(NOW.getTime() + DAY)),
        }),
      );
      world.catalog.settings = { ...world.catalog.settings, quoteExpiryReminderDays: 0 };
      await run();
      expect(events('cleaning.quote.expiry_reminded')).toHaveLength(0);
      world.catalog.settings = { ...world.catalog.settings, quoteExpiryReminderDays: 2 };
      expect(await run()).toMatchObject({ reminded: 1 });
      await run();
      expect(events('cleaning.quote.expiry_reminded')).toEqual([
        {
          type: 'cleaning.quote.expiry_reminded',
          payload: expect.objectContaining({
            reminderDays: 2,
            quotes: [expect.objectContaining({ requestId: g1 })],
          }),
        },
      ]);
    });

    it('visite d’une demande refusée : annulée, message à l’agent ; affichée annulée avant la tâche', async () => {
      world.requests.requests.set(REQUEST_ID, request({ status: 'rejected', visit: visit() }));
      expect(await run()).toMatchObject({ visitsCancelled: 1 });
      expect(world.requests.requests.get(REQUEST_ID)!.visit!.status).toBe('cancelled');
      expect(events('cleaning.visit.cancelled')[0]!.payload).toMatchObject({
        agentId: AGENT_ID,
        requestIds: [REQUEST_ID],
        outcome: 'rejected',
      });
      await run();
      expect(events('cleaning.visit.cancelled')).toHaveLength(1);
    });

    it('visite commune : gardée tant qu’une demande du groupe est ouverte', async () => {
      world.requests.groups.set(GROUP_ID, {
        id: GROUP_ID,
        customerId: CUSTOMER_ID,
        placeType: 'house',
        commune: 'Cotonou',
        createdAt: NOW,
      });
      const common = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9999';
      world.requests.requests.set(
        g1,
        request({
          id: g1,
          groupId: GROUP_ID,
          status: 'cancelled',
          visit: visit({ id: g1, groupVisitId: common }),
        }),
      );
      world.requests.requests.set(
        g2,
        request({
          id: g2,
          groupId: GROUP_ID,
          status: 'visit_scheduled',
          visit: visit({ id: g2, groupVisitId: common }),
        }),
      );
      await run();
      expect(world.requests.requests.get(g1)!.visit!.status).toBe('cancelled');
      expect(world.requests.requests.get(g2)!.visit!.status).toBe('scheduled');
      expect(events('cleaning.visit.cancelled')).toHaveLength(0);
      world.requests.requests.set(g2, { ...world.requests.requests.get(g2)!, status: 'rejected' });
      await run();
      expect(events('cleaning.visit.cancelled')[0]!.payload).toMatchObject({
        visitId: common,
        requestIds: [g2],
        groupId: GROUP_ID,
      });
    });
  });
});
