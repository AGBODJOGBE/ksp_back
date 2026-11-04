import { type AppError } from '@ksp/platform';
import { gardenService } from '../../domain/testing';
import { DeactivateZoneUseCase, ListZonesUseCase } from '../catalog/zones.use-cases';
import { GetMissionDetailUseCase, ListMissionsUseCase } from '../missions/admin-missions.use-cases';
import { CorrectLocationUseCase } from '../places/location-correction.use-case';
import { RequestQuoteGroupUseCase, type RequestQuoteGroupInput } from '../places/request-groups.use-cases';
import { PurgeLocationsUseCase, EraseCustomerLocationsUseCase } from '../privacy/location-privacy.use-cases';
import { CompleteVisitUseCase, ScheduleVisitUseCase } from '../requests/admin-requests.use-cases';
import {
  CompleteInterventionUseCase,
  ScheduleInterventionUseCase,
} from '../missions/admin-missions.use-cases';
import {
  AGENT_ID,
  asAdmin,
  asAgent,
  asCustomer,
  asSupervisor,
  CUSTOMER_ID,
  homeCleaning,
  OTHER_AGENT_ID,
  OTHER_CUSTOMER_ID,
  placeType,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import { CancelRequestGroupUseCase, RejectRequestGroupUseCase } from './group-decisions.use-cases';
import { ScheduleGroupInterventionsUseCase } from './group-interventions.use-case';
import { AcceptGroupQuotesUseCase, SendGroupQuotesUseCase } from './group-quotes.use-cases';
import { GroupTotalsUseCase } from './group-totals.use-case';
import {
  CompleteGroupVisitUseCase,
  ListVisitsUseCase,
  ScheduleGroupVisitUseCase,
} from './group-visits.use-cases';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

const SLOT = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T11:00:00Z' };
const POINT = { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 15 };
const VISIT_AT = '2026-10-26T09:00:00Z';
const HOME = {
  serviceCode: 'home_cleaning',
  answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
  optionSelections: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};
const GARDEN = {
  serviceCode: 'garden_maintenance',
  answers: { surface: 400, condition: 'maintained' },
  optionSelections: [],
  frequency: 'once',
};
const PAGE = { limit: 20, cursor: null };
const LINE = { label: 'Jardin', quantity: 1, unitPrice: 20_000, amount: 20_000 };

function world(): TestWorld {
  const w = testWorld();
  w.catalog.services.set('home_cleaning', homeCleaning());
  w.catalog.services.set('garden_maintenance', gardenService());
  w.catalog.placeTypes.set('house', placeType({ serviceCodes: ['home_cleaning', 'garden_maintenance'] }));
  for (const [agentId, displayName] of [
    [AGENT_ID, 'Awa'],
    [OTHER_AGENT_ID, 'Koffi'],
  ] as const) {
    w.agents.agents.set(agentId, { agentId, displayName, active: true, unavailabilities: [] });
  }
  return w;
}

function groupInput(overrides: Partial<RequestQuoteGroupInput> = {}): RequestQuoteGroupInput {
  return {
    idempotencyKey: 'grp-0001',
    placeType: 'house',
    location: POINT,
    landmark: 'Portail bleu',
    items: [HOME, GARDEN],
    preferredSlots: [SLOT],
    ...overrides,
  };
}

describe('demandes groupées : refus, annulation, visite commune (ADR-035)', () => {
  let w: TestWorld;
  let groupId: string;
  let home: string;
  let garden: string;
  beforeEach(async () => {
    w = world();
    const view = await asCustomer(() => new RequestQuoteGroupUseCase(w).execute(groupInput()));
    groupId = view.group.id;
    [home, garden] = view.requests.map((request) => request.id) as [string, string];
  });

  const scheduleGroupVisit = (extra: object = {}) =>
    asSupervisor(() =>
      new ScheduleGroupVisitUseCase(w).execute({
        groupId,
        scheduledAt: VISIT_AT,
        agentId: AGENT_ID,
        ...extra,
      }),
    );

  it('groupe sans demande refusable : erreur claire avec les demandes ignorées', async () => {
    await asCustomer(() =>
      new CancelRequestGroupUseCase(w).execute({ groupId, idempotencyKey: 'cancel-0001' }),
    );
    const error = await asSupervisor(() =>
      new RejectRequestGroupUseCase(w).execute({ groupId, reason: 'x' }),
    ).catch((caught: AppError) => caught);
    expect(error).toMatchObject({
      code: 'CLEANING_GROUP_NO_ELIGIBLE_REQUEST',
      details: {
        skipped: [expect.objectContaining({ requestId: home, reason: 'not_open' }), expect.anything()],
      },
    });
    // Clé déjà utilisée pour un autre groupe : refus.
    const other = await asCustomer(() =>
      new RequestQuoteGroupUseCase(w).execute(groupInput({ idempotencyKey: 'grp-0002' })),
    );
    expect(
      await code(
        asCustomer(() =>
          new CancelRequestGroupUseCase(w).execute({
            groupId: other.group.id,
            idempotencyKey: 'cancel-0001',
          }),
        ),
      ),
    ).toBe('CLEANING_IDEMPOTENCY_KEY_REUSED');
  });

  it('refus par le superviseur : une demande acceptée n’est pas touchée', async () => {
    const request = w.requests.requests.get(garden)!;
    w.requests.requests.set(garden, { ...request, status: 'accepted', missionId: null });
    const run = () =>
      asSupervisor(() =>
        new RejectRequestGroupUseCase(w).execute({
          groupId,
          reason: 'Hors périmètre',
          idempotencyKey: 'rej-00001',
        }),
      );
    const outcome = await run();
    expect(outcome.affectedIds).toEqual([home]);
    expect(outcome.skippedRequests).toEqual([{ requestId: garden, status: 'accepted', reason: 'not_open' }]);
    expect(w.requests.requests.get(home)).toMatchObject({
      status: 'rejected',
      closingReason: 'Hors périmètre',
    });
    expect(w.requests.requests.get(garden)!.status).toBe('accepted');
    const events = w.recorder.events.filter((e) => e.type === 'cleaning.request.cancelled');
    expect(events.map((e) => e.payload)).toEqual([
      expect.objectContaining({ requestId: home, cancelledBy: 'supervisor', outcome: 'rejected', groupId }),
    ]);
    // Rejeu : même résultat, rien de plus écrit.
    const writes = w.recorder.changes.length;
    expect(await run()).toEqual(outcome);
    expect(w.recorder.changes.length).toBe(writes);
    expect(
      await code(asCustomer(() => new RejectRequestGroupUseCase(w).execute({ groupId, reason: 'x' }))),
    ).toBe('AUTH_FORBIDDEN');
  });

  it('annulation par le client : propriétaire seulement, clé obligatoire, mêmes événements', async () => {
    expect(
      await code(
        asCustomer(
          () => new CancelRequestGroupUseCase(w).execute({ groupId, idempotencyKey: 'cancel-0001' }),
          OTHER_CUSTOMER_ID,
        ),
      ),
    ).toBe('CLEANING_REQUEST_GROUP_NOT_FOUND');
    expect(
      await code(asCustomer(() => new CancelRequestGroupUseCase(w).execute({ groupId, idempotencyKey: '' }))),
    ).toBe('CLEANING_VALIDATION_FAILED');
    const outcome = await asCustomer(() =>
      new CancelRequestGroupUseCase(w).execute({
        groupId,
        reason: 'Plus besoin',
        idempotencyKey: 'cancel-0001',
      }),
    );
    expect(outcome.affectedIds.sort()).toEqual([home, garden].sort());
    expect(w.recorder.events.filter((e) => e.type === 'cleaning.request.cancelled')).toHaveLength(2);
    expect(await w.requests.countOpen(CUSTOMER_ID, w.clock.now())).toBe(0);
  });

  it('visite commune : même heure, même agent, un seul événement ; exclusion = détachement', async () => {
    const outcome = await scheduleGroupVisit();
    expect(outcome.affectedIds).toEqual([home, garden]);
    const [a, b] = [w.requests.requests.get(home)!, w.requests.requests.get(garden)!];
    expect(a.visit).toMatchObject({
      status: 'scheduled',
      agentId: AGENT_ID,
      groupVisitId: outcome.groupVisitId,
    });
    expect(b.visit!.groupVisitId).toBe(outcome.groupVisitId);
    const visits = w.recorder.events.filter((e) => e.type === 'cleaning.visit.scheduled');
    expect(visits).toHaveLength(1);
    expect(visits[0]!.payload).toMatchObject({
      groupId,
      groupVisitId: outcome.groupVisitId,
      requestIds: [home, garden],
    });

    // Replanification en excluant le jardin : il garde sa visite, qui devient la sienne.
    const again = await scheduleGroupVisit({
      scheduledAt: '2026-10-27T09:00:00Z',
      excludeRequestIds: [garden],
    });
    expect(again.groupVisitId).toBe(outcome.groupVisitId);
    expect(again.skippedRequests).toEqual([
      { requestId: garden, status: 'visit_scheduled', reason: 'excluded' },
    ]);
    expect(w.requests.requests.get(garden)!.visit).toMatchObject({
      groupVisitId: null,
      scheduledAt: new Date(VISIT_AT),
    });
    // Une demande avec sa propre visite reste à l'écart d'une nouvelle visite commune.
    const third = await scheduleGroupVisit();
    expect(third.skippedRequests).toEqual([
      { requestId: garden, status: 'visit_scheduled', reason: 'own_visit' },
    ]);
  });

  it('planifier une demande seule la détache de la visite commune', async () => {
    const outcome = await scheduleGroupVisit();
    await asSupervisor(() =>
      new ScheduleVisitUseCase(w).execute({
        requestId: home,
        scheduledAt: '2026-10-28T09:00:00Z',
        agentId: OTHER_AGENT_ID,
      }),
    );
    expect(w.requests.requests.get(home)!.visit!.groupVisitId).toBeNull();
    expect(w.requests.requests.get(garden)!.visit!.groupVisitId).toBe(outcome.groupVisitId);
    expect(w.recorder.audit.at(-1)!.details).toMatchObject({ detachedFrom: outcome.groupVisitId });
  });

  it('compte rendu commun : agent de la visite oui, autre agent non ; liste des visites de l’agent', async () => {
    await scheduleGroupVisit();
    w.clock.current = new Date('2026-10-26T11:00:00Z');
    expect(
      await code(
        asAgent(() => new CompleteGroupVisitUseCase(w).execute({ groupId, report: 'ok' }), OTHER_AGENT_ID),
      ),
    ).toBe('CLEANING_VISIT_NOT_FOUND');
    const before = await asAgent(() => new ListVisitsUseCase(w).execute({ page: PAGE }));
    expect(before.items).toHaveLength(1);
    expect(before.items[0]!.requests.map((r) => r.serviceCode)).toEqual([
      'home_cleaning',
      'garden_maintenance',
    ]);
    expect(before.items[0]!.requests[0]!.location).toEqual(POINT);
    expect(
      (await asAgent(() => new ListVisitsUseCase(w).execute({ page: PAGE }), OTHER_AGENT_ID)).items,
    ).toEqual([]);

    const outcome = await asAgent(() =>
      new CompleteGroupVisitUseCase(w).execute({ groupId, report: 'Tout vu' }),
    );
    expect(outcome.affectedIds).toEqual([home, garden]);
    expect(w.requests.requests.get(garden)!.visit).toMatchObject({ status: 'completed', report: 'Tout vu' });
    // Visite terminée : l'agent ne voit plus la position ni le repère ; la supervision si.
    const after = await asAgent(() => new ListVisitsUseCase(w).execute({ page: PAGE }));
    expect(after.items[0]!.requests[0]).toMatchObject({ location: null, landmark: null, address: '' });
    const supervision = await asSupervisor(() =>
      new ListVisitsUseCase(w).execute({ page: PAGE, agentId: AGENT_ID, status: 'completed' }),
    );
    expect(supervision.items[0]!.requests[0]!.location).toEqual(POINT);
  });

  it('compte rendu par demande ouvert à l’agent affecté seulement', async () => {
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(w).execute({ requestId: home, scheduledAt: VISIT_AT, agentId: AGENT_ID }),
    );
    w.clock.current = new Date('2026-10-26T11:00:00Z');
    const complete = (agentId: string) =>
      asAgent(
        () => new CompleteVisitUseCase(w).execute({ visitId: visited.visit!.id, report: 'ok' }),
        agentId,
      );
    expect(await code(complete(OTHER_AGENT_ID))).toBe('CLEANING_VISIT_NOT_FOUND');
    const done = await complete(AGENT_ID);
    expect(done).toMatchObject({ location: null, landmark: null });
  });
});

