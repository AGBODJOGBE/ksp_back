import { AppError } from '@ksp/platform';
import { type RouteDefinition } from '../../domain/routing/route-manifest';
import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';
import { type IdentityAccount } from '../identity/identity.ports';
import { type CleaningApi, type CleaningCall } from './cleaning.ports';

/**
 * Transmet un appel du Nettoyage à cleaning. « Profil complet » est une exigence d'accès de la route
 * (extension x-ksp-requires-complete-profile, R-CP-02) : cleaning n'a pas accès au profil (il vit
 * dans identity), la gateway le lit auprès d'identity avant de transmettre. Seul le nom manquant
 * (profile_incomplete de GetMe) est contrôlé ici ; l'IFU de l'organisation du contexte actif, que le
 * contrat range aussi dans le profil incomplet, ne l'est pas encore. Les autres routes sont
 * transmises telles quelles : la gateway ne décide rien du métier.
 */
export class CallCleaningUseCase {
  constructor(
    private readonly identity: Pick<IdentityAccount, 'getMe'>,
    private readonly cleaning: CleaningApi,
  ) {}

  async execute(
    route: Pick<RouteDefinition, 'operationId' | 'requiresCompleteProfile'>,
    call: CleaningCall,
  ): Promise<unknown> {
    if (route.requiresCompleteProfile) await this.requireCompleteProfile();
    return this.cleaning.call(route.operationId as CleaningOperationId, call);
  }

  private async requireCompleteProfile(): Promise<void> {
    const profile = await this.identity.getMe();
    if (profile.profileIncomplete) {
      throw AppError.precondition(
        'IDENTITY_PROFILE_INCOMPLETE',
        'Complétez votre profil avant de continuer.',
      );
    }
  }
}
