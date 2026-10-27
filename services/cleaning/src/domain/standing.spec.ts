import { type Intervention, type Mission } from './mission';
import { newPaymentState } from './payment';
import { planRescheduling, targetStart } from './rescheduling';
import { DEFAULT_SETTINGS, mergeSettings, settingsProblems } from './settings';
import {
  decideStanding,
  passagesToReschedule,
  standingCause,
  suspendMission,
  thresholdsFor,
  unpaidInterventions,
} from './standing';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-12-01T08:00:00Z');

function passage(id: string, overrides: Partial<Intervention> = {}): Intervention {
  return {
    id,
    status: 'planned',
    scheduledStart: at('2026-12-10T08:00:00Z'),
    durationMinutes: 120,
    agentIds: ['a1'],
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
    id: 'm1',
    requestId: 'r1',
    quoteId: 'q1',
    customerId: 'c1',
    organizationId: null,
    status: 'scheduled',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12',
    chosenSlot: { start: at('2026-11-05T08:00:00Z'), end: at('2026-11-05T10:00:00Z') },
    recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 1 },
    plannedInterventions: 4,
    interventions: [],
    payment: newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 40_000, 30),
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

describe('règle des impayés (partie 10)', () => {
  it('s’applique aux entreprises et aux particuliers en récurrent, pas au ponctuel', () => {
    expect(standingCause({ organizationId: 'o1', recurrence: null })).toBe('unpaid_invoices');
    expect(standingCause(mission())).toBe('unpaid_interventions');
    expect(standingCause({ organizationId: null, recurrence: null })).toBeNull();
  });

  it('seuils lus dans les réglages de l’admin', () => {
    expect(thresholdsFor('unpaid_invoices', DEFAULT_SETTINGS)).toEqual({ warnAt: 1, suspendAt: 2 });
    expect(thresholdsFor('unpaid_interventions', DEFAULT_SETTINGS)).toEqual({ warnAt: null, suspendAt: 1 });
  });

  it('entreprise : avertit à 1 impayée, suspend à 2, débloque sous le seuil', () => {
    const business = { warnAt: 1, suspendAt: 2 };
    const active = { suspension: null, warningLevel: 0 };
    expect(decideStanding(active, 0, business)).toBe('none');
    expect(decideStanding(active, 1, business)).toBe('warn');
    expect(decideStanding({ suspension: null, warningLevel: 1 }, 1, business)).toBe('none');
    expect(decideStanding(active, 2, business)).toBe('suspend');
    const suspended = {
      suspension: { cause: 'unpaid_invoices' as const, since: NOW, unpaidCount: 2 },
      warningLevel: 2,
    };
    expect(decideStanding(suspended, 2, business)).toBe('none');
    expect(decideStanding(suspended, 1, business)).toBe('resume');
    expect(decideStanding(suspended, 0, business)).toBe('resume');
  });

  it('particulier : passages terminés depuis plus du délai de grâce et non couverts par les paiements', () => {
    const done = (id: string, completedAt: string) =>
      passage(id, { status: 'completed', completedAt: at(completedAt) });
    const base = mission({
      interventions: [done('p1', '2026-11-20T10:00:00Z'), done('p2', '2026-11-30T20:00:00Z')],
    });
    // p2 est dans le délai de grâce (24 h) : seul p1 est dû.
    expect(unpaidInterventions(base, NOW, 24)).toBe(1);
    expect(unpaidInterventions(base, NOW, 1)).toBe(2);
    const paidOne = {
      ...base,
      payment: {
        ...base.payment,
        payments: [
          {
            id: 'x',
            amount: 10_000,
            method: 'cash' as const,
            reference: null,
            recordedBy: 's',
            recordedAt: NOW,
          },
        ],
      },
    };
    expect(unpaidInterventions(paidOne, NOW, 1)).toBe(1);
    expect(unpaidInterventions(paidOne, NOW, 24)).toBe(0);
  });

  it('suspension : passages planifiés annulés, agents libérés, passages commencés gardés', () => {
    const result = suspendMission(
      mission({
        interventions: [
          passage('p1', { agentIds: ['a2', 'a1'] }),
          passage('p2', { status: 'in_progress', agentIds: ['a3'] }),
          passage('p3', { agentIds: ['a1'] }),
        ],
      }),
      'unpaid_interventions',
      1,
      NOW,
    );
    expect(result.cancelledInterventionIds).toEqual(['p1', 'p3']);
    expect(result.releasedAgentIds).toEqual(['a1', 'a2']);
    expect(result.mission.suspension).toEqual({ cause: 'unpaid_interventions', since: NOW, unpaidCount: 1 });
    expect(result.mission.interventions.map((i) => i.status)).toEqual([
      'cancelled',
      'in_progress',
      'cancelled',
    ]);
    expect(passagesToReschedule(result.mission).map((i) => i.id)).toEqual(['p1', 'p3']);
  });

  it('seuls les passages annulés par la suspension en cours sont à reprogrammer', () => {
    const old = passage('old', {
      status: 'cancelled',
      cancellationCause: 'suspension',
      cancelledAt: at('2026-11-01T00:00:00Z'),
    });
    const manual = passage('manual', { status: 'cancelled', cancellationCause: 'manual', cancelledAt: NOW });
    const current = passage('current', {
      status: 'cancelled',
      cancellationCause: 'suspension',
      cancelledAt: NOW,
    });
    const suspended = mission({
      interventions: [old, manual, current],
      suspension: { cause: 'unpaid_invoices', since: NOW, unpaidCount: 2 },
    });
    expect(passagesToReschedule(suspended).map((i) => i.id)).toEqual(['current']);
    expect(passagesToReschedule({ ...suspended, suspension: null })).toEqual([]);
  });
});

