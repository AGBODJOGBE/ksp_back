import { allowedCallersOf } from '@ksp/platform';
import { AccountAdminGrpcController } from './account-admin.controller';
import { AccountGrpcController } from './account.controller';
import { AuthGrpcController } from './auth.controller';
import { IdentityGrpcController } from './identity.controller';
import { OrganizationAdminGrpcController, OrganizationGrpcController } from './organization.controllers';

/** Métadonnées utilisateur non signées : seules les méthodes internes restent ouvertes aux services (ADR-050). */
describe('appelants des contrôleurs identity', () => {
  it.each([
    AuthGrpcController,
    AccountGrpcController,
    AccountAdminGrpcController,
    OrganizationGrpcController,
    OrganizationAdminGrpcController,
  ])('%p : gateway seule', (controller) => {
    expect(allowedCallersOf(controller)).toEqual(['gateway']);
  });

  it('IdentityService (annuaire, jetons de service) reste ouvert aux services', () => {
    expect(allowedCallersOf(IdentityGrpcController)).toBeUndefined();
  });
});
