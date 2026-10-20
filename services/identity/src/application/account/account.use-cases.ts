import { AppError } from '@ksp/platform';
import { isProfileIncomplete, normalizeLanguage, normalizeName } from '../../domain/user/profile';
import { type Account, type AccountRepository, type ProfileChanges } from '../session/session.ports';

export interface Profile {
  account: Account;
  /** Le nom manque : obligatoire avant tout paiement ou dépôt de dossier. */
  profileIncomplete: boolean;
}

const notFound = () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.');

function toProfile(account: Account | null): Profile {
  // Un compte supprimé n'existe plus pour son ancien titulaire.
  if (!account || account.status === 'deleted') throw notFound();
  return { account, profileIncomplete: isProfileIncomplete(account) };
}

/** Lire son profil. */
export class GetMeUseCase {
  constructor(private readonly accounts: AccountRepository) {}

  async execute(userId: string): Promise<Profile> {
    return toProfile(await this.accounts.findById(userId));
  }
}

export interface UpdateMeInput {
  userId: string;
  firstName?: string;
  lastName?: string;
  preferredLanguage?: string;
}

/** Compléter ou modifier son profil (UC-ID-01 : le nom se complète après l'inscription). */
export class UpdateMeUseCase {
  constructor(private readonly accounts: AccountRepository) {}

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

    const current = await this.accounts.findById(input.userId);
    toProfile(current);
    return toProfile(await this.accounts.updateProfile(input.userId, changes));
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
