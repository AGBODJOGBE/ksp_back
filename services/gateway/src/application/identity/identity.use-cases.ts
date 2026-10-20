import { AppError } from '@ksp/platform';
import { type ClientKind, refreshTokenTransport } from '../../domain/client/client-kind';
import {
  type IdentityAccount,
  type IdentityAuth,
  type LoginOutcome,
  type LogoutScope,
  type OtpChallenge,
  type OtpChannel,
  type Profile,
  type ProfileChanges,
  type SessionTokens,
} from './identity.ports';

/**
 * Cas d'usage d'identity exposés par la gateway (UC-ID-01, 04, 05). La gateway ne décide rien
 * du métier : elle choisit seulement d'où vient le jeton de renouvellement (UC-GW-13).
 */

export class RequestOtpUseCase {
  constructor(private readonly identity: IdentityAuth) {}

  execute(input: { phone: string; channel?: OtpChannel | undefined }): Promise<OtpChallenge> {
    return this.identity.requestOtp({ phone: input.phone, channel: input.channel ?? null });
  }
}

export class VerifyOtpUseCase {
  constructor(private readonly identity: IdentityAuth) {}

  execute(input: {
    challengeId: string;
    code: string;
    deviceLabel?: string | undefined;
    clientKind: ClientKind;
  }): Promise<LoginOutcome> {
    return this.identity.verifyOtp({
      challengeId: input.challengeId,
      code: input.code,
      clientKind: input.clientKind,
      deviceLabel: input.deviceLabel?.trim() || null,
    });
  }
}

export class RefreshSessionUseCase {
  constructor(private readonly identity: IdentityAuth) {}

  /**
   * Navigateur : jeton lu dans le cookie, jamais dans le corps (il ne doit pas passer par le JavaScript).
   * Mobile : jeton lu dans le corps.
   */
  async execute(input: {
    clientKind: ClientKind;
    cookieToken?: string | undefined;
    bodyToken?: string | undefined;
  }): Promise<SessionTokens> {
    if (refreshTokenTransport(input.clientKind) === 'cookie') {
      if (input.bodyToken !== undefined) {
        throw AppError.invalid(
          'GATEWAY_VALIDATION_FAILED',
          'Le jeton de renouvellement est lu dans le cookie, pas dans le corps de la requête.',
          { fields: [{ field: 'refreshToken', reason: 'not_allowed' }] },
        );
      }
      if (!input.cookieToken) throw missingSession();
      return this.identity.refreshSession(input.cookieToken);
    }
    if (!input.bodyToken) throw missingSession();
    return this.identity.refreshSession(input.bodyToken);
  }
}

export class LogoutUseCase {
  constructor(private readonly identity: IdentityAuth) {}

  /** Non précisé : cet appareil (contrat OpenAPI). */
  execute(input: { scope?: LogoutScope | undefined }): Promise<number> {
    return this.identity.logout(input.scope ?? 'this_device');
  }
}

export class GetMeUseCase {
  constructor(private readonly account: IdentityAccount) {}

  execute(): Promise<Profile> {
    return this.account.getMe();
  }
}

export class UpdateMeUseCase {
  constructor(private readonly account: IdentityAccount) {}

  execute(changes: ProfileChanges): Promise<Profile> {
    return this.account.updateMe(changes);
  }
}

function missingSession(): AppError {
  return AppError.unauthenticated('GATEWAY_TOKEN_MISSING', 'Session absente, reconnectez-vous.');
}
