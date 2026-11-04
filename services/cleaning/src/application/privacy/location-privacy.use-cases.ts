import { locationRetentionCutoff } from '../../domain/location';
import { type CleaningDeps } from '../deps';

/** Lignes effacées par passage de la base, pour ne pas tenir de longs verrous. */
export const LOCATION_PURGE_BATCH_SIZE = 500;

/**
 * Purge de la position (ADR-035) : coordonnées, précision, repère et adresse géocodée des demandes
 * et missions clôturées depuis plus de `locationRetentionMonths` mois (réglage du back-office).
 * Tâche périodique, idempotente et par lots ; rien n'est journalisé sur les personnes.
 */
export class PurgeLocationsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<{ requests: number; missions: number; cutoff: Date }> {
    const settings = await this.deps.catalog.getSettings();
    const cutoff = locationRetentionCutoff(this.deps.clock.now(), settings.locationRetentionMonths);
    const purged = await this.deps.requests.purgeLocations(cutoff, LOCATION_PURGE_BATCH_SIZE);
    return { ...purged, cutoff };
  }
}

/**
 * Compte client anonymisé par identity (identity.user.deleted) : la position de toutes ses demandes
 * et missions est effacée. Idempotent (inbox).
 */
export class EraseCustomerLocationsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  execute(input: { eventId: string; eventType: string; userId: string }): Promise<'processed' | 'duplicate'> {
    return this.deps.requests.eraseCustomerLocations(input.userId, {
      eventId: input.eventId,
      consumer: `cleaning.${input.eventType}`,
    });
  }
}
