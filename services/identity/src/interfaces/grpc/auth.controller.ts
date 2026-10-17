import { identityV1 } from '@ksp/contracts';
import { AppError, currentContext } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { RequestOtpUseCase } from '../../application/otp/request-otp.use-case';
import { type OtpChannel } from '../../domain/otp/otp-challenge';
import { notImplemented } from './not-implemented';

const CHANNEL_IN: Partial<Record<identityV1.OtpChannel, OtpChannel>> = {
  [identityV1.OtpChannel.OTP_CHANNEL_SMS]: 'sms',
  [identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP]: 'whatsapp',
};

const CHANNEL_OUT: Record<OtpChannel, identityV1.OtpChannel> = {
  sms: identityV1.OtpChannel.OTP_CHANNEL_SMS,
  whatsapp: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
};

/**
 * Adaptateur gRPC de la connexion et des sessions, réservé à la gateway.
 * Aucune règle métier ici : chaque méthode traduit l'appel et délègue à son cas d'usage.
 */
@Controller()
@identityV1.AuthServiceControllerMethods()
export class AuthGrpcController implements identityV1.AuthServiceController {
  constructor(private readonly requestOtpUseCase: RequestOtpUseCase) {}

  async requestOtp(request: identityV1.RequestOtpRequest): Promise<identityV1.RequestOtpResponse> {
    if (request.purpose !== identityV1.OtpPurpose.OTP_PURPOSE_LOGIN) {
      throw AppError.invalid('IDENTITY_OTP_PURPOSE_INVALID', "L'objet du code est invalide.");
    }
    const result = await this.requestOtpUseCase.execute({
      phone: request.phoneE164,
      // Canal non précisé : SMS par défaut (cahier des charges Identité, partie 4).
      channel: CHANNEL_IN[request.channel] ?? 'sms',
      purpose: 'login',
      ip: currentContext()?.client?.ip ?? null,
    });
    return { ...result, channel: CHANNEL_OUT[result.channel] };
  }

  verifyOtp(): Promise<identityV1.VerifyOtpResponse> {
    return notImplemented('VerifyOtp');
  }

  refreshSession(): Promise<identityV1.RefreshSessionResponse> {
    return notImplemented('RefreshSession');
  }

  logout(): Promise<identityV1.LogoutResponse> {
    return notImplemented('Logout');
  }

  getSigningKeys(): Promise<identityV1.GetSigningKeysResponse> {
    return notImplemented('GetSigningKeys');
  }
}
