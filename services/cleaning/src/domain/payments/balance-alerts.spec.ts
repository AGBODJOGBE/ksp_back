import { balanceAlert, isReminderDue, nextPlannedSession, sessionReminder } from './balance-alerts';

const at = (iso: string) => new Date(iso);
/** Séance du lundi 23 novembre 2026 à 8 h, Porto-Novo (7 h UTC). */
const START = at('2026-11-23T08:00:00+01:00');
const planned = { status: 'assigned' as const, scheduledStart: START, remindedAt: null };

describe('rappel la veille d’une séance (partie 10, R-PP-05, RV-94)', () => {
  it('à partir de minuit la veille à Porto-Novo, pas avant', () => {
    expect(isReminderDue(planned, at('2026-11-21T23:59:59+01:00'))).toBe(false);
    expect(isReminderDue(planned, at('2026-11-22T00:00:00+01:00'))).toBe(true);
    expect(isReminderDue(planned, at('2026-11-21T23:00:00Z'))).toBe(true);
  });

  it('une seule fois ; jamais après le début ; seulement pour une séance prévue', () => {
    expect(
      isReminderDue(
        { ...planned, remindedAt: at('2026-11-22T18:00:00+01:00') },
        at('2026-11-22T19:00:00+01:00'),
      ),
    ).toBe(false);
    expect(isReminderDue(planned, at('2026-11-23T07:59:59+01:00'))).toBe(true);
    expect(isReminderDue(planned, START)).toBe(false);
    expect(isReminderDue({ ...planned, status: 'suspended' }, at('2026-11-22T18:00:00+01:00'))).toBe(false);
    expect(isReminderDue({ ...planned, status: 'to_assign' }, at('2026-11-22T18:00:00+01:00'))).toBe(true);
  });

  it('le rappel dit si le solde couvre la séance ; montants absents pour une entreprise', () => {
    const now = at('2026-11-22T18:00:00+01:00');
    const base = { scheduledStart: START, agentIds: ['agent-1'], expectedAmount: 15_000, now };
    expect(sessionReminder({ ...base, payerKind: 'individual', balance: 15_000 })).toEqual({
      scheduledStart: START,
      agentIds: ['agent-1'],
      amountDue: 15_000,
      balanceSufficient: true,
      remindedAt: now,
    });
    expect(sessionReminder({ ...base, payerKind: 'individual', balance: 14_999 }).balanceSufficient).toBe(
      false,
    );
    expect(sessionReminder({ ...base, payerKind: 'organization', balance: 0 })).toMatchObject({
      amountDue: null,
      balanceSufficient: null,
    });
  });
});

describe('alerte de solde insuffisant (R-WL-06)', () => {
  const alert = (overrides: Partial<Parameters<typeof balanceAlert>[0]> = {}) =>
    balanceAlert({
      payerKind: 'individual',
      balance: 10_000,
      expectedAmount: 15_000,
      lastAlertedAt: null,
      trigger: 'assigned',
      guaranteeRequired: false,
      now: at('2026-11-20T10:00:00+01:00'),
      ...overrides,
    });

  it('solde qui ne couvre pas la prochaine séance : alerte avec ce qui manque', () => {
    expect(alert()).toEqual({
      amountDue: 15_000,
      missing: 5_000,
      guaranteeRequired: false,
      trigger: 'assigned',
      detectedAt: at('2026-11-20T10:00:00+01:00'),
    });
  });

  it('solde égal au montant : aucune alerte ; entreprise : aucune', () => {
    expect(alert({ balance: 15_000 })).toBeNull();
    expect(alert({ payerKind: 'organization' })).toBeNull();
  });

  it('une fois par séance et par jour de Porto-Novo', () => {
    expect(alert({ lastAlertedAt: at('2026-11-20T00:00:00+01:00') })).toBeNull();
    expect(alert({ lastAlertedAt: at('2026-11-19T23:59:59+01:00'), trigger: 'debit' })).toMatchObject({
      trigger: 'debit',
    });
    expect(alert({ lastAlertedAt: at('2026-11-19T23:30:00Z') })).toBeNull();
  });
});

describe('prochaine séance prévue', () => {
  it('la plus proche à venir, planifiée ou à affecter', () => {
    const now = at('2026-11-20T10:00:00+01:00');
    const sessions = [
      { id: 'a', status: 'completed' as const, scheduledStart: at('2026-11-21T08:00:00+01:00') },
      { id: 'b', status: 'assigned' as const, scheduledStart: at('2026-11-30T08:00:00+01:00') },
      { id: 'c', status: 'to_assign' as const, scheduledStart: at('2026-11-23T08:00:00+01:00') },
      { id: 'd', status: 'assigned' as const, scheduledStart: now },
    ];
    expect(nextPlannedSession(sessions, now)?.id).toBe('c');
    expect(nextPlannedSession([], now)).toBeNull();
  });
});
