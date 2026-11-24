import { isCancelledForNoAgent, staffingAlertLevel, staffingAlertToSend } from './staffing-alert';

const at = (iso: string) => new Date(iso);
/** Séance du lundi 23 novembre 2026, 9 h – 11 h à Porto-Novo. */
const START = '2026-11-23T09:00:00+01:00';
const session = (status: string) => ({
  status,
  scheduledStart: at(START),
  scheduledEnd: at('2026-11-23T11:00:00+01:00'),
});

describe('séance à affecter : alerte 48 h avant (R-PL-06)', () => {
  it('plus de 48 h avant : aucune alerte', () => {
    expect(staffingAlertLevel(session('to_assign'), at('2026-11-21T08:59:59+01:00'))).toBeNull();
  });

  it('exactement 48 h avant, et jusqu’au début : unassigned_48h', () => {
    expect(staffingAlertLevel(session('to_assign'), at('2026-11-21T09:00:00+01:00'))).toBe('unassigned_48h');
    expect(staffingAlertLevel(session('to_assign'), at('2026-11-23T08:59:59+01:00'))).toBe('unassigned_48h');
  });

  it('l’heure se lit en instants : 08:00 UTC est 09:00 à Porto-Novo', () => {
    expect(staffingAlertLevel(session('to_assign'), at('2026-11-21T07:59:59Z'))).toBeNull();
    expect(staffingAlertLevel(session('to_assign'), at('2026-11-21T08:00:00Z'))).toBe('unassigned_48h');
  });
});

describe('séance à affecter à l’heure de début (R-PL-10)', () => {
  it('à l’heure de début et après : unassigned_at_start', () => {
    expect(staffingAlertLevel(session('to_assign'), at(START))).toBe('unassigned_at_start');
    expect(staffingAlertLevel(session('to_assign'), at('2026-11-23T12:00:00+01:00'))).toBe(
      'unassigned_at_start',
    );
  });

  it('annulée par KSP (cause no_agent) si personne n’a agi à l’heure de fin prévue', () => {
    expect(isCancelledForNoAgent(session('to_assign'), at('2026-11-23T10:59:59+01:00'))).toBe(false);
    expect(isCancelledForNoAgent(session('to_assign'), at('2026-11-23T11:00:00+01:00'))).toBe(true);
    expect(isCancelledForNoAgent(session('assigned'), at('2026-11-23T11:00:00+01:00'))).toBe(false);
  });
});

describe('séance planifiée non démarrée : agent absent (R-PL-10, partie 12)', () => {
  it('moins d’1 h après le début : rien ; à 1 h pile : agent_absent', () => {
    expect(staffingAlertLevel(session('assigned'), at('2026-11-23T09:59:59+01:00'))).toBeNull();
    expect(staffingAlertLevel(session('assigned'), at('2026-11-23T10:00:00+01:00'))).toBe('agent_absent');
  });

  it('séance démarrée, réalisée, annulée ou suspendue : jamais d’alerte', () => {
    for (const status of ['in_progress', 'interrupted', 'completed', 'missed', 'cancelled', 'suspended']) {
      expect(staffingAlertLevel(session(status), at('2026-11-23T10:30:00+01:00'))).toBeNull();
    }
  });
});

describe('une seule alerte par niveau', () => {
  const now48 = at('2026-11-22T09:00:00+01:00');

  it('niveau atteint et pas encore envoyé : à envoyer', () => {
    expect(staffingAlertToSend(session('to_assign'), null, now48)).toBe('unassigned_48h');
    expect(staffingAlertToSend(session('to_assign'), 'unassigned_48h', at(START))).toBe(
      'unassigned_at_start',
    );
    expect(
      staffingAlertToSend(session('assigned'), 'unassigned_at_start', at('2026-11-23T10:00:00+01:00')),
    ).toBe('agent_absent');
  });

  it('niveau déjà envoyé, ou inférieur au dernier envoyé : rien', () => {
    expect(staffingAlertToSend(session('to_assign'), 'unassigned_48h', now48)).toBeNull();
    expect(staffingAlertToSend(session('to_assign'), 'unassigned_at_start', now48)).toBeNull();
    expect(staffingAlertToSend(session('assigned'), null, now48)).toBeNull();
  });
});
