import { AppError } from '@ksp/platform';
import { defaultAssignmentScope } from '../../domain/role/role';
import { PhoneNumber } from '../../domain/user/phone-number';
import { type AccountRepository } from '../session/session.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type RoleGrant, type RoleRepository } from './role.ports';

/**
 * Amorçage des comptes internes (script roles:grant) : attribue un rôle au compte d'un numéro, avec
 * la portée par défaut du rôle. L'écran d'administration (UC-ID-19) appliquera en plus les règles
 * de périmètre (personne n'attribue un rôle supérieur au sien).
 */
export class GrantRoleUseCase {
  constructor(
    private readonly accounts: Pick<AccountRepository, 'findByPhone'>,
    private readonly roles: RoleRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: { phone: string; roleCode: string }): Promise<RoleGrant> {
    const phone = PhoneNumber.parse(input.phone);
    if (!phone) throw AppError.invalid('IDENTITY_PHONE_INVALID', 'Le numéro de téléphone est invalide.');
    const account = await this.accounts.findByPhone(phone.e164);
    if (!account) {
      throw AppError.notFound(
        'IDENTITY_USER_NOT_FOUND',
        'Aucun compte pour ce numéro : se connecter une première fois sur le site ou l’application.',
      );
    }
    const role = await this.roles.findDefinition(input.roleCode);
    if (!role) throw AppError.notFound('IDENTITY_ROLE_NOT_FOUND', `Rôle inconnu : ${input.roleCode}.`);
    const scope = defaultAssignmentScope(role);
    if (!scope) {
      throw AppError.invalid(
        'IDENTITY_ROLE_SCOPE_INVALID',
        `Le rôle ${role.code} ne s'attribue pas sans organisation.`,
      );
    }
    return this.roles.grant({
      assignmentId: this.ids.next(),
      userId: account.id,
      roleCode: role.code,
      ...scope,
      grantedBy: null,
      now: this.clock.now(),
    });
  }
}
