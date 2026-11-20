import {
  type RenewalProgram,
  renewalStartDate,
  renewProgram,
  reorderProgram,
  RENEWAL_WINDOW_DAYS,
  visitRequired,
} from './renewal';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T10:00:00+01:00');

const program = (extra: Partial<RenewalProgram> = {}): RenewalProgram => ({
  status: 'in_progress',
  planKind: 'weekly',
  lastSessionStart: at('2026-11-30T08:00:00+01:00'),
  renewedBy: null,
  ...extra,
});

describe('R-PG-08 (décision du 18/11/2026) : sans nouvelle visite si le dernier constat a moins de 12 mois', () => {
  it('cas nominal : constat de 11 mois, pas de visite ; 13 mois, nouvelle visite', () => {
    expect(visitRequired(at('2025-12-21T10:00:00+01:00'), NOW)).toBe(false);
    expect(visitRequired(at('2025-10-20T10:00:00+01:00'), NOW)).toBe(true);
  });

  it('cas limite : 12 mois pile, encore valable ; aucun constat : visite', () => {
    expect(visitRequired(at('2025-11-20T10:00:00+01:00'), NOW)).toBe(false);
    expect(visitRequired(at('2025-11-20T09:59:59+01:00'), NOW)).toBe(true);
    expect(visitRequired(null, NOW)).toBe(true);
  });
});

describe('R-PG-07 : renouveler un programme récurrent dans ses 14 derniers jours', () => {
  it('cas nominal : dernière séance dans 10 jours', () => {
    expect(renewProgram(program(), NOW, at('2026-06-01T10:00:00+01:00'))).toEqual({
      ok: true,
      value: { withVisit: false },
    });
    expect(RENEWAL_WINDOW_DAYS).toBe(14);
  });

  it('cas limite : plus de 14 jours avant la fin, ponctuel, arrêté, déjà renouvelé', () => {
    const refuse = (reason: string) => ({ ok: false, reason });
    expect(renewProgram(program({ lastSessionStart: at('2026-12-05T08:00:00+01:00') }), NOW, null)).toEqual(
      refuse('too_early'),
    );
    expect(renewProgram(program({ planKind: 'one_off' }), NOW, null)).toEqual(refuse('not_recurring'));
    expect(renewProgram(program({ status: 'cancelled' }), NOW, null)).toEqual(refuse('program_closed'));
    expect(renewProgram(program({ renewedBy: 'p2' }), NOW, null)).toEqual(refuse('already_renewed'));
    expect(renewProgram(program({ status: 'suspended' }), NOW, null)).toEqual(refuse('program_suspended'));
  });

  it('cas limite : programme terminé depuis peu, renouvelable ; constat trop ancien : avec visite', () => {
    const ended = program({ status: 'completed', lastSessionStart: at('2026-11-18T08:00:00+01:00') });
    expect(renewProgram(ended, NOW, null)).toEqual({ ok: true, value: { withVisit: true } });
  });
});

describe('R-PG-08 : commander à nouveau un programme ponctuel terminé', () => {
  it('cas nominal : ponctuel terminé, constat récent : sans visite', () => {
    const done = program({ planKind: 'one_off', status: 'completed' });
    expect(reorderProgram(done, NOW, at('2026-03-01T10:00:00+01:00'))).toEqual({
      ok: true,
      value: { withVisit: false },
    });
  });

  it('cas limite : récurrent, ou pas encore terminé', () => {
    expect(reorderProgram(program({ status: 'completed' }), NOW, null)).toEqual({
      ok: false,
      reason: 'not_one_off',
    });
    expect(reorderProgram(program({ planKind: 'one_off' }), NOW, null)).toEqual({
      ok: false,
      reason: 'not_completed',
    });
  });
});

describe('début du programme renouvelé', () => {
  it('par défaut : lendemain de la dernière séance (heure de Porto-Novo)', () => {
    expect(renewalStartDate(at('2026-11-30T23:30:00+01:00'), null)).toBe('2026-12-01');
  });

  it('date fournie gardée', () => {
    expect(renewalStartDate(at('2026-11-30T08:00:00+01:00'), '2026-12-07')).toBe('2026-12-07');
  });
});