describe('correction de position, zones, purge (ADR-035)', () => {
  let w: TestWorld;
  let groupId: string;
  let home: string;
  beforeEach(async () => {
    w = world();
    const view = await asCustomer(() => new RequestQuoteGroupUseCase(w).execute(groupInput()));
    groupId = view.group.id;
    home = view.requests[0]!.id;
  });

  it('supervision ou agent de la visite : commune recalculée, tout le groupe, audit sans coordonnées', async () => {
    const correct = () =>
      new CorrectLocationUseCase(w).execute({
        requestId: home,
        location: { latitude: 6.37, longitude: 2.39 },
        landmark: 'Portail vert',
      });
    expect(await code(asAgent(correct))).toBe('CLEANING_REQUEST_NOT_FOUND');
    await asSupervisor(() =>
      new ScheduleVisitUseCase(w).execute({ requestId: home, scheduledAt: VISIT_AT, agentId: AGENT_ID }),
    );
    expect(await code(asAgent(correct, OTHER_AGENT_ID))).toBe('CLEANING_REQUEST_NOT_FOUND');
    w.geocoder.result = { provider: 'google', communes: ['Cotonou'], displayAddress: 'Akpakpa, Cotonou' };
    const result = await asAgent(correct);
    expect(result.requestIds).toHaveLength(2);
    for (const request of w.requests.requests.values()) {
      expect(request).toMatchObject({
        commune: 'Cotonou',
        location: { latitude: 6.37, longitude: 2.39, accuracyMeters: null },
        landmark: 'Portail vert',
        address: 'Portail vert',
        geocodingProvider: 'google',
      });
    }
    const audit = w.recorder.audit.at(-1)!;
    expect(audit).toMatchObject({
      action: 'request.location_corrected',
      details: { groupId, communeChanged: true },
    });
    expect(JSON.stringify(audit)).not.toMatch(/6\.37|Portail vert/);
    // Commune non desservie : refus.
    w.geocoder.result = { provider: 'nominatim', communes: ['Parakou'], displayAddress: null };
    expect(await code(asSupervisor(correct))).toBe('CLEANING_ZONE_NOT_COVERED');
  });

  it('zone avec demandes ouvertes : 409 sans confirmation, nombres affichés ; désactivée avec confirm', async () => {
    const zones = await asAdmin(() => new ListZonesUseCase(w).execute());
    expect(zones.find((view) => view.zone.code === 'abomey-calavi')!.activity).toEqual({
      openRequests: 2,
      activeMissions: 0,
    });
    const deactivate = (confirm?: boolean) =>
      asAdmin(() => new DeactivateZoneUseCase(w).execute({ code: 'abomey-calavi', confirm }));
    const refused = await deactivate().catch((error: AppError) => error);
    expect(refused).toMatchObject({
      code: 'CLEANING_ZONE_HAS_ACTIVITY',
      kind: 'CONFLICT',
      details: { openRequests: 2, activeMissions: 0 },
    });
    const done = await deactivate(true);
    expect(done).toMatchObject({ zone: { active: false }, activity: { openRequests: 2 } });
    // Les demandes continuent.
    expect(w.requests.requests.get(home)!.status).toBe('received');
    expect(await asAdmin(() => new DeactivateZoneUseCase(w).execute({ code: 'cotonou' }))).toMatchObject({
      zone: { active: false },
    });
  });

  it('purge : demandes clôturées depuis plus de N mois effacées, idempotente ; compte anonymisé', async () => {
    await asCustomer(() =>
      new CancelRequestGroupUseCase(w).execute({ groupId, idempotencyKey: 'cancel-0001' }),
    );
    const other = await asCustomer(() =>
      new RequestQuoteGroupUseCase(w).execute(groupInput({ idempotencyKey: 'grp-0009' })),
    );
    const purge = () => new PurgeLocationsUseCase(w).execute();
    expect((await purge()).requests).toBe(0);
    // 12 mois par défaut : rien avant ; réglage abaissé à 6 mois : effacé.
    w.clock.current = new Date('2027-06-01T00:00:00Z');
    expect((await purge()).requests).toBe(0);
    w.catalog.settings = { ...w.catalog.settings, locationRetentionMonths: 6 };
    expect(await purge()).toMatchObject({ requests: 2, missions: 0 });
    expect(w.requests.requests.get(home)).toMatchObject({
      location: null,
      landmark: null,
      geocodedAddress: null,
      address: '',
    });
    expect((await purge()).requests).toBe(0);

    const erase = () =>
      new EraseCustomerLocationsUseCase(w).execute({
        eventId: '0192f1c4-7a2b-7c3d-8e4f-000000000001',
        eventType: 'identity.user.deleted',
        userId: CUSTOMER_ID,
      });
    expect(await erase()).toBe('processed');
    expect(await erase()).toBe('duplicate');
    expect(w.requests.requests.get(other.requests[0]!.id)!.location).toBeNull();
  });
});

