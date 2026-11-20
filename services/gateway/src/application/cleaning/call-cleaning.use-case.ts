import { AppError } from '@ksp/platform';
import { type RouteDefinition } from '../../domain/routing/route-manifest';
import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';
import { type IdentityAccount } from '../identity/identity.ports';
import { type OrganizationsApi } from '../identity/organizations.ports';
import { type CleaningApi, type CleaningCall } from './cleaning.ports';

/**
 * Transmet un appel du Nettoyage à cleaning. « Profil complet » est une exigence d'accès de la route
 * (extension x-ksp-requires-complete-profile, R-CP-02) : cleaning n'a pas accès au profil (il vit
 * dans identity), la gateway le lit auprès d'identity avant de transmettre : nom manquant
 * (profile_incomplete de GetMe), ou organisation du contexte actif sans IFU (lue par
 * GetMyOrganization, le contrat de GetMe ne portant pas l'IFU). Les autres routes sont transmises
 * telles quelles : la gateway ne décide rien du métier.
 */
export class CallCleaningUseCase {
  constructor(
    private readonly identity: Pick<IdentityAccount, 'getMe'>,
    private readonly organizations: Pick<OrganizationsApi, 'getMine'>,
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
    const organizationId =
      profile.activeContext.type === 'business' ? profile.activeContext.organizationId : null;
    if (profile.profileIncomplete || (organizationId && !(await this.hasIfu(organizationId)))) {
      throw AppError.precondition(
        'IDENTITY_PROFILE_INCOMPLETE',
        'Complétez votre profil avant de continuer.',
      );
    }
  }

  /** L'organisation active porte-t-elle son IFU (R-CP-02) ? */
  private async hasIfu(organizationId: string): Promise<boolean> {
    const membership = (await this.organizations.getMine(organizationId)) as {
      organization?: { ifu?: unknown };
    };
    const ifu = membership.organization?.ifu;
    return typeof ifu === 'string' && ifu.trim().length > 0;
  }
}
