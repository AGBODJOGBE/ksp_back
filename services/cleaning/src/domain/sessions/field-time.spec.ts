import {
  assertArrivalNotTooEarly,
  assertCustomerWaitElapsed,
  customerAbsentFrom,
  fieldActionTime,
} from './field-time';

const at = (iso: string) => new Date(iso);
/** Séance du lundi 23 novembre 2026, 9 h à Porto-Novo (8 h UTC). */
const START = at('2026-11-23T09:00:00+01:00');
const NOW = at('2026-11-23T10:00:00+01:00');

describe('heure réelle d’une action de terrain (R-EX-05)', () => {
  it('absente : heure de réception ; présente et passée : gardée', () => {
    expect(fieldActionTime(NOW)).toEqual(NOW);
    expect(fieldActionTime(NOW, at('2026-11-23T09:12:00+01:00'))).toEqual(at('2026-11-23T08:12:00Z'));
  });

  it('égale à maintenant : acceptée ; une milliseconde dans le futur : in_future', () => {
    expect(fieldActionTime(NOW, NOW)).toEqual(NOW);
    expect(() => fieldActionTime(NOW, new Date(NOW.getTime() + 1))).toThrow(
      expect.objectContaining({
        code: 'CLEANING_VALIDATION_FAILED',
        details: { field: 'occurredAt', reason: 'in_future' },
      }),
    );
  });

  it('72 h pile : acceptée ; 72 h et une milliseconde : too_old', () => {
    const limit = at('2026-11-20T10:00:00+01:00');
    expect(fieldActionTime(NOW, limit)).toEqual(limit);
    expect(() => fieldActionTime(NOW, new Date(limit.getTime() - 1))).toThrow(
      expect.objectContaining({ details: { field: 'occurredAt', reason: 'too_old' } }),
    );
  });
});

describe('avance maximale à l’arrivée (partie 10, RV-73)', () => {
  it('30 min avant pile : acceptée ; 30 min et 1 s avant : CLEANING_SESSION_TOO_EARLY', () => {
    expect(() => assertArrivalNotTooEarly(START, at('2026-11-23T08:30:00+01:00'), 30)).not.toThrow();
    expect(() => assertArrivalNotTooEarly(START, at('2026-11-23T08:29:59+01:00'), 30)).toThrow(
      expect.objectContaining({
        code: 'CLEANING_SESSION_TOO_EARLY',
        details: {
          scheduledStart: '2026-11-23T08:00:00.000Z',
          maximumMinutes: 30,
          timeZone: 'Africa/Porto-Novo',
        },
      }),
    );
  });

  it('les bornes se lisent en instants : 07:30 UTC est 08:30 à Porto-Novo', () => {
    expect(() => assertArrivalNotTooEarly(START, at('2026-11-23T07:30:00Z'), 30)).not.toThrow();
    expect(() => assertArrivalNotTooEarly(START, at('2026-11-23T07:29:59Z'), 30)).toThrow();
  });

  it('0 : pas de contrôle, même la veille', () => {
    expect(() => assertArrivalNotTooEarly(START, at('2026-11-22T09:00:00+01:00'), 0)).not.toThrow();
  });
});

describe('attente avant de déclarer le client absent (R-EX-02)', () => {
  it('l’attente compte depuis son début, au plus tôt depuis l’heure prévue', () => {
    expect(customerAbsentFrom(START, at('2026-11-23T09:05:00+01:00'), 30)).toEqual(
      at('2026-11-23T09:35:00+01:00'),
    );
    expect(customerAbsentFrom(START, at('2026-11-23T08:40:00+01:00'), 30)).toEqual(
      at('2026-11-23T09:30:00+01:00'),
    );
  });

  it('30 min pile : acceptée ; une seconde de moins : CLEANING_WAIT_TIME_NOT_ELAPSED', () => {
    const wait = at('2026-11-23T09:00:00+01:00');
    expect(() => assertCustomerWaitElapsed(START, wait, at('2026-11-23T09:30:00+01:00'), 30)).not.toThrow();
    expect(() => assertCustomerWaitElapsed(START, wait, at('2026-11-23T09:29:59+01:00'), 30)).toThrow(
      expect.objectContaining({
        code: 'CLEANING_WAIT_TIME_NOT_ELAPSED',
        details: { minimumMinutes: 30 },
      }),
    );
  });

  it('arrivé en avance : attendre 30 min après l’heure prévue, pas après l’arrivée', () => {
    const wait = at('2026-11-23T08:30:00+01:00');
    expect(() => assertCustomerWaitElapsed(START, wait, at('2026-11-23T09:00:00+01:00'), 30)).toThrow(
      expect.objectContaining({ code: 'CLEANING_WAIT_TIME_NOT_ELAPSED' }),
    );
  });
});
