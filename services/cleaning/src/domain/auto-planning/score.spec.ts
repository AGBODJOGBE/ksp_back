import { type AgendaEntry } from '../planning/agenda';
import {
  balanceFactor,
  BALANCE_REFERENCE_HOURS,
  compareIds,
  compareScores,
  continuityFactor,
  DEFAULT_SCORE_WEIGHTS,
  hasPreviousSameDay,
  plannedMinutesInWeek,
  PROXIMITY_ZERO_MINUTES,
  proximityFactor,
  ratingFactor,
  scoreCandidate,
  type ScoreInput,
} from './score';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');

function entry(id: string, placeId: string, start: string, end: string, extra: Partial<AgendaEntry> = {}) {
  const value: AgendaEntry = {
    assignmentId: id,
    target: { kind: 'session', id: `t-${id}` },
    placeId,
    start: at(start),
    end: at(end),
    travelMinutes: 0,
    status: 'confirmed',
    respondBefore: null,
    ...extra,
  };
  return value;
}

/** Séance du lundi 23 novembre 2026, 9 h – 11 h, à Cotonou. */
function input(extra: Partial<ScoreInput> = {}, agent: Partial<ScoreInput['agent']> = {}): ScoreInput {
  return {
    agent: { agentId: 'a1', zoneKeys: ['cotonou'], ratingAverage: null, agenda: [], ...agent },
    target: {
      placeId: 'place-a',
      communeKey: 'cotonou',
      start: at('2026-11-23T09:00:00+01:00'),
      end: at('2026-11-23T11:00:00+01:00'),
    },
    programAgentIds: new Set<string>(),
    travelMinutes: 0,
    now: NOW,
    weights: DEFAULT_SCORE_WEIGHTS,
    ...extra,
  };
}

