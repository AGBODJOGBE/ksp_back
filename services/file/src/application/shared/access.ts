import { currentContext } from '@ksp/platform';
import { PURPOSE_NAMES, type Purpose, purposesOfService } from '../../domain/purposes';
import { FileErrors } from './errors';

/** Service métier appelant et finalités dont il est responsable. */
export interface ServiceScope {
  /** null : appelant inconnu (développement sans vérification des jetons de service). */
  service: string | null;
  purposes: readonly Purpose[];
}

/**
 * Appelant de FileInternalService (jeton de service vérifié par le kit) : un service responsable
 * d'au moins une finalité, sinon FILE_CALLER_FORBIDDEN (la gateway en est exclue). Sans
 * vérificateur (développement), l'appelant n'est pas connu : toutes les finalités sont ouvertes.
 * En production, la vérification des jetons est obligatoire (IDENTITY_JWKS_URL).
 */
export function requireServiceScope(): ServiceScope {
  const caller = currentContext()?.callerService;
  if (!caller) return { service: null, purposes: PURPOSE_NAMES };
  const purposes = purposesOfService(caller);
  if (purposes.length === 0) throw FileErrors.callerForbidden();
  return { service: caller, purposes };
}
