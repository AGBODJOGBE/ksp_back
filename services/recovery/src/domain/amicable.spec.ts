import {
  automaticChannelOf,
  isAutomaticMessageAllowed,
  nextAutomaticMessageInstant,
  pickChannel,
  settlementTerms,
} from './amicable';
import { type ContactWindow } from './contact-policy';

/** Plage par défaut : 8 h – 19 h, du lundi au samedi, heure du Bénin (UTC+1). */
const WINDOW: ContactWindow = { start: '08:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] };
const NONE = new Set<string>();
const local = (day: string, time: string) => new Date(`${day}T${time}:00+01:00`);

describe('moment d’un message automatique au débiteur', () => {
  it('part dans la plage de contact, samedi compris, jamais le dimanche ni un jour férié', () => {
    expect(isAutomaticMessageAllowed(local('2026-11-20', '10:00'), WINDOW, NONE)).toBe(true);
    expect(isAutomaticMessageAllowed(local('2026-11-21', '10:00'), WINDOW, NONE)).toBe(true);
    expect(isAutomaticMessageAllowed(local('2026-11-22', '10:00'), WINDOW, NONE)).toBe(false);
    expect(isAutomaticMessageAllowed(local('2026-11-20', '07:59'), WINDOW, NONE)).toBe(false);
    expect(isAutomaticMessageAllowed(local('2026-11-20', '19:00'), WINDOW, NONE)).toBe(false);
    expect(isAutomaticMessageAllowed(local('2026-12-25', '10:00'), WINDOW, new Set(['2026-12-25']))).toBe(
      false,
    );
  });

  it('hors plage, il attend le prochain instant permis, en sautant dimanches et jours fériés', () => {
    expect(nextAutomaticMessageInstant(local('2026-11-20', '10:00'), WINDOW, NONE)).toEqual(
      local('2026-11-20', '10:00'),
    );
    expect(nextAutomaticMessageInstant(local('2026-11-21', '20:00'), WINDOW, NONE)).toEqual(
      local('2026-11-23', '08:00'),
    );
    // Noël un vendredi, le samedi 26 reste un jour de contact.
    expect(
      nextAutomaticMessageInstant(local('2026-12-24', '20:00'), WINDOW, new Set(['2026-12-25'])),
    ).toEqual(local('2026-12-26', '08:00'));
    // Lundi férié après un samedi soir : mardi matin.
    expect(
      nextAutomaticMessageInstant(local('2026-11-21', '19:30'), WINDOW, new Set(['2026-11-23'])),
    ).toEqual(local('2026-11-24', '08:00'));
  });
});

describe('canal d’un message automatique', () => {
  it('suit l’ordre réglé, en passant au suivant sans coordonnée', () => {
    expect(pickChannel(['email', 'whatsapp'], { phone: true, email: true })).toBe('email');
    expect(pickChannel(['email', 'whatsapp'], { phone: true, email: false })).toBe('whatsapp');
    expect(pickChannel(['whatsapp', 'email'], { phone: true, email: true })).toBe('whatsapp');
    expect(pickChannel(['whatsapp'], { phone: false, email: true })).toBeNull();
  });

  it('message de relance seul ; courrier ou e-mail seul par e-mail ; appel au chargé', () => {
    expect(automaticChannelOf('message', false)).toBe('any');
    expect(automaticChannelOf('letter_or_email', true)).toBe('email');
    expect(automaticChannelOf('letter_or_email', false)).toBeNull();
    expect(automaticChannelOf('call', true)).toBeNull();
  });
});

describe('remise pour paiement immédiat (R-PR-05)', () => {
  it('calcule la remise et la compare au barème du créancier', () => {
    expect(settlementTerms(750_000, 675_000, 1_000)).toEqual({
      ok: true,
      value: { payNow: 675_000, waived: 75_000, discountBps: 1_000, withinScale: true },
    });
    expect(settlementTerms(750_000, 675_000, 999)).toMatchObject({ value: { withinScale: false } });
    expect(settlementTerms(300_000, 200_000, 0)).toMatchObject({
      value: { waived: 100_000, discountBps: 3_334, withinScale: false },
    });
  });

  it('refuse un montant nul, décimal ou qui n’accorde aucune remise', () => {
    for (const payNow of [0, 1.5, 750_000, 800_000]) {
      expect(settlementTerms(750_000, payNow, 1_000)).toMatchObject({
        ok: false,
        code: 'RECOVERY_INVALID_AMOUNT',
      });
    }
  });
});
