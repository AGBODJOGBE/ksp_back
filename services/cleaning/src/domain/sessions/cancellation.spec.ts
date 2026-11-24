import {
  cancelForNoAgent,
  cancelSessionAsKsp,
  cancelSessionByCustomer,
  isWithinFreePeriod,
} from './cancellation';

const at = (iso: string) => new Date(iso);
/** Séance du lundi 23 novembre 2026, 9 h – 11 h (Porto-Novo). */
const session = (
  status: 'to_assign' | 'assigned' | 'suspended' | 'interrupted' | 'in_progress' = 'assigned',
) => ({
  status,
  scheduledStart: at('2026-11-23T09:00:00+01:00'),
  scheduledEnd: at('2026-11-23T11:00:00+01:00'),
});
const LIMIT = at('2026-11-22T09:00:00+01:00');

describe('délai sans frais (partie 12)', () => {
  it('jusqu’à 24 h avant, borne incluse ; une seconde après : hors délai', () => {
    expect(isWithinFreePeriod(session().scheduledStart, LIMIT, 24)).toBe(true);
    expect(isWithinFreePeriod(session().scheduledStart, at('2026-11-22T09:00:01+01:00'), 24)).toBe(false);
    expect(isWithinFreePeriod(session().scheduledStart, at('2026-11-22T08:00:01Z'), 24)).toBe(false);
  });
});

describe('annulation par le client', () => {
  const cancel = (now: Date, status?: Parameters<typeof session>[0]) =>
    cancelSessionByCustomer(session(status), { actorId: 'client-1', now, freeCancellationHours: 24 });

  it('24 h avant pile : annulée, rien à payer', () => {
    expect(cancel(LIMIT)).toEqual({
      status: 'cancelled',
      cancellation: {
        by: 'customer',
        cause: 'customer',
        late: false,
        at: LIMIT,
        reason: null,
        actorId: 'client-1',
      },
    });
  });

  it('moins de 24 h avant : CLEANING_CANCELLATION_TOO_LATE (passer par le support)', () => {
    expect(() => cancel(at('2026-11-22T09:00:01+01:00'))).toThrow(
      expect.objectContaining({
        code: 'CLEANING_CANCELLATION_TOO_LATE',
        details: { freeCancellationHours: 24 },
      }),
    );
  });

  it('séance suspendue : annulable ; séance démarrée ou interrompue : non', () => {
    expect(cancel(LIMIT, 'suspended').status).toBe('cancelled');
    expect(() => cancel(LIMIT, 'interrupted')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
    expect(() => cancel(LIMIT, 'in_progress')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});

describe('annulation par KSP ou par le support', () => {
  const cancel = (
    initiatedBy: 'ksp' | 'customer_late',
    now: Date,
    status?: Parameters<typeof session>[0],
    reason = 'Intempéries',
  ) =>
    cancelSessionAsKsp(session(status), {
      initiatedBy,
      reason,
      actorId: 'sup-1',
      now,
      freeCancellationHours: 24,
    });

  it('KSP : motif obligatoire, rien à payer, même interrompue ou suspendue', () => {
    expect(cancel('ksp', at('2026-11-23T08:00:00+01:00')).cancellation).toMatchObject({
      by: 'ksp',
      cause: 'ksp',
      late: false,
      reason: 'Intempéries',
    });
    expect(cancel('ksp', LIMIT, 'interrupted').status).toBe('cancelled');
    expect(cancel('ksp', LIMIT, 'suspended').status).toBe('cancelled');
    expect(() => cancel('ksp', LIMIT, 'assigned', '')).toThrow(
      expect.objectContaining({ code: 'CLEANING_REASON_REQUIRED' }),
    );
    expect(() => cancel('ksp', LIMIT, 'in_progress')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });

  it('client moins de 24 h avant, via le support : annulation tardive, 50 % dus', () => {
    expect(cancel('customer_late', at('2026-11-22T09:00:01+01:00')).cancellation).toMatchObject({
      by: 'customer',
      cause: 'customer_late',
      late: true,
    });
  });

  it('cas limite : le support saisit une annulation encore dans le délai : sans frais', () => {
    expect(cancel('customer_late', LIMIT).cancellation).toMatchObject({ cause: 'customer', late: false });
  });

  it('annulation tardive d’une séance interrompue ou suspendue : refusée', () => {
    expect(() => cancel('customer_late', at('2026-11-23T08:00:00+01:00'), 'interrupted')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
    expect(() => cancel('customer_late', at('2026-11-23T08:00:00+01:00'), 'suspended')).toThrow(
      expect.objectContaining({ code: 'CLEANING_INVALID_TRANSITION' }),
    );
  });
});

describe('séance sans agent à l’heure de fin prévue (SES-01, R-PL-10)', () => {
  it('à la fin prévue pile : annulée par KSP, cause no_agent, rien à payer', () => {
    const end = at('2026-11-23T11:00:00+01:00');
    expect(cancelForNoAgent(session('to_assign'), end)).toEqual({
      status: 'cancelled',
      cancellation: { by: 'ksp', cause: 'no_agent', late: false, at: end, reason: null, actorId: null },
    });
  });

  it('une seconde avant la fin, ou séance planifiée : rien', () => {
    expect(cancelForNoAgent(session('to_assign'), at('2026-11-23T10:59:59+01:00'))).toBeNull();
    expect(cancelForNoAgent(session('assigned'), at('2026-11-23T11:00:00+01:00'))).toBeNull();
  });
});
