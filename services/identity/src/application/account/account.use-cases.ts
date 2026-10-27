import { AppError } from '@ksp/platform';
import { type ActiveContext, activeContextOf } from '../../domain/context/active-context';
import { isProfileIncomplete, normalizeLanguage, normalizeName } from '../../domain/user/profile';
import { type PendingEmails } from '../email/pending-email';
import { type Account, type AccountRepository, type ProfileChanges } from '../session/session.ports';

export interface Profile {
  account: Account;
  /** Le nom manque : obligatoire avant tout paiement ou dépôt de dossier. */
  profileIncomplete: boolean;
  /** Adresse e-mail en attente de confirmation par code ; null s'il n'y en a pas. */
  pendingEmail: string | null;
  /** Particulier ou entreprise : contexte du jeton d'accès de l'appelant (claim ctx). */
  activeContext: ActiveContext;
}

const notFound = () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.');

/** Compte encore existant pour son titulaire : un compte supprimé n'existe plus pour lui. */
function existing(account: Account | null): Account {
  if (!account || account.status === 'deleted') throw notFound();
  return account;
}

async function toProfile(
  account: Account | null,
  pendingEmails: PendingEmails,
  activeContext: string,
): Promise<Profile> {
  const found = existing(account);
  return {
    account: found,
    profileIncomplete: isProfileIncomplete(found),
    pendingEmail: await pendingEmails.of(found),
    activeContext: activeContextOf(activeContext),
  };
}

/** Lire son profil, avec le type de compte du contexte actif (`activeContext` : claim ctx du jeton). */
export class GetMeUseCase {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly pendingEmails: PendingEmails,
  ) {}

  async execute(userId: string, activeContext: string): Promise<Profile> {
    return toProfile(await this.accounts.findById(userId), this.pendingEmails, activeContext);
  }
}

export interface UpdateMeInput {
  userId: string;
  /** Contexte du jeton d'accès de l'appelant (claim ctx). */
  activeContext: string;
  firstName?: string;
  lastName?: string;
  preferredLanguage?: string;
}

/**
 * Compléter ou modifier son profil (UC-ID-01 : le nom se complète après l'inscription).
 * L'e-mail ne se modifie pas ici : il passe par la confirmation d'un code (ChangeEmailUseCase).
 */
export class UpdateMeUseCase {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly pendingEmails: PendingEmails,
  ) {}

  async execute(input: UpdateMeInput): Promise<Profile> {
    const changes: ProfileChanges = {};
    if (input.firstName !== undefined) changes.firstName = this.name(input.firstName, 'prénom');
    if (input.lastName !== undefined) changes.lastName = this.name(input.lastName, 'nom');
    if (input.preferredLanguage !== undefined) {
      const language = normalizeLanguage(input.preferredLanguage);
      if (!language) {
        throw AppError.invalid(
          'IDENTITY_LANGUAGE_INVALID',
          'La langue doit être un code de deux lettres, par exemple « fr ».',
        );
      }
      changes.preferredLanguage = language;
    }
    if (Object.keys(changes).length === 0) {
      throw AppError.invalid('IDENTITY_PROFILE_EMPTY_UPDATE', 'Aucun champ à modifier.');
    }

    existing(await this.accounts.findById(input.userId));
    return toProfile(
      await this.accounts.updateProfile(input.userId, changes),
      this.pendingEmails,
      input.activeContext,
    );
  }

  private name(value: string, label: string): string {
    const name = normalizeName(value);
    if (!name) {
      throw AppError.invalid(
        'IDENTITY_NAME_INVALID',
        `Le ${label} doit contenir des lettres (100 caractères au plus), sans chiffres ni symboles.`,
        { field: label === 'prénom' ? 'firstName' : 'lastName' },
      );
    }
    return name;
  }
}
