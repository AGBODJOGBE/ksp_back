import { identityV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Metadata } from '@grpc/grpc-js';
import { type Observable } from 'rxjs';
import {
  type IdentityAccount,
  type IdentityAuth,
  type LoginOutcome,
  type LogoutScope,
  type MfaMethod,
  type OtpChallenge,
  type OtpChannel,
  type Profile,
  type ProfileChanges,
  type SessionTokens,
  type UserProfile,
  type UserStatus,
} from '../../application/identity/identity.ports';
import { type ClientKind } from '../../domain/client/client-kind';
import { toUpstreamError } from './upstream-error';

const CHANNEL_OUT: Record<OtpChannel, identityV1.OtpChannel> = {
  sms: identityV1.OtpChannel.OTP_CHANNEL_SMS,
  whatsapp: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
};

const CHANNEL_IN: Partial<Record<identityV1.OtpChannel, OtpChannel>> = {
  [identityV1.OtpChannel.OTP_CHANNEL_SMS]: 'sms',
  [identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP]: 'whatsapp',
};

const CLIENT_KIND: Record<ClientKind, identityV1.ClientKind> = {
  web: identityV1.ClientKind.CLIENT_KIND_WEB,
  mobile: identityV1.ClientKind.CLIENT_KIND_MOBILE,
  backoffice: identityV1.ClientKind.CLIENT_KIND_BACKOFFICE,
};

const LOGOUT_SCOPE: Record<LogoutScope, identityV1.LogoutScope> = {
  this_device: identityV1.LogoutScope.LOGOUT_SCOPE_THIS_DEVICE,
  all_devices: identityV1.LogoutScope.LOGOUT_SCOPE_ALL_DEVICES,
};

const USER_STATUS: Partial<Record<identityV1.UserStatus, UserStatus>> = {
  [identityV1.UserStatus.USER_STATUS_PENDING_VERIFICATION]: 'pending_verification',
  [identityV1.UserStatus.USER_STATUS_ACTIVE]: 'active',
  [identityV1.UserStatus.USER_STATUS_LOCKED]: 'locked',
  [identityV1.UserStatus.USER_STATUS_SUSPENDED]: 'suspended',
  [identityV1.UserStatus.USER_STATUS_DELETION_PENDING]: 'deletion_pending',
  [identityV1.UserStatus.USER_STATUS_DELETED]: 'deleted',
};

const MFA_METHOD: Partial<Record<identityV1.MfaMethod, MfaMethod>> = {
  [identityV1.MfaMethod.MFA_METHOD_TOTP]: 'totp',
  [identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE]: 'recovery_code',
  [identityV1.MfaMethod.MFA_METHOD_SMS]: 'sms',
};

/** Réponse d'identity qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
function malformed(what: string): AppError {
  return new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse d'identity inattendue (${what}).`);
}

const orNull = (value: string | undefined): string | null => (value ? value : null);

function toUser(user: identityV1.User | undefined): UserProfile {
  if (!user) throw malformed('utilisateur absent');
  const status = USER_STATUS[user.status];
  if (!status) throw malformed(`statut ${user.status}`);
  return {
    id: user.id,
    status,
    firstName: orNull(user.firstName),
    lastName: orNull(user.lastName),
    phone: orNull(user.phoneE164),
    email: orNull(user.email),
    preferredLanguage: user.preferredLanguage,
    createdAt: user.createdAt,
  };
}

function toSession(tokens: identityV1.SessionTokens | undefined): SessionTokens {
  if (!tokens) throw malformed('session absente');
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    sessionId: tokens.sessionId,
    user: toUser(tokens.user),
    profileIncomplete: tokens.profileIncomplete,
  };
}

function toProfile(response: identityV1.GetMeResponse): Profile {
  return { user: toUser(response.user), profileIncomplete: response.profileIncomplete };
}

/**
 * Client gRPC d'identity (AuthService, AccountService) : traduction des messages, délai,
 * coupe-circuit et jeton de service par GrpcCaller. Seules les lectures sont rejouées ;
 * une écriture ne l'est jamais (règles du cahier des charges Gateway, partie 4).
 */
export class IdentityGrpcAdapter implements IdentityAuth, IdentityAccount {
  private readonly logger = new Logger('IdentityGrpc');

  constructor(
    private readonly auth: identityV1.AuthServiceClient,
    private readonly account: identityV1.AccountServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async requestOtp(input: { phone: string; channel: OtpChannel | null }): Promise<OtpChallenge> {
    const response = await this.call('requestOtp', (metadata) =>
      this.auth.requestOtp(
        {
          phoneE164: input.phone,
          channel: input.channel ? CHANNEL_OUT[input.channel] : identityV1.OtpChannel.OTP_CHANNEL_UNSPECIFIED,
          purpose: identityV1.OtpPurpose.OTP_PURPOSE_LOGIN,
        },
        metadata,
      ),
    );
    const channel = CHANNEL_IN[response.channel];
    if (!channel) throw malformed(`canal ${response.channel}`);
    return {
      challengeId: response.challengeId,
      maskedTarget: response.maskedTarget,
      channel,
      expiresInSeconds: response.expiresInSeconds,
      resendAfterSeconds: response.resendAfterSeconds,
    };
  }

  async verifyOtp(input: {
    challengeId: string;
    code: string;
    clientKind: ClientKind;
    deviceLabel: string | null;
  }): Promise<LoginOutcome> {
    const response = await this.call('verifyOtp', (metadata) =>
      this.auth.verifyOtp(
        {
          challengeId: input.challengeId,
          code: input.code,
          clientKind: CLIENT_KIND[input.clientKind],
          deviceLabel: input.deviceLabel ?? '',
        },
        metadata,
      ),
    );
    const mfa = response.result?.mfaRequired;
    if (mfa) {
      return {
        status: 'mfa_required',
        challenge: {
          mfaToken: mfa.mfaToken,
          expiresAt: mfa.expiresAt,
          methods: mfa.methods.flatMap((method) => MFA_METHOD[method] ?? []),
          enrollmentRequired: mfa.enrollmentRequired,
        },
      };
    }
    return {
      status: 'authenticated',
      session: toSession(response.result?.session),
      isNewUser: response.isNewUser,
    };
  }

  async refreshSession(refreshToken: string): Promise<SessionTokens> {
    const response = await this.call('refreshSession', (metadata) =>
      this.auth.refreshSession({ refreshToken }, metadata),
    );
    return toSession(response.session);
  }

  async logout(scope: LogoutScope): Promise<number> {
    const response = await this.call('logout', (metadata) =>
      this.auth.logout({ scope: LOGOUT_SCOPE[scope] }, metadata),
    );
    return response.revokedSessions;
  }

  async getMe(): Promise<Profile> {
    return toProfile(
      await this.call('getMe', (metadata) => this.account.getMe({}, metadata), { idempotent: true }),
    );
  }

  async updateMe(changes: ProfileChanges): Promise<Profile> {
    const request: identityV1.UpdateMeRequest = {};
    if (changes.firstName !== undefined) request.firstName = changes.firstName;
    if (changes.lastName !== undefined) request.lastName = changes.lastName;
    if (changes.preferredLanguage !== undefined) request.preferredLanguage = changes.preferredLanguage;
    return toProfile(await this.call('updateMe', (metadata) => this.account.updateMe(request, metadata)));
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean } = {},
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('identity', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`identity.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
