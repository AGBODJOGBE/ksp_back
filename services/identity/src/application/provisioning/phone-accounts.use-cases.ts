import { AppError } from '@ksp/platform';
import { PhoneNumber } from '../../domain/user/phone-number';
import { normalizeName } from '../../domain/user/profile';
import { AccountLookupErrors } from '../account-admin/find-account-by-phone.use-case';
import { isUuid } from '../context/active-contexts';
import { rbacErrors } from '../rbac/rbac-errors';
import { type AccountRepository, type UserStatusName } from '../session/session.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type PendingAccountRepository, type PhoneAccount } from './phone-accounts.ports';

/**
 * Compte d'un numéro de téléphone pour un autre service (IdentityService.FindUserByPhone et
 * EnsureUserByPhone ; CDC Nettoyage v2, R-AG-02 : agent créé ou invité par l'admin du Nettoyage).
 * L'appelant vient du jeton de service vérifié ; null sans vérificateur (développement seulement, le
 * kit l'interdit en production) : tout est alors permis, comme pour GrantRole.
 */

/** Services autorisés à lire ou créer un compte par son numéro (IDENTITY_PHONE_ACCOUNT_CALLERS du contrat). */
export const PHONE_ACCOUNT_CALLERS: readonly string[] = ['cleaning'];

/** États d'un compte qu'un service peut prendre pour le sien : actif, ou en attente de sa première connexion. */
const USABLE_STATUSES: readonly UserStatusName[] = ['active', 'pending_verification'];

const nameInvalid = (field: 'firstName' | 'lastName') =>
  AppError.invalid(
    'IDENTITY_NAME_INVALID',
    'Le prénom et le nom doivent contenir des lettres (100 caractères au plus), sans chiffres ni symboles.',
    { field },
  );
const accountNotUsable = (status: UserStatusName) =>
  AppError.precondition(
    'IDENTITY_ACCOUNT_NOT_USABLE',
    'Ce compte est suspendu, verrouillé, en cours de suppression ou supprimé.',
    { status },
  );

/** Service appelant, ou IDENTITY_CALLER_FORBIDDEN ; « system » sans vérificateur. */
function requireCaller(callerService: string | null): string {
  if (callerService !== null && !PHONE_ACCOUNT_CALLERS.includes(callerService)) {
    throw rbacErrors.callerForbidden();
  }
  return callerService ?? 'system';
}

/** Numéro contrôlé et normalisé par l'objet du domaine (ADR-063), ou IDENTITY_PHONE_INVALID. */
function requirePhone(value: string): PhoneNumber {
  const phone = PhoneNumber.parse(value);
  if (!phone) throw AccountLookupErrors.phoneInvalid();
  return phone;
}

function requireUsable(account: PhoneAccount): PhoneAccount {
  if (!USABLE_STATUSES.includes(account.status)) throw accountNotUsable(account.status);
  return account;
}

export type FoundUser = { found: false } | ({ found: true } & PhoneAccount);

/** FindUserByPhone : lecture seule. Un compte supprimé est introuvable, comme pour GetUser. */
export class FindUserByPhoneUseCase {
  constructor(private readonly accounts: Pick<AccountRepository, 'findByPhone'>) {}

  async execute(callerService: string | null, input: { phone: string }): Promise<FoundUser> {
    requireCaller(callerService);
    const account = await this.accounts.findByPhone(requirePhone(input.phone).e164);
    if (!account || account.status === 'deleted') return { found: false };
    return { found: true, userId: account.id, status: account.status };
  }
}

export interface EnsureUserInput {
  phone: string;
  firstName: string;
  lastName: string;
  /** Membre du personnel à l'origine de la demande (métadonnées de l'appel) ; tracé s'il est connu. */
  requestedBy: string | null;
}

/**
 * EnsureUserByPhone : rend le compte du numéro, ou le crée « en attente de vérification ». Le compte
 * créé devient actif à sa première connexion par code (VerifyOtp), qui vérifie son téléphone. Un
 * compte existant n'est jamais modifié. Compte suspendu, verrouillé, en cours de suppression ou
 * supprimé : IDENTITY_ACCOUNT_NOT_USABLE, rien n'est créé.
 */
export class EnsureUserByPhoneUseCase {
  constructor(
    private readonly accounts: Pick<AccountRepository, 'findByPhone'>,
    private readonly pending: PendingAccountRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    callerService: string | null,
    input: EnsureUserInput,
  ): Promise<PhoneAccount & { created: boolean }> {
    const service = requireCaller(callerService);
    const phone = requirePhone(input.phone);
    const firstName = normalizeName(input.firstName);
    if (!firstName) throw nameInvalid('firstName');
    const lastName = normalizeName(input.lastName);
    if (!lastName) throw nameInvalid('lastName');

    const existing = await this.accounts.findByPhone(phone.e164);
    if (existing) {
      return { ...requireUsable({ userId: existing.id, status: existing.status }), created: false };
    }
    const account = await this.pending.createPending({
      userId: this.ids.next(),
      phoneId: this.ids.next(),
      phoneE164: phone.e164,
      firstName,
      lastName,
      audit: {
        id: this.ids.next(),
        service,
        requestedBy: input.requestedBy && isUuid(input.requestedBy) ? input.requestedBy : null,
      },
      now: this.clock.now(),
    });
    // Compte créé entre-temps par un autre appel : mêmes règles que pour un compte déjà là.
    if (!account.created) requireUsable(account);
    return account;
  }
}
