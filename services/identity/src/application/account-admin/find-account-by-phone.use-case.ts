import { AppError } from '@ksp/platform';
import { PhoneNumber } from '../../domain/user/phone-number';
import { requireStaff } from '../organization/organization-admin.use-cases';
import { type AccountRepository, type UserStatusName } from '../session/session.ports';

/**
 * Rôles qui retrouvent un compte par son numéro au back-office (ADR-029) : l'admin du Nettoyage
 * rattache ainsi un agent ; la direction a la même portée. D'autres métiers s'ajouteront ici.
 */
export const ACCOUNT_LOOKUP_ROLES = ['cleaning_admin', 'super_admin'] as const;

/** Compte trouvé : le minimum pour le reconnaître et le rattacher, jamais l'e-mail ni le numéro complet. */
export interface AccountMatch {
  userId: string;
  status: UserStatusName;
  firstName: string | null;
  lastName: string | null;
  /** Indicatif et deux derniers chiffres (PhoneNumber.masked). */
  phoneMasked: string;
}

export const AccountLookupErrors = {
  phoneInvalid: () => AppError.invalid('IDENTITY_PHONE_INVALID', 'Le numéro de téléphone est invalide.'),
  notFound: () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Aucun compte KSP pour ce numéro.'),
};

/**
 * Recherche d'un compte par numéro E.164, au back-office (cleaning_admin, super_admin, double
 * authentification revérifiée ici). L'appelant connaît déjà le numéro : la réponse le rend masqué,
 * avec l'identifiant et le nom, sans aucune autre coordonnée. Un compte supprimé est introuvable.
 */
export class FindAccountByPhoneUseCase {
  constructor(private readonly accounts: Pick<AccountRepository, 'findByPhone'>) {}

  async execute(input: { phone: string }): Promise<AccountMatch> {
    requireStaff(ACCOUNT_LOOKUP_ROLES);
    const phone = PhoneNumber.parse(input.phone);
    if (!phone) throw AccountLookupErrors.phoneInvalid();
    const account = await this.accounts.findByPhone(phone.e164);
    if (!account || account.status === 'deleted') throw AccountLookupErrors.notFound();
    return {
      userId: account.id,
      status: account.status,
      firstName: account.firstName,
      lastName: account.lastName,
      phoneMasked: phone.masked(),
    };
  }
}
