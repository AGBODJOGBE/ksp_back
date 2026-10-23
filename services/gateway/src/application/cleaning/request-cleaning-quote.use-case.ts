import { AppError } from '@ksp/platform';
import { type IdentityAccount } from '../identity/identity.ports';
import { type CleaningApi, type Json, type QuoteRequestInput } from './cleaning.ports';

/**
 * UC-CL-02 : « connecté, profil complet » est une exigence d'accès de la route (cahier des charges
 * Nettoyage, partie 5). cleaning n'a pas accès au profil (il vit dans identity) : la gateway le lit
 * auprès d'identity avant de transmettre la demande. Les autres routes du Nettoyage sont
 * transmises telles quelles : la gateway ne décide rien du métier.
 */
export class RequestCleaningQuoteUseCase {
  constructor(
    private readonly identity: IdentityAccount,
    private readonly cleaning: CleaningApi,
  ) {}

  async execute(input: QuoteRequestInput, idempotencyKey: string): Promise<Json> {
    const profile = await this.identity.getMe();
    if (profile.profileIncomplete) {
      throw AppError.precondition(
        'IDENTITY_PROFILE_INCOMPLETE',
        'Complétez votre nom dans votre profil avant de demander un devis.',
      );
    }
    return this.cleaning.requestQuote(input, idempotencyKey);
  }
}
