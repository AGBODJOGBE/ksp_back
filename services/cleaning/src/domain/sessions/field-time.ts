import { addMinutes } from '../planning/time';
import { HOUR_MS, TIME_ZONE } from '../requests/time';
import { MAX_OCCURRED_AGE_HOURS } from '../visits/visit';
import { ExecutionRuleError, validationFailed } from './errors';

/**
 * Bornes de temps de l'exécution d'une séance (partie 10). Le domaine ne lit jamais l'horloge :
 * `now` est passé en argument. Les instants sont en UTC ; les messages citent le fuseau de
 * Porto-Novo (UTC+1 sans heure d'été).
 */
export const DEFAULT_ARRIVAL_MAX_ADVANCE_MINUTES = 30;
export const DEFAULT_CUSTOMER_WAIT_MINUTES = 30;

/**
 * R-EX-05 : heure réelle d'une action gardée hors connexion. Absente : heure de réception. Refusée si
 * elle est dans le futur (`in_future`) ou vieille de plus de 72 h (`too_old`) ; 72 h pile passent.
 */
export function fieldActionTime(now: Date, occurredAt?: Date | null): Date {
  const time = occurredAt ?? now;
  if (time.getTime() > now.getTime()) throw validationFailed('occurredAt', 'in_future');
  if (now.getTime() - time.getTime() > MAX_OCCURRED_AGE_HOURS * HOUR_MS) {
    throw validationFailed('occurredAt', 'too_old');
  }
  return time;
}

/**
 * Partie 10 : pas d'arrivée plus tôt que l'avance maximale (`arrivalMaxAdvanceMinutes`, borne
 * incluse) ; 0 = pas de contrôle.
 */
export function assertArrivalNotTooEarly(
  scheduledStart: Date,
  arrivedAt: Date,
  maxAdvanceMinutes: number,
): void {
  if (maxAdvanceMinutes <= 0) return;
  if (arrivedAt.getTime() >= addMinutes(scheduledStart, -maxAdvanceMinutes).getTime()) return;
  throw new ExecutionRuleError('CLEANING_SESSION_TOO_EARLY', {
    scheduledStart: scheduledStart.toISOString(),
    maximumMinutes: maxAdvanceMinutes,
    timeZone: TIME_ZONE,
  });
}

/**
 * R-EX-02 : instant à partir duquel le client peut être déclaré absent. Interprétation prudente :
 * l'attente compte depuis son début, mais jamais avant l'heure prévue de la séance (un client n'est
 * pas en retard avant l'heure convenue, même si l'équipe arrive en avance).
 */
export function customerAbsentFrom(scheduledStart: Date, waitStartedAt: Date, waitMinutes: number): Date {
  const from = Math.max(scheduledStart.getTime(), waitStartedAt.getTime());
  return addMinutes(new Date(from), waitMinutes);
}

/** R-EX-02 : client absent signalé avant la fin de l'attente réglée (borne incluse). */
export function assertCustomerWaitElapsed(
  scheduledStart: Date,
  waitStartedAt: Date,
  missedAt: Date,
  waitMinutes: number,
): void {
  if (missedAt.getTime() >= customerAbsentFrom(scheduledStart, waitStartedAt, waitMinutes).getTime()) return;
  throw new ExecutionRuleError('CLEANING_WAIT_TIME_NOT_ELAPSED', { minimumMinutes: waitMinutes });
}
