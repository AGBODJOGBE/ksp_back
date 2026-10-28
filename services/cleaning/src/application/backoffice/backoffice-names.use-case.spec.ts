import { type AppError } from '@ksp/platform';
import { type Mission } from '../../domain/mission';
import { newPaymentState } from '../../domain/payment';
import { type QuoteRequest } from '../../domain/quote-request';
import {
  AGENT_ID,
  asCustomer,
  asSupervisor,
  CUSTOMER_ID,
  ORGANIZATION_ID,
  SUPERVISOR_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import { ResolveBackofficeNamesUseCase } from './backoffice-names.use-case';

const NOW = new Date('2026-10-23T08:00:00Z');

function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    id: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2000',
    status: 'visit_scheduled',
    customerId: CUSTOMER_ID,
    customerKind: 'business',
    organizationId: ORGANIZATION_ID,
    serviceCode: 'home_cleaning',
    premisesType: 'office',
    quantity: 100,
    options: [],
    commune: 'Cotonou',
    address: 'Lot 12',
    preferredSlots: [],
    comment: null,
    recurrence: null,
    requestedTeamSize: 0,
    daysPerWeek: null,
    recommendedTeamSize: 2,
    estimate: null,
    visit: {
      id: 'v1',
      status: 'scheduled',
      scheduledAt: NOW,
      agentId: AGENT_ID,
      report: null,
      completedAt: null,
    },
    quote: null,
    missionId: null,
    closingReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function mission(): Mission {
  const payment = newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 10_000, 30);
  return {
    id: 'm1',
    requestId: 'r1',
    quoteId: 'q1',
    customerId: CUSTOMER_ID,
    organizationId: null,
    status: 'completed',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12',
    chosenSlot: { start: NOW, end: NOW },
    recurrence: null,
    plannedInterventions: 1,
    interventions: [],
    payment: {
      ...payment,
      payments: [
        {
          id: 'p1',
          amount: 10_000,
          method: 'cash',
          reference: null,
          recordedBy: SUPERVISOR_ID,
          recordedAt: NOW,
          idempotencyKey: null,
        },
      ],
    },
    cancellationReason: null,
    daysPerWeek: null,
    suspension: null,
    warningLevel: 0,
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
  };
}

describe('noms affichés au back-office (ADR-029)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
    world.people.users.set(CUSTOMER_ID, 'Koffi Adjovi');
    world.people.users.set(SUPERVISOR_ID, 'Afi Superviseure');
    world.people.users.set(AGENT_ID, 'Awa Identity');
    world.people.organizations.set(ORGANIZATION_ID, 'SARL Bénin Propre');
    world.agents.agents.set(AGENT_ID, {
      agentId: AGENT_ID,
      displayName: 'Awa B.',
      active: true,
      unavailabilities: [],
    });
  });

  it('demande : client et organisation par identity, agent de visite par sa fiche agent', async () => {
    const names = await asSupervisor(() =>
      new ResolveBackofficeNamesUseCase(world).forRequests([request(), request({ id: 'r2' })]),
    );
    expect(names.users.get(CUSTOMER_ID)).toBe('Koffi Adjovi');
    expect(names.users.get(AGENT_ID)).toBe('Awa B.');
    expect(names.organizations.get(ORGANIZATION_ID)).toBe('SARL Bénin Propre');
    // Un seul appel par lot, sans doublon, et l'agent connu localement n'est pas redemandé.
    expect(world.people.calls).toEqual([
      { kind: 'users', ids: [CUSTOMER_ID] },
      { kind: 'organizations', ids: [ORGANIZATION_ID] },
    ]);
  });

  it('mission : auteur du paiement lu dans identity ; aucune organisation pour un particulier', async () => {
    const names = await asSupervisor(() => new ResolveBackofficeNamesUseCase(world).forMissions([mission()]));
    expect(names.users.get(SUPERVISOR_ID)).toBe('Afi Superviseure');
    expect(world.people.calls.map((call) => call.kind)).toEqual(['users']);
  });

  it('identity indisponible : noms absents, sans erreur ; les fiches agent restent', async () => {
    world.people.down = true;
    const names = await asSupervisor(() => new ResolveBackofficeNamesUseCase(world).forRequests([request()]));
    expect(names.users.get(CUSTOMER_ID)).toBeUndefined();
    expect(names.users.get(AGENT_ID)).toBe('Awa B.');
    expect(names.organizations.size).toBe(0);
  });

  it('aucun identifiant : aucun appel ; réservé au back-office', async () => {
    await asSupervisor(() => new ResolveBackofficeNamesUseCase(world).forAuthors([null, undefined]));
    expect(world.people.calls).toEqual([]);
    const error = await asCustomer(() =>
      new ResolveBackofficeNamesUseCase(world).forRequests([request()]),
    ).catch((e: AppError) => e);
    expect(error).toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });
});