describe('R-PL-03 : poids par défaut', () => {
  it('continuité 40, proximité 25, équilibre 20, note 15 : total 100', () => {
    expect(DEFAULT_SCORE_WEIGHTS).toEqual({ continuity: 40, proximity: 25, balance: 20, rating: 15 });
    const total = Object.values(DEFAULT_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });
});

describe('R-PL-03 continuité : agent déjà venu sur ce programme', () => {
  it('cas nominal : agent déjà venu, tout le poids', () => {
    expect(continuityFactor('a1', new Set(['a1', 'a2']))).toBe(1);
    expect(scoreCandidate(input({ programAgentIds: new Set(['a1']) })).continuity).toBe(40);
  });

  it('cas limite : jamais venu, ou programme sans historique : 0', () => {
    expect(continuityFactor('a1', new Set(['a2']))).toBe(0);
    expect(scoreCandidate(input()).continuity).toBe(0);
  });
});

describe('R-PL-03 proximité : zone et lieu de l’affectation précédente ce jour-là (R-ZN-02)', () => {
  it('cas nominal : affectation précédente le même jour au même lieu, trajet nul', () => {
    const agenda = [entry('e1', 'place-a', '2026-11-23T07:00:00+01:00', '2026-11-23T08:30:00+01:00')];
    expect(scoreCandidate(input({ travelMinutes: 0 }, { agenda })).proximity).toBe(25);
  });

  it('le trajet depuis l’affectation précédente du jour réduit le critère', () => {
    const agenda = [entry('e1', 'place-b', '2026-11-23T07:00:00+01:00', '2026-11-23T08:00:00+01:00')];
    expect(scoreCandidate(input({ travelMinutes: 30 }, { agenda })).proximity).toBeCloseTo(12.5);
  });

  it(`cas limite : ${PROXIMITY_ZERO_MINUTES} min de trajet ou plus : 0`, () => {
    const agenda = [entry('e1', 'place-b', '2026-11-23T06:00:00+01:00', '2026-11-23T07:00:00+01:00')];
    expect(scoreCandidate(input({ travelMinutes: PROXIMITY_ZERO_MINUTES }, { agenda })).proximity).toBe(0);
    expect(proximityFactor({ inZone: true, previousSameDay: true, travelMinutes: 90 })).toBe(0);
  });

  it('sans affectation ce jour-là : la zone seule compte', () => {
    expect(scoreCandidate(input()).proximity).toBe(25);
    expect(proximityFactor({ inZone: false, previousSameDay: false, travelMinutes: 0 })).toBe(0);
  });

  it('cas limite : une affectation de la veille, finie à minuit pile, n’est pas « ce jour-là »', () => {
    const agenda = [entry('e1', 'place-b', '2026-11-22T22:00:00+01:00', '2026-11-23T00:00:00+01:00')];
    expect(scoreCandidate(input({ travelMinutes: 30 }, { agenda })).proximity).toBe(25);
  });

  it('cas limite : une affectation retirée, ou postérieure à la cible, est ignorée', () => {
    const agenda = [
      entry('e1', 'place-b', '2026-11-23T07:00:00+01:00', '2026-11-23T08:00:00+01:00', { status: 'removed' }),
      entry('e2', 'place-b', '2026-11-23T12:00:00+01:00', '2026-11-23T13:00:00+01:00'),
    ];
    expect(scoreCandidate(input({ travelMinutes: 30 }, { agenda })).proximity).toBe(25);
  });

  it('affectation précédente « ce jour-là » : finie au plus tard au début, commencée le même jour', () => {
    const start = at('2026-11-23T09:00:00+01:00');
    const touching = [entry('e1', 'place-b', '2026-11-23T08:00:00+01:00', '2026-11-23T09:00:00+01:00')];
    const overlapping = [entry('e1', 'place-b', '2026-11-23T08:00:00+01:00', '2026-11-23T09:01:00+01:00')];
    expect(hasPreviousSameDay(touching, start, NOW)).toBe(true);
    expect(hasPreviousSameDay(overlapping, start, NOW)).toBe(false);
  });

  it('hors zone : 0, même le même jour au même lieu', () => {
    const agenda = [entry('e1', 'place-a', '2026-11-23T07:00:00+01:00', '2026-11-23T08:00:00+01:00')];
    expect(scoreCandidate(input({}, { agenda, zoneKeys: ['porto-novo'] })).proximity).toBe(0);
  });
});

describe('R-PL-03 équilibre : moins d’heures planifiées cette semaine', () => {
  it('cas nominal : aucune heure, tout le poids ; 24 h, la moitié', () => {
    expect(scoreCandidate(input()).balance).toBe(20);
    const agenda = [1, 2, 3].map((day) =>
      entry(`e${day}`, 'place-b', `2026-11-2${day + 3}T06:00:00+01:00`, `2026-11-2${day + 3}T14:00:00+01:00`),
    );
    expect(plannedMinutesInWeek(agenda, at('2026-11-23T09:00:00+01:00'), NOW)).toBe(24 * 60);
    expect(scoreCandidate(input({}, { agenda })).balance).toBeCloseTo(10);
  });

  it(`cas limite : ${BALANCE_REFERENCE_HOURS} h ou plus : 0`, () => {
    expect(balanceFactor(BALANCE_REFERENCE_HOURS * 60)).toBe(0);
    expect(balanceFactor(60 * 60)).toBe(0);
  });

  it('cas limite : semaine ISO à l’heure de Porto-Novo, seule la part du lundi compte', () => {
    const agenda = [
      // Dimanche soir : semaine précédente.
      entry('e1', 'place-b', '2026-11-22T18:00:00+01:00', '2026-11-22T22:00:00+01:00'),
      // À cheval sur minuit : une heure le lundi.
      entry('e2', 'place-b', '2026-11-22T23:00:00+01:00', '2026-11-23T01:00:00+01:00'),
      // Lundi suivant : semaine suivante.
      entry('e3', 'place-b', '2026-11-30T09:00:00+01:00', '2026-11-30T12:00:00+01:00'),
    ];
    expect(plannedMinutesInWeek(agenda, at('2026-11-23T09:00:00+01:00'), NOW)).toBe(60);
  });

  it('cas limite : le trajet ne compte pas, une affectation hors vigueur non plus', () => {
    const agenda = [
      entry('e1', 'place-b', '2026-11-24T09:00:00+01:00', '2026-11-24T10:00:00+01:00', { travelMinutes: 30 }),
      entry('e2', 'place-b', '2026-11-25T09:00:00+01:00', '2026-11-25T10:00:00+01:00', {
        status: 'declined',
      }),
    ];
    expect(plannedMinutesInWeek(agenda, at('2026-11-23T09:00:00+01:00'), NOW)).toBe(60);
  });
});

describe('R-PL-03 note moyenne des clients', () => {
  it('cas nominal : 5 étoiles, tout le poids ; 1 étoile, rien', () => {
    expect(scoreCandidate(input({}, { ratingAverage: 5 })).rating).toBe(15);
    expect(scoreCandidate(input({}, { ratingAverage: 1 })).rating).toBe(0);
    expect(ratingFactor(4)).toBeCloseTo(0.75);
  });

  it('cas limite : agent sans note, valeur médiane (3 étoiles)', () => {
    expect(ratingFactor(null)).toBe(0.5);
    expect(scoreCandidate(input()).rating).toBeCloseTo(7.5);
  });
});

describe('R-PL-03 poids réglables et total', () => {
  it('le total est la somme des critères pondérés', () => {
    const score = scoreCandidate(input({ programAgentIds: new Set(['a1']) }, { ratingAverage: 5 }));
    expect(score).toEqual({
      agentId: 'a1',
      continuity: 40,
      proximity: 25,
      balance: 20,
      rating: 15,
      total: 100,
    });
  });

  it('cas limite : un poids à 0 annule son critère', () => {
    const weights = { continuity: 100, proximity: 0, balance: 0, rating: 0 };
    expect(scoreCandidate(input({ weights })).total).toBe(0);
    expect(scoreCandidate(input({ weights, programAgentIds: new Set(['a1']) })).total).toBe(100);
  });
});

describe('ordre des candidats', () => {
  const score = (agentId: string, total: number) => ({
    agentId,
    total,
    continuity: 0,
    proximity: 0,
    balance: 0,
    rating: 0,
  });

  it('meilleur score d’abord ; à égalité, identifiant croissant', () => {
    const ranked = [score('b', 10), score('c', 50), score('a', 10)].sort(compareScores);
    expect(ranked.map((s) => s.agentId)).toEqual(['c', 'a', 'b']);
  });

  it('cas limite : identifiants comparés par points de code, sans dépendre de la langue', () => {
    expect(compareIds('a', 'a')).toBe(0);
    expect(compareIds('B', 'a')).toBe(-1);
    expect(compareIds('é', 'f')).toBe(1);
  });
});
