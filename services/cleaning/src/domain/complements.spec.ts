import { type Agent, activeTeamMembers } from './agent';
import { overlappingAssignments, upcomingAssignments, visitSlot } from './agenda';
import {
  canEditPhotos,
  photoKindOf,
  releasedAgents,
  rescheduledIntervention,
  unscheduledIntervention,
  withoutPhoto,
  withPhoto,
} from './intervention-changes';
import { deriveMissionStatus, type Intervention, remainingToSchedule } from './mission';
import {
  effectiveVisit,
  isQuoteToExpire,
  isQuoteToRemind,
  isStaleVisit,
  requestBatches,
} from './request-deadlines';
import { DEFAULT_SETTINGS, mergeSettings, settingsProblems } from './settings';
import { type QuoteRequest } from './quote-request';

const NOW = new Date('2026-11-10T08:00:00Z');
const DAY = 86_400_000;

function intervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    id: 'i1',
    status: 'planned',
    scheduledStart: new Date('2026-11-12T08:00:00Z'),
    durationMinutes: 120,
    agentIds: ['a1', 'a2'],
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

function request(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    id: 'r1',
    status: 'quote_sent',
    customerId: 'c1',
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
    address: 'Rue 1',
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

const quote = (validUntil: Date) => ({
  id: 'q1',
  lines: [],
  subtotal: 10_000,
  interventionCount: 1,
  total: 10_000,
  proposedSlots: [],
  validUntil,
  depositPercent: 30,
  depositAmount: 3_000,
  recurrence: null,
  teamSize: 1,
  durationMinutes: 120,
  sentAt: new Date(validUntil.getTime() - 15 * DAY),
});

describe('Réglages ajoutés (ADR-053)', () => {
  it('valeurs par défaut : rappel 2 jours, 10 photos par type, visite de 60 minutes', () => {
    expect(DEFAULT_SETTINGS.quoteExpiryReminderDays).toBe(2);
    expect(DEFAULT_SETTINGS.maxInterventionPhotos).toBe(10);
    expect(DEFAULT_SETTINGS.visitDurationMinutes).toBe(60);
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([]);
  });

  it('bornes : rappel 0 à 30 (0 = désactivé), photos 1 à 50, visite 15 à 480 minutes', () => {
    expect(settingsProblems({ ...DEFAULT_SETTINGS, quoteExpiryReminderDays: 0 })).toEqual([]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, quoteExpiryReminderDays: 31 })).toEqual([
      'quoteExpiryReminderDays',
    ]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, maxInterventionPhotos: 51 })).toEqual([
      'maxInterventionPhotos',
    ]);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, visitDurationMinutes: 10 })).toEqual([
      'visitDurationMinutes',
    ]);
  });

  it('à l’écriture : rappel absent gardé, 0 enregistré ; photos et durée à 0 gardées', () => {
    const current = { ...DEFAULT_SETTINGS, quoteExpiryReminderDays: 3, maxInterventionPhotos: 6 };
    const { quoteExpiryReminderDays: _omitted, ...withoutReminder } = DEFAULT_SETTINGS;
    expect(
      mergeSettings(current, { ...withoutReminder, maxInterventionPhotos: 0, visitDurationMinutes: 0 }),
    ).toMatchObject({ quoteExpiryReminderDays: 3, maxInterventionPhotos: 6, visitDurationMinutes: 60 });
    expect(mergeSettings(current, { ...DEFAULT_SETTINGS, quoteExpiryReminderDays: 0 })).toMatchObject({
      quoteExpiryReminderDays: 0,
    });
  });
});

describe('Photos d’un passage (ADR-053)', () => {
  it('ajout et retrait : un fichier dans un seul type, sans doublon', () => {
    const one = withPhoto(intervention(), 'before', 'f1');
    expect(one.beforePhotoFileIds).toEqual(['f1']);
    expect(photoKindOf(one, 'f1')).toBe('before');
    expect(photoKindOf(one, 'f2')).toBeNull();
    expect(withPhoto(one, 'before', 'f1').beforePhotoFileIds).toEqual(['f1']);
    expect(withoutPhoto(one, 'f1').beforePhotoFileIds).toEqual([]);
  });

  it('modifiables tant que le passage n’est ni terminé ni annulé', () => {
    expect(canEditPhotos(intervention())).toBe(true);
    expect(canEditPhotos(intervention({ status: 'in_progress' }))).toBe(true);
    expect(canEditPhotos(intervention({ status: 'on_hold' }))).toBe(true);
    expect(canEditPhotos(intervention({ status: 'completed' }))).toBe(false);
    expect(canEditPhotos(intervention({ status: 'cancelled' }))).toBe(false);
  });
});

