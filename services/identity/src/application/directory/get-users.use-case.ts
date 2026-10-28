import { AppError } from '@ksp/platform';
import { type Account } from '../session/session.ports';

/** Lecture de comptes par identifiant, pour les autres services (IdentityService). */
export interface UserDirectory {
  /** Comptes trouvés, dans un ordre quelconque ; un identifiant inconnu est simplement absent. */
  findByIds(userIds: readonly string[]): Promise<Account[]>;
}

/**
 * Services autorisés à lire les comptes, et s'ils reçoivent les coordonnées (téléphone, e-mail).
 * Carte des services : notification en a besoin pour prévenir un utilisateur à partir d'un événement
 * qui ne porte que son identifiant ; cleaning n'en lit que le nom, affiché au back-office (ADR-029).
 * Tout autre appelant est refusé jusqu'à son ajout ici.
 */
export const DIRECTORY_CALLERS: Readonly<Record<string, { contact: boolean }>> = {
  notification: { contact: true },
  cleaning: { contact: false },
};

/** Nombre maximum d'identifiants par appel à GetUsersByIds. */
export const MAX_USER_IDS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DirectoryErrors = {
  callerForbidden: () =>
    AppError.forbidden('IDENTITY_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à lire les comptes."),
  userIdInvalid: () => AppError.invalid('IDENTITY_USER_ID_INVALID', 'Identifiant de compte mal formé.'),
  tooManyUserIds: () =>
    AppError.invalid(
      'IDENTITY_TOO_MANY_USER_IDS',
      `Au plus ${MAX_USER_IDS} identifiants de compte par appel.`,
    ),
  notFound: () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'),
};

/**
 * Lit un ou plusieurs comptes pour un autre service (GetUser, GetUsersByIds).
 *
 * - `callerService` vient du jeton de service vérifié ; null sans vérificateur (développement
 *   uniquement, le kit l'interdit en production).
 * - Un compte supprimé n'existe plus pour les autres services : il est traité comme introuvable.
 * - Sans le droit aux coordonnées, le téléphone et l'e-mail sont retirés.
 */
export class GetUsersUseCase {
  constructor(private readonly directory: UserDirectory) {}

  async one(callerService: string | null, userId: string): Promise<Account> {
    const [account] = await this.many(callerService, [userId]);
    if (!account) throw DirectoryErrors.notFound();
    return account;
  }

  async many(callerService: string | null, userIds: readonly string[]): Promise<Account[]> {
    let policy = { contact: true };
    if (callerService !== null) {
      if (!Object.hasOwn(DIRECTORY_CALLERS, callerService)) throw DirectoryErrors.callerForbidden();
      policy = DIRECTORY_CALLERS[callerService];
    }
    if (userIds.length > MAX_USER_IDS) throw DirectoryErrors.tooManyUserIds();
    const ids = [...new Set(userIds.map((id) => id.trim().toLowerCase()))];
    if (ids.some((id) => !UUID.test(id))) throw DirectoryErrors.userIdInvalid();
    if (ids.length === 0) return [];

    const accounts = await this.directory.findByIds(ids);
    return accounts
      .filter((account) => account.status !== 'deleted')
      .map((account) =>
        policy.contact ? account : { ...account, phoneE164: null, email: null, emailVerifiedAt: null },
      );
  }
}
