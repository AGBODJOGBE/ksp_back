import { identityV1 } from '@ksp/contracts';
import { AppError, currentContext, requireUser } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { type BackofficeSession } from '../../application/mfa/backoffice-session-opener';
import { ConfirmTotpUseCase } from '../../application/mfa/confirm-totp.use-case';
import { EnrollTotpUseCase } from '../../application/mfa/enroll-totp.use-case';
import { mfaErrors } from '../../application/mfa/mfa-errors';
import { type MfaRequired } from '../../application/mfa/open-mfa-challenge';
import { VerifyMfaUseCase } from '../../application/mfa/verify-mfa.use-case';
import { RequestOtpUseCase } from '../../application/otp/request-otp.use-case';
import { LogoutUseCase } from '../../application/session/logout.use-case';
import { RefreshSessionUseCase } from '../../application/session/refresh-session.use-case';
import { type OpenedSession, VerifyOtpUseCase } from '../../application/session/verify-otp.use-case';
import { GetSigningKeysUseCase } from '../../application/token/get-signing-keys.use-case';
import { type SecondFactorMethod } from '../../domain/mfa/mfa-challenge';
import { type OtpChannel } from '../../domain/otp/otp-challenge';
import { type ClientKind } from '../../domain/session/session-policy';
import { toActiveContextMessage, toUserMessage } from './mappers';

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

const MFA_METHOD_OUT: Record<SecondFactorMethod, identityV1.MfaMethod> = {
  totp: identityV1.MfaMethod.MFA_METHOD_TOTP,
  recovery_code: identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE,
};

/** Le SMS n'est jamais une seconde étape pour un compte interne (ADR-023). */
const MFA_METHOD_IN: Partial<Record<identityV1.MfaMethod, SecondFactorMethod>> = {
  [identityV1.MfaMethod.MFA_METHOD_TOTP]: 'totp',
  [identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE]: 'recovery_code',
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
    private readonly enrollTotpUseCase: EnrollTotpUseCase,
    private readonly confirmTotpUseCase: ConfirmTotpUseCase,
    private readonly verifyMfaUseCase: VerifyMfaUseCase,
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
    const clientKind = clientKindOf(request.clientKind);
    const client = currentContext()?.client;
    const outcome = await this.verifyOtpUseCase.execute({
      challengeId: request.challengeId,
      code: request.code,
      clientKind,
      deviceLabel: request.deviceLabel.trim() || null,
      ip: client?.ip ?? null,
      userAgent: client?.userAgent ?? null,
    });
    if (outcome.status === 'mfa_required') {
      return { result: { mfaRequired: toMfaChallenge(outcome.challenge) }, isNewUser: false };
    }
    return { result: { session: toSessionTokens(outcome.session) }, isNewUser: outcome.session.isNewUser };
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

  async enrollTotp(request: identityV1.EnrollTotpRequest): Promise<identityV1.EnrollTotpResponse> {
    return this.enrollTotpUseCase.execute({
      mfaToken: request.mfaToken,
      clientKind: clientKindOf(request.clientKind),
    });
  }

  async confirmTotp(request: identityV1.ConfirmTotpRequest): Promise<identityV1.ConfirmTotpResponse> {
    const result = await this.confirmTotpUseCase.execute({
      mfaToken: request.mfaToken,
      code: request.code,
      clientKind: clientKindOf(request.clientKind),
      ...clientDetails(),
    });
    return { session: toSessionTokens(result.session), recoveryCodes: result.recoveryCodes };
  }

  async verifyMfa(request: identityV1.VerifyMfaRequest): Promise<identityV1.VerifyMfaResponse> {
    const method = MFA_METHOD_IN[request.method];
    if (!method) throw mfaErrors.methodInvalid();
    const session = await this.verifyMfaUseCase.execute({
      mfaToken: request.mfaToken,
      method,
      code: request.code,
      clientKind: clientKindOf(request.clientKind),
      ...clientDetails(),
    });
    return { session: toSessionTokens(session), recoveryCodesRemaining: session.recoveryCodesRemaining };
  }
}

function clientKindOf(kind: identityV1.ClientKind): ClientKind {
  const clientKind = CLIENT_KIND[kind];
  if (!clientKind) {
    throw AppError.invalid('IDENTITY_CLIENT_KIND_INVALID', 'Le type de client est invalide.');
  }
  return clientKind;
}

/** Adresse IP et appareil du client, transmis par la gateway dans les métadonnées. */
function clientDetails(): { ip: string | null; userAgent: string | null } {
  const client = currentContext()?.client;
  return { ip: client?.ip ?? null, userAgent: client?.userAgent ?? null };
}

function toMfaChallenge(challenge: MfaRequired): identityV1.MfaChallenge {
  return {
    mfaToken: challenge.mfaToken,
    expiresAt: challenge.expiresAt.toISOString(),
    methods: challenge.methods.map((method) => MFA_METHOD_OUT[method]),
    enrollmentRequired: challenge.enrollmentRequired,
  };
}

function toSessionTokens(
  opened: Omit<OpenedSession, 'isNewUser'> | BackofficeSession,
): identityV1.SessionTokens {
  return {
    accessToken: opened.accessToken,
    accessTokenExpiresAt: opened.accessTokenExpiresAt.toISOString(),
    refreshToken: opened.refreshToken,
    refreshTokenExpiresAt: opened.refreshTokenExpiresAt.toISOString(),
    sessionId: opened.sessionId,
    user: toUserMessage(opened.account),
    profileIncomplete: opened.profileIncomplete,
    activeContext: toActiveContextMessage(opened.activeContext),
  };
}