describe('Report et annulation pour replanifier (ADR-053)', () => {
  it('report : nouveau début, durée, agents et motif ; agents libérés', () => {
    const before = intervention();
    const after = rescheduledIntervention(before, {
      start: new Date('2026-11-14T08:00:00Z'),
      durationMinutes: 90,
      agentIds: ['a2', 'a3'],
      reason: 'Client absent',
    });
    expect(after).toMatchObject({
      status: 'planned',
      scheduledStart: new Date('2026-11-14T08:00:00Z'),
      durationMinutes: 90,
      agentIds: ['a2', 'a3'],
      changeReason: 'Client absent',
    });
    expect(releasedAgents(before, after)).toEqual(['a1']);
  });

  it('annulation pour replanifier : passage annulé, un passage de nouveau à planifier', () => {
    const cancelled = unscheduledIntervention(intervention(), 'Pluie', NOW);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellationCause: 'unscheduled',
      cancelledAt: NOW,
      changeReason: 'Pluie',
    });
    const mission = { status: 'scheduled' as const, plannedInterventions: 1, interventions: [cancelled] };
    expect(remainingToSchedule(mission)).toBe(1);
    expect(deriveMissionStatus(mission)).toBe('to_schedule');
  });
});

describe('Agenda d’un agent (ADR-053)', () => {
  const visit = {
    kind: 'visit' as const,
    id: 'v1',
    missionId: null,
    requestId: 'r1',
    slot: visitSlot(new Date('2026-11-12T08:00:00Z'), 60),
  };
  const passage = {
    kind: 'intervention' as const,
    id: 'i1',
    missionId: 'm1',
    requestId: null,
    slot: { start: new Date('2026-11-09T08:00:00Z'), end: new Date('2026-11-09T10:00:00Z') },
  };

  it('une visite occupe sa durée réglée', () => {
    expect(visit.slot.end).toEqual(new Date('2026-11-12T09:00:00Z'));
  });

  it('chevauchements avec une période ; affectations à venir', () => {
    const period = { start: new Date('2026-11-12T08:30:00Z'), end: new Date('2026-11-13T00:00:00Z') };
    expect(overlappingAssignments([visit, passage], period)).toEqual([visit]);
    expect(upcomingAssignments([visit, passage], NOW)).toEqual([visit]);
  });

  it('équipe : seuls ses membres actifs sont affectés', () => {
    const agents: Agent[] = [
      { agentId: 'a1', displayName: 'A', active: true, unavailabilities: [] },
      { agentId: 'a2', displayName: 'B', active: false, unavailabilities: [] },
    ];
    expect(
      activeTeamMembers({ id: 't', name: 'T', memberIds: ['a1', 'a2', 'a3'], active: true }, agents),
    ).toEqual(['a1']);
  });
});

describe('Échéances des demandes (ADR-053)', () => {
  it('devis à expirer : envoyé, validité dépassée', () => {
    expect(isQuoteToExpire(request({ quote: quote(NOW) }), NOW)).toBe(true);
    expect(isQuoteToExpire(request({ quote: quote(new Date(NOW.getTime() + 1)) }), NOW)).toBe(false);
    expect(isQuoteToExpire(request({ status: 'accepted', quote: quote(NOW) }), NOW)).toBe(false);
  });

  it('rappel : dans les N jours avant l’expiration, jamais avec 0', () => {
    const soon = request({ quote: quote(new Date(NOW.getTime() + 2 * DAY)) });
    const later = request({ quote: quote(new Date(NOW.getTime() + 2 * DAY + 1)) });
    expect(isQuoteToRemind(soon, NOW, 2)).toBe(true);
    expect(isQuoteToRemind(later, NOW, 2)).toBe(false);
    expect(isQuoteToRemind(soon, NOW, 0)).toBe(false);
    expect(isQuoteToRemind(request({ quote: quote(NOW) }), NOW, 2)).toBe(false);
  });

  it('visite à annuler : planifiée sur une demande close ; affichée annulée en attendant', () => {
    const visit = {
      id: 'v1',
      status: 'scheduled' as const,
      scheduledAt: NOW,
      agentId: 'a1',
      report: null,
      completedAt: null,
    };
    expect(isStaleVisit(request({ status: 'rejected', visit }))).toBe(true);
    expect(isStaleVisit(request({ status: 'visit_scheduled', visit }))).toBe(false);
    expect(effectiveVisit(request({ status: 'cancelled', visit }), NOW)?.status).toBe('cancelled');
    expect(effectiveVisit(request({ status: 'visit_scheduled', visit }), NOW)?.status).toBe('scheduled');
  });

  it('lots : un par client et par groupe (ou demande seule), 10 demandes au plus', () => {
    const grouped = Array.from({ length: 12 }, (_, n) => request({ id: `g${n}`, groupId: 'grp' }));
    const alone = [request({ id: 's1' }), request({ id: 's2' })];
    const batches = requestBatches([...grouped, ...alone]);
    expect(batches.map((batch) => batch.length)).toEqual([10, 2, 1, 1]);
  });
});
