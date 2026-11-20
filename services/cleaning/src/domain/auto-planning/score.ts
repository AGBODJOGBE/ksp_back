import { type AgendaEntry } from '../planning/agenda';
import { isInForce } from '../planning/assignment-status';
import { workedPeriod } from '../planning/availability';
import { addDays, isoWeekMonday, localDayStart, localPosition, overlapMinutes } from '../planning/time';

/**
 * Score d'un candidat de la planification automatique (R-PL-03). Le candidat a déjà passé tous les
 * contrôles de 9.4 (R-PL-02) : le score ne fait que départager. Chaque critère donne un facteur entre
 * 0 et 1, multiplié par son poids (réglable, total 100) : le score va de 0 à la somme des poids.
 */
export interface ScoreWeights {
  continuity: number;
  proximity: number;
  balance: number;
  rating: number;
}

/** Poids par défaut du tableau de R-PL-03 (réglages, CleaningSettings.scoreWeight*). */
export const DEFAULT_SCORE_WEIGHTS: Readonly<ScoreWeights> = {
  continuity: 40,
  proximity: 25,
  balance: 20,
  rating: 15,
};

/**
 * Trajet au-delà duquel la proximité ne rapporte plus rien. Le CDC ne donne pas d'échelle : on
 * prend 60 min, le double du trajet par défaut de R-ZN-02 (30 min).
 */
export const PROXIMITY_ZERO_MINUTES = 60;

/**
 * Heures planifiées dans la semaine au-delà desquelles l'équilibre ne rapporte plus rien : la charge
 * hebdomadaire par défaut de R-DS-03 (48 h). Une même référence pour tous les agents garde l'ordre
 * du CDC : « moins d'heures planifiées ».
 */
export const BALANCE_REFERENCE_HOURS = 48;

/** Notes des clients : 1 à 5 étoiles. */
const RATING_MIN = 1;
const RATING_MAX = 5;

/** Ce que le score lit d'un candidat. */
export interface ScoredAgent {
  agentId: string;
  /** Communes de travail. */
  zoneKeys: readonly string[];
  /** Note moyenne des clients ; null si l'agent n'a pas encore de note. */
  ratingAverage: number | null;
  agenda: readonly AgendaEntry[];
}

export interface ScoreInput {
  agent: ScoredAgent;
  target: { placeId: string; communeKey: string; start: Date; end: Date };
  /** Agents déjà venus sur le programme de la séance (voir continuityFactor). */
  programAgentIds: ReadonlySet<string>;
  /** Trajet compté avant la cible par les contrôles (AgentCheck.travelMinutes, R-ZN-02). */
  travelMinutes: number;
  now: Date;
  weights: Readonly<ScoreWeights>;
}

/** Points obtenus par critère (facteur × poids) et leur somme. */
export interface CandidateScore {
  agentId: string;
  continuity: number;
  proximity: number;
  balance: number;
  rating: number;
  total: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Continuité : 1 si l'agent est déjà venu sur ce programme, sinon 0. */
export function continuityFactor(agentId: string, programAgentIds: ReadonlySet<string>): number {
  return programAgentIds.has(agentId) ? 1 : 0;
}

/**
 * Proximité : « zone de l'agent et lieu de son affectation précédente ce jour-là ». Interprétation
 * prudente : hors zone, 0 ; dans la zone, sans affectation précédente ce jour-là, 1 (rien ne mesure
 * le trajet depuis le domicile) ; avec une affectation précédente ce jour-là, le facteur décroît
 * avec le trajet compté avant la cible, jusqu'à 0 à PROXIMITY_ZERO_MINUTES.
 */
export function proximityFactor(input: {
  inZone: boolean;
  previousSameDay: boolean;
  travelMinutes: number;
}): number {
  if (!input.inZone) return 0;
  if (!input.previousSameDay) return 1;
  return clamp01(1 - input.travelMinutes / PROXIMITY_ZERO_MINUTES);
}

/**
 * Affectation précédente « ce jour-là » : une affectation en vigueur, finie au plus tard au début de
 * la cible et commencée le même jour, à l'heure de Porto-Novo.
 */
export function hasPreviousSameDay(agenda: readonly AgendaEntry[], start: Date, now: Date): boolean {
  const day = localPosition(start).day;
  return agenda.some(
    (entry) => isInForce(entry, now) && entry.end <= start && localPosition(entry.start).day === day,
  );
}

/**
 * Minutes planifiées dans la semaine ISO (lundi à dimanche, heure de Porto-Novo) qui contient
 * l'instant : affectations en vigueur, cible seule sans le trajet, comme la charge (R-DS-03).
 */
export function plannedMinutesInWeek(agenda: readonly AgendaEntry[], instant: Date, now: Date): number {
  const monday = isoWeekMonday(localPosition(instant).day);
  const week = { start: localDayStart(monday), end: localDayStart(addDays(monday, 7)) };
  return agenda
    .filter((entry) => isInForce(entry, now))
    .reduce((sum, entry) => sum + overlapMinutes(workedPeriod(entry), week), 0);
}

/** Équilibre : 1 sans heure planifiée, 0 à BALANCE_REFERENCE_HOURS ou au-delà. */
export function balanceFactor(plannedMinutes: number): number {
  return clamp01(1 - plannedMinutes / (BALANCE_REFERENCE_HOURS * 60));
}

/**
 * Note : 0 pour 1 étoile, 1 pour 5 étoiles. Interprétation prudente : un agent sans note n'est ni
 * favorisé ni pénalisé, il reçoit le milieu de l'échelle (3 étoiles).
 */
export function ratingFactor(ratingAverage: number | null): number {
  if (ratingAverage === null) return 0.5;
  return clamp01((ratingAverage - RATING_MIN) / (RATING_MAX - RATING_MIN));
}

/** Score d'un candidat pour une cible (R-PL-03). */
export function scoreCandidate(input: ScoreInput): CandidateScore {
  const { agent, target, weights, now } = input;
  const continuity = weights.continuity * continuityFactor(agent.agentId, input.programAgentIds);
  const proximity =
    weights.proximity *
    proximityFactor({
      inZone: agent.zoneKeys.includes(target.communeKey),
      previousSameDay: hasPreviousSameDay(agent.agenda, target.start, now),
      travelMinutes: input.travelMinutes,
    });
  const balance = weights.balance * balanceFactor(plannedMinutesInWeek(agent.agenda, target.start, now));
  const rating = weights.rating * ratingFactor(agent.ratingAverage);
  return {
    agentId: agent.agentId,
    continuity,
    proximity,
    balance,
    rating,
    total: continuity + proximity + balance + rating,
  };
}

/** Comparaison d'identifiants par points de code, indépendante de la langue de l'hôte. */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Ordre des candidats : meilleur score d'abord ; à égalité, identifiant croissant (départage stable). */
export function compareScores(a: CandidateScore, b: CandidateScore): number {
  return b.total - a.total || compareIds(a.agentId, b.agentId);
}