describe('devis, acceptation et planification communs ; totaux (ADR-035)', () => {
  let w: TestWorld;
  let groupId: string;
  let home: string;
  let garden: string;
  beforeEach(async () => {
    w = world();
    const view = await asCustomer(() => new RequestQuoteGroupUseCase(w).execute(groupInput()));
    groupId = view.group.id;
    [home, garden] = view.requests.map((request) => request.id) as [string, string];
    await asSupervisor(() =>
      new ScheduleGroupVisitUseCase(w).execute({ groupId, scheduledAt: VISIT_AT, agentId: AGENT_ID }),
    );
    w.clock.current = new Date('2026-10-26T11:00:00Z');
    await asSupervisor(() => new CompleteGroupVisitUseCase(w).execute({ groupId, report: 'ok' }));
    w.clock.current = new Date('2026-10-23T08:00:00Z');
  });

  const sendQuotes = () =>
    asSupervisor(() =>
      new SendGroupQuotesUseCase(w).execute({
        groupId,
        proposedSlots: [SLOT],
        validityDays: 0,
        quotes: [
          { requestId: home, lines: [], teamSize: 0, durationMinutes: 180 },
          { requestId: garden, lines: [LINE], teamSize: 2, durationMinutes: 60 },
        ],
      }),
    );

  it('devis envoyés ensemble, chiffrés séparément ; acceptation commune ; totaux du groupe', async () => {
    const view = () => w.requests.findGroup(groupId).then((found) => found!);
    expect(await new GroupTotalsUseCase(w).execute(await view())).toEqual({
      quotesTotal: null,
      remainingDue: null,
    });
    const sent = await sendQuotes();
    expect(sent.affectedIds).toEqual([home, garden]);
    expect(w.recorder.events.filter((e) => e.type === 'cleaning.quote.sent')).toHaveLength(2);
    const homeTotal = w.requests.requests.get(home)!.quote!.total;
    expect(w.requests.requests.get(garden)!.quote!.total).toBe(20_000);
    expect((await new GroupTotalsUseCase(w).execute(await view())).quotesTotal).toBe(homeTotal + 20_000);

    const accept = () =>
      asCustomer(() =>
        new AcceptGroupQuotesUseCase(w).execute({
          groupId,
          slotStart: SLOT.start,
          paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
          idempotencyKey: 'acc-group-1',
        }),
      );
    const accepted = await accept();
    expect(accepted.missionIds).toHaveLength(2);
    expect(await accept()).toEqual(accepted);
    expect(w.recorder.events.filter((e) => e.type === 'cleaning.booking.confirmed')).toHaveLength(2);
    expect(await new GroupTotalsUseCase(w).execute(await view())).toEqual({
      quotesTotal: homeTotal + 20_000,
      remainingDue: homeTotal + 20_000,
    });

    // Planification commune : même équipe, même créneau, pas de conflit dans le groupe.
    const plan = await asSupervisor(() =>
      new ScheduleGroupInterventionsUseCase(w).execute({
        groupId,
        missionIds: [],
        scheduledStart: SLOT.start,
        durationMinutes: 120,
        agentIds: [AGENT_ID],
        teamId: '',
      }),
    );
    expect(plan.outcome.missionIds).toHaveLength(2);
    // Un autre passage du groupe au même créneau : toujours pas de conflit ; hors groupe : conflit.
    const [first] = plan.missions;
    w.missions.missions.set(first!.id, { ...w.missions.missions.get(first!.id)!, plannedInterventions: 2 });
    const single = await asSupervisor(() =>
      new ScheduleInterventionUseCase(w).execute({
        missionId: first!.id,
        scheduledStart: SLOT.start,
        durationMinutes: 60,
        agentIds: [AGENT_ID],
        teamId: '',
      }),
    );
    expect(single.mission.interventions).toHaveLength(2);
    w.missions.unavailabilities.push({
      agentId: OTHER_AGENT_ID,
      slot: { start: new Date(SLOT.start), end: new Date(SLOT.end) },
    });
    w.missions.missions.set(first!.id, { ...w.missions.missions.get(first!.id)!, plannedInterventions: 3 });
    expect(
      await code(
        asSupervisor(() =>
          new ScheduleInterventionUseCase(w).execute({
            missionId: first!.id,
            scheduledStart: SLOT.start,
            durationMinutes: 60,
            agentIds: [OTHER_AGENT_ID],
            teamId: '',
          }),
        ),
      ),
    ).toBe('CLEANING_TEAM_UNAVAILABLE');
  });

  it('agent : position d’une mission terminée masquée, visible tant qu’elle est en cours', async () => {
    await sendQuotes();
    const accepted = await asCustomer(() =>
      new AcceptGroupQuotesUseCase(w).execute({
        groupId,
        slotStart: SLOT.start,
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
        idempotencyKey: 'acc-group-2',
      }),
    );
    const missionId = accepted.missionIds[1]!;
    const planned = await asSupervisor(() =>
      new ScheduleInterventionUseCase(w).execute({
        missionId,
        scheduledStart: SLOT.start,
        durationMinutes: 60,
        agentIds: [AGENT_ID],
        teamId: '',
      }),
    );
    const detail = () => asAgent(() => new GetMissionDetailUseCase(w).execute(missionId));
    expect((await detail()).mission.location).toEqual(POINT);
    const interventionId = planned.mission.interventions[0]!.id;
    const mission = w.missions.missions.get(missionId)!;
    w.missions.missions.set(missionId, {
      ...mission,
      interventions: mission.interventions.map((i) => ({
        ...i,
        status: 'in_progress' as const,
        checklist: i.checklist.map((item) => ({ ...item, done: true })),
      })),
    });
    const done = await asAgent(() => new CompleteInterventionUseCase(w).execute(interventionId));
    expect(done.mission).toMatchObject({ status: 'completed', location: null, landmark: null });
    expect((await detail()).mission.location).toBeNull();
    const listed = await asAgent(() => new ListMissionsUseCase(w).execute({ page: PAGE, status: '' }));
    expect(listed.items[0]!.mission.location).toBeNull();
    expect(
      (await asSupervisor(() => new GetMissionDetailUseCase(w).execute(missionId))).mission.location,
    ).toEqual(POINT);
  });
});
