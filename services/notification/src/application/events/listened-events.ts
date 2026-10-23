import { type KspEventType } from '@ksp/contracts';
import { CLEANING_RULES } from './cleaning.rules';
import { type EventRules } from './event-rules';

/**
 * Événements écoutés par notification, avec leur règle. Chaque événement a sa file
 * `notification.<événement>` (et ses files `.retry` et `.dlq`).
 *
 * À venir : événements de suspension, de reprise, d'avertissement et d'échec de reprogrammation du
 * Nettoyage, et ceux de la facturation (billing) — une règle et ses modèles par événement.
 */
export const EVENT_RULES: EventRules = { ...CLEANING_RULES };

export const LISTENED_EVENTS = Object.keys(EVENT_RULES) as KspEventType[];
