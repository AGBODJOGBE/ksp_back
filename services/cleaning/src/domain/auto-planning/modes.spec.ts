import {
  type AutoTarget,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_PLANNING_MODE,
  effectiveMode,
  isAutoPlannable,
  planningWindow,
  runMode,
  selectTargets,
  type ZoneModes,
} from './modes';
import { comparePlanningOrder } from '../planning/order';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');

function session(id: string, start: string, extra: Partial<AutoTarget> = {}): AutoTarget {
  const begin = at(start);
  return {
    target: { kind: 'session', id },
    programId: 'p1',
    status: 'to_assign',
    placeId: 'place-a',
    communeKey: 'cotonou',
    start: begin,
    end: new Date(begin.getTime() + 2 * 3_600_000),
    requiredSkills: [],
    expectedTeamSize: 1,
    assignedAgents: [],
    ...extra,
  };
}

const MODES: ZoneModes = { defaultMode: 'proposal', byZone: { cotonou: 'automatic', ouidah: 'manual' } };

describe('R-PL-05 : trois modes, réglage par zone', () => {
  it('cas nominal : le mode de la zone remplace le réglage général', () => {
    expect(effectiveMode('cotonou', MODES)).toBe('automatic');
    expect(effectiveMode('ouidah', MODES)).toBe('manual');
  });

  it('cas limite : zone sans mode (null ou absente) : réglage général, « proposition » par défaut', () => {
    expect(DEFAULT_PLANNING_MODE).toBe('proposal');
    expect(effectiveMode('porto-novo', MODES)).toBe('proposal');
    expect(effectiveMode('cotonou', { defaultMode: 'manual', byZone: { cotonou: null } })).toBe('manual');
  });
});

describe('R-PL-01 : période planifiée (horizon de 14 jours par défaut)', () => {
  it('cas nominal : de maintenant à maintenant + horizon', () => {
    expect(DEFAULT_HORIZON_DAYS).toBe(14);
    expect(planningWindow({ now: NOW, from: null, to: null, horizonDays: 14 })).toEqual({
      ok: true,
      value: { start: NOW, end: at('2026-12-04T08:00:00+01:00') },
    });
  });

  it('début fourni sans fin : l’horizon court depuis ce début', () => {
    const from = at('2026-12-01T00:00:00+01:00');
    const window = planningWindow({ now: NOW, from, to: null, horizonDays: 7 });
    expect(window).toEqual({ ok: true, value: { start: from, end: at('2026-12-08T00:00:00+01:00') } });
  });

  it('cas limite : une fin qui n’est pas après le début est refusée', () => {
    const window = planningWindow({ now: NOW, from: null, to: NOW, horizonDays: 14 });
    expect(window).toEqual({
      ok: false,
      errors: [{ code: 'CLEANING_VALIDATION_FAILED', details: { field: 'to', reason: 'not_after_from' } }],
    });
  });
});

describe('cibles de l’automatique : séances « à affecter » de la période (9.5, R-PL-10)', () => {
  it('cas nominal : une séance à affecter, à venir', () => {
    expect(isAutoPlannable(session('s1', '2026-11-23T09:00:00+01:00'), NOW)).toBe(true);
  });

  it('cas limite : séance planifiée, visite, ou début égal à maintenant : écartées', () => {
    expect(isAutoPlannable(session('s1', '2026-11-23T09:00:00+01:00', { status: 'assigned' }), NOW)).toBe(
      false,
    );
    const visit = session('v1', '2026-11-23T09:00:00+01:00', { target: { kind: 'visit', id: 'v1' } });
    expect(isAutoPlannable({ ...visit, status: 'scheduled' }, NOW)).toBe(false);
    expect(isAutoPlannable(session('s2', '2026-11-20T08:00:00+01:00'), NOW)).toBe(false);
  });
});

describe('sélection des cibles d’un passage', () => {
  const window = { start: NOW, end: at('2026-12-04T08:00:00+01:00') };

  it('période semi-ouverte : début inclus, fin exclue', () => {
    const targets = [session('in', '2026-12-04T07:59:00+01:00'), session('end', '2026-12-04T08:00:00+01:00')];
    expect(selectTargets(targets, { window, now: NOW, zoneKey: null, programId: null }, MODES)).toEqual([
      { target: targets[0], mode: 'automatic' },
    ]);
  });

  it('zone en mode manuel : rien d’automatique', () => {
    const targets = [session('s1', '2026-11-23T09:00:00+01:00', { communeKey: 'ouidah' })];
    expect(selectTargets(targets, { window, now: NOW, zoneKey: null, programId: null }, MODES)).toEqual([]);
  });

  it('filtres de zone et de programme (RunAutoPlanning.zone_key, program_id)', () => {
    const targets = [
      session('s1', '2026-11-23T09:00:00+01:00'),
      session('s2', '2026-11-23T09:00:00+01:00', { communeKey: 'porto-novo' }),
      session('s3', '2026-11-23T09:00:00+01:00', { programId: 'p2' }),
    ];
    const ids = (zoneKey: string | null, programId: string | null) =>
      selectTargets(targets, { window, now: NOW, zoneKey, programId }, MODES).map((t) => t.target.target.id);
    expect(ids('cotonou', null)).toEqual(['s1', 's3']);
    expect(ids(null, 'p2')).toEqual(['s3']);
    expect(ids('porto-novo', 'p1')).toEqual(['s2']);
  });

  it('ordre de traitement : début, puis type, puis identifiant, quel que soit l’ordre reçu', () => {
    const targets = [
      session('b', '2026-11-23T09:00:00+01:00'),
      session('c', '2026-11-22T09:00:00+01:00'),
      session('a', '2026-11-23T09:00:00+01:00'),
    ];
    const order = selectTargets(targets, { window, now: NOW, zoneKey: null, programId: null }, MODES);
    expect(order.map((t) => t.target.target.id)).toEqual(['c', 'a', 'b']);
    const visit = session('a', '2026-11-23T09:00:00+01:00', { target: { kind: 'visit', id: 'a' } });
    expect(comparePlanningOrder(targets[2]!, visit)).toBeLessThan(0);
  });
});

describe('mode rendu d’un passage qui couvre plusieurs zones', () => {
  it('cas nominal : le plus prudent, proposition dès qu’une séance est en mode proposition', () => {
    expect(runMode(['automatic', 'proposal', 'automatic'], MODES, null)).toBe('proposal');
    expect(runMode(['automatic', 'automatic'], MODES, null)).toBe('automatic');
  });

  it('cas limite : passage sans séance : mode de la zone demandée, sinon réglage général ; manuel rendu proposition', () => {
    const modes: ZoneModes = {
      defaultMode: 'automatic',
      byZone: { cotonou: 'manual', 'porto-novo': 'proposal' },
    };
    expect(runMode([], modes, null)).toBe('automatic');
    expect(runMode([], modes, 'porto-novo')).toBe('proposal');
    expect(runMode([], modes, 'cotonou')).toBe('proposal');
    expect(runMode([], { defaultMode: 'manual', byZone: {} }, null)).toBe('proposal');
  });
});
