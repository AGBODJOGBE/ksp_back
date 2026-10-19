import { identityV1 } from '@ksp/contracts';
import { AppError, currentContext, requireUser } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { RequestOtpUseCase } from '../../application/otp/request-otp.use-case';
import { LogoutUseCase } from '../../application/session/logout.use-case';
import { RefreshSessionUseCase } from '../../application/session/refresh-session.use-case';
import { type OpenedSession, VerifyOtpUseCase } from '../../application/session/verify-otp.use-case';
import { GetSigningKeysUseCase } from '../../application/token/get-signing-keys.use-case';
import { type OtpChannel } from '../../domain/otp/otp-challenge';
import { type ClientKind } from '../../domain/session/session-policy';
import { toUserMessage } from './mappers';

const CHANNEL_IN: Partial<Record<identityV1.OtpChannel, OtpChannel>> = {
  [identityV1.OtpChannel.OTP_CHANNEL_SMS]: 'sms',
  [identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP]: 'whatsapp',
};

const CHANNEL_OUT: Record<OtpChannel, identityV1.OtpChannel> = {
  sms: identityV1.OtpChannel.OTP_CHANNEL_SMS,
  whatsapp: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
};

const CLIENT_KIND: Partial<Record<identityV1.ClientKind, ClientKind>> = {
  [identityV1.ClientKind.CLIENT_KIND_WEB]: 'web',
  [identityV1.ClientKind.CLIENT_KIND_MOBILE]: 'mobile',
  [identityV1.ClientKind.CLIENT_KIND_BACKOFFICE]: 'backoffice',
};

/**
 * Adaptateur gRPC de la connexion et des sessions, réservé à la gateway.
 * Aucune règle métier ici : chaque méthode traduit l'appel et délègue à son cas d'usage.
 */
@Controller()
@identityV1.AuthServiceControllerMethods()
export class AuthGrpcController implements identityV1.AuthServiceController {
  constructor(
    private readonly requestOtpUseCase: RequestOtpUseCase,
    private readonly verifyOtpUseCase: VerifyOtpUseCase,
    private readonly refreshSessionUseCase: RefreshSessionUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly getSigningKeysUseCase: GetSigningKeysUseCase,
  ) {}

  async requestOtp(request: identityV1.RequestOtpRequest): Promise<identityV1.RequestOtpResponse> {
    if (request.purpose !== identityV1.OtpPurpose.OTP_PURPOSE_LOGIN) {
      throw AppError.invalid('IDENTITY_OTP_PURPOSE_INVALID', "L'objet du code est invalide.");
    }
    const result = await this.requestOtpUseCase.execute({
      phone: request.phoneE164,
      // Canal non précisé : WhatsApp, seul canal au lancement (ADR-021) ; le SMS viendra avec un agrégateur.
      channel: CHANNEL_IN[request.channel] ?? 'whatsapp',
      purpose: 'login',
      ip: currentContext()?.client?.ip ?? null,
    });
    return { ...result, channel: CHANNEL_OUT[result.channel] };
  }

  async verifyOtp(request: identityV1.VerifyOtpRequest): Promise<identityV1.VerifyOtpResponse> {
    const clientKind = CLIENT_KIND[request.clientKind];
    if (!clientKind) {
      throw AppError.invalid('IDENTITY_CLIENT_KIND_INVALID', 'Le type de client est invalide.');
    }
    const client = currentContext()?.client;
    const opened = await this.verifyOtpUseCase.execute({
      challengeId: request.challengeId,
      code: request.code,
      clientKind,
      deviceLabel: request.deviceLabel.trim() || null,
      ip: client?.ip ?? null,
      userAgent: client?.userAgent ?? null,
    });
    return { result: { session: toSessionTokens(opened) }, isNewUser: opened.isNewUser };
  }

  async refreshSession(
    request: identityV1.RefreshSessionRequest,
  ): Promise<identityV1.RefreshSessionResponse> {
    return { session: toSessionTokens(await this.refreshSessionUseCase.execute(request.refreshToken)) };
  }

  async logout(request: identityV1.LogoutRequest): Promise<identityV1.LogoutResponse> {
    const user = requireUser();
    const revokedSessions = await this.logoutUseCase.execute({
      userId: user.userId,
      sessionId: user.sessionId,
      // Non précisé : cet appareil.
      scope:
        request.scope === identityV1.LogoutScope.LOGOUT_SCOPE_ALL_DEVICES ? 'all_devices' : 'this_device',
    });
    return { revokedSessions };
  }

  getSigningKeys(): identityV1.GetSigningKeysResponse {
    return { keys: this.getSigningKeysUseCase.execute() };
  }
}

function toSessionTokens(opened: Omit<OpenedSession, 'isNewUser'>): identityV1.SessionTokens {
  return {
    accessToken: opened.accessToken,
    accessTokenExpiresAt: opened.accessTokenExpiresAt.toISOString(),
    refreshToken: opened.refreshToken,
    refreshTokenExpiresAt: opened.refreshTokenExpiresAt.toISOString(),
    sessionId: opened.sessionId,
    user: toUserMessage(opened.account),
    profileIncomplete: opened.profileIncomplete,
  };
}