describe('reprogrammation automatique', () => {
  it('garde la date d’origine si possible, sinon décale de semaines entières', () => {
    expect(targetStart(at('2026-12-10T08:00:00Z'), NOW, 48)).toEqual(at('2026-12-10T08:00:00Z'));
    expect(targetStart(at('2026-12-02T08:00:00Z'), NOW, 48)).toEqual(at('2026-12-09T08:00:00Z'));
    expect(targetStart(at('2026-11-18T08:00:00Z'), NOW, 48)).toEqual(at('2026-12-09T08:00:00Z'));
  });

  it('reprend les agents d’origine s’ils sont libres, sinon d’autres par identifiant', () => {
    const plan = planRescheduling({
      passages: [
        {
          id: 'p2',
          scheduledStart: at('2026-12-17T08:00:00Z'),
          durationMinutes: 120,
          agentIds: ['a1', 'a2'],
        },
        { id: 'p1', scheduledStart: at('2026-12-10T08:00:00Z'), durationMinutes: 120, agentIds: ['a1'] },
      ],
      activeAgentIds: ['a3', 'a1', 'a2', 'a4'],
      busy: [{ agentId: 'a2', slot: { start: at('2026-12-17T09:00:00Z'), end: at('2026-12-17T12:00:00Z') } }],
      now: NOW,
      minimumLeadHours: 48,
    });
    expect(plan.failed).toEqual([]);
    expect(plan.placed).toEqual([
      { originalId: 'p1', start: at('2026-12-10T08:00:00Z'), durationMinutes: 120, agentIds: ['a1'] },
      { originalId: 'p2', start: at('2026-12-17T08:00:00Z'), durationMinutes: 120, agentIds: ['a1', 'a3'] },
    ]);
  });

  it('échec sans agents libres en nombre suffisant ; les passages replacés occupent leurs agents', () => {
    const slot = at('2026-12-10T08:00:00Z');
    const plan = planRescheduling({
      passages: [
        { id: 'p1', scheduledStart: slot, durationMinutes: 120, agentIds: ['a1'] },
        { id: 'p2', scheduledStart: slot, durationMinutes: 120, agentIds: ['a1'] },
      ],
      activeAgentIds: ['a1'],
      busy: [],
      now: NOW,
      minimumLeadHours: 48,
    });
    expect(plan.placed.map((p) => p.originalId)).toEqual(['p1']);
    expect(plan.failed).toEqual(['p2']);
  });

  it('un agent inactif d’origine n’est pas réaffecté', () => {
    const plan = planRescheduling({
      passages: [
        { id: 'p1', scheduledStart: at('2026-12-10T08:00:00Z'), durationMinutes: 60, agentIds: ['gone'] },
      ],
      activeAgentIds: [],
      busy: [],
      now: NOW,
      minimumLeadHours: 48,
    });
    expect(plan.failed).toEqual(['p1']);
  });
});

describe('réglages de la partie 10', () => {
  it('valeurs par défaut du cahier des charges, avertissement avant la suspension', () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual([]);
    expect(
      settingsProblems({
        ...DEFAULT_SETTINGS,
        businessWarningUnpaidInvoices: 2,
        businessSuspensionUnpaidInvoices: 2,
      }),
    ).toEqual(['businessWarningUnpaidInvoices']);
    expect(settingsProblems({ ...DEFAULT_SETTINGS, individualSuspensionUnpaidInterventions: 0 })).toEqual([
      'individualSuspensionUnpaidInterventions',
    ]);
  });

  it('0 garde la valeur en vigueur (client qui ne connaît pas encore ces réglages)', () => {
    const current = { ...DEFAULT_SETTINGS, businessSuspensionUnpaidInvoices: 3 };
    const merged = mergeSettings(current, {
      ...DEFAULT_SETTINGS,
      depositPercent: 20,
      businessWarningUnpaidInvoices: 0,
      businessSuspensionUnpaidInvoices: 0,
      individualSuspensionUnpaidInterventions: 2,
      individualPaymentGraceHours: 0,
    });
    expect(merged).toMatchObject({
      depositPercent: 20,
      businessWarningUnpaidInvoices: 1,
      businessSuspensionUnpaidInvoices: 3,
      individualSuspensionUnpaidInterventions: 2,
      individualPaymentGraceHours: 24,
    });
  });
});
