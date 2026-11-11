import { ERASED_WITH_ACCOUNT } from '../domain/purposes';
import { incomingKeyFor } from '../domain/stored-file';
import { type AccountErasure, type FileDeps } from './ports';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Fichiers traités par étape et par passage. */
export const PURGE_BATCH_SIZE = 100;

export interface PurgeReport {
  /** Envois jamais confirmés, supprimés. */
  expiredPending: number;
  /** Fichiers disponibles jamais rattachés à un objet, supprimés. */
  expiredUnattached: number;
  /** Fichiers effacés physiquement (contenu et ligne). */
  erased: number;
  /** Effacements en échec (stockage injoignable) : repris au passage suivant. */
  errors: number;
}

/**
 * Purge périodique (ADR-038), sûre avec plusieurs instances (changements d'état conditionnels,
 * effacement idempotent) :
 * 1. envoi non confirmé après `pendingTtlMinutes` → supprimé, effacement immédiat ;
 * 2. fichier disponible jamais rattaché après `unattachedTtlHours` → supprimé, effacement immédiat ;
 * 3. effacement physique des fichiers supprimés ou rejetés dont la date est passée : contenu effacé
 *    du stockage, puis ligne retirée. Un échec du stockage laisse la ligne : repris plus tard.
 */
export class PurgeFilesUseCase {
  constructor(private readonly deps: FileDeps) {}

  async execute(): Promise<PurgeReport> {
    const { files, storage, clock, settings } = this.deps;
    const now = clock.now();
    const expiredPending = await files.expirePending({
      createdBefore: new Date(now.getTime() - settings.pendingTtlMinutes * MINUTE_MS),
      now,
      limit: PURGE_BATCH_SIZE,
    });
    const expiredUnattached = await files.expireUnattached({
      completedBefore: new Date(now.getTime() - settings.unattachedTtlHours * HOUR_MS),
      now,
      limit: PURGE_BATCH_SIZE,
    });
    let erased = 0;
    let errors = 0;
    for (const file of await files.listToErase(now, PURGE_BATCH_SIZE)) {
      try {
        await storage.remove(file.storageKey);
        await storage.remove(incomingKeyFor(file.id));
        await files.remove(file.id, now);
        erased += 1;
      } catch {
        errors += 1;
      }
    }
    return { expiredPending, expiredUnattached, erased, errors };
  }
}

/**
 * Compte anonymisé par identity (`identity.user.deleted`, ADR-036) : ses fichiers en attente, jamais
 * rattachés ou de finalité effacée avec le compte (photo de profil) sont supprimés et effacés au
 * prochain passage de la purge ; ceux que leur finalité garde (pièces justificatives du
 * Recouvrement, photos de passages, documents générés) restent, détachés du compte. Idempotent
 * (inbox), dans la même transaction que la marque « événement traité ».
 */
export class EraseAccountFilesUseCase {
  constructor(private readonly deps: FileDeps) {}

  execute(input: { eventId: string; eventType: string; userId: string }): Promise<AccountErasure> {
    return this.deps.files.eraseAccount(input.userId.toLowerCase(), {
      eventId: input.eventId,
      consumer: `file.${input.eventType}`,
      erasedPurposes: ERASED_WITH_ACCOUNT,
      now: this.deps.clock.now(),
    });
  }
}
