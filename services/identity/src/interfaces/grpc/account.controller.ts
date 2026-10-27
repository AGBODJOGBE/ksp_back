import { identityV1 } from '@ksp/contracts';
import { currentContext, requireUser } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { GetMeUseCase, type Profile, UpdateMeUseCase } from '../../application/account/account.use-cases';
import { ChangeEmailUseCase } from '../../application/email/change-email.use-case';
import { ConfirmEmailUseCase } from '../../application/email/confirm-email.use-case';
import { toUserMessage } from './mappers';

function toProfileMessage(profile: Profile): identityV1.GetMeResponse {
  return {
    user: toUserMessage(profile.account),
    profileIncomplete: profile.profileIncomplete,
    pendingEmail: profile.pendingEmail ?? '',
  };
}

/**
 * Adaptateur gRPC du compte de l'utilisateur connecté, réservé à la gateway.
 * L'utilisateur vient toujours du contexte transmis par la gateway (jeton d'accès vérifié),
 * jamais du message : on ne lit ni ne modifie que son propre compte.
 */
@Controller()
@identityV1.AccountServiceControllerMethods()
export class AccountGrpcController implements identityV1.AccountServiceController {
  constructor(
    private readonly getMeUseCase: GetMeUseCase,
    private readonly updateMeUseCase: UpdateMeUseCase,
    private readonly changeEmailUseCase: ChangeEmailUseCase,
    private readonly confirmEmailUseCase: ConfirmEmailUseCase,
  ) {}

  async getMe(): Promise<identityV1.GetMeResponse> {
    return toProfileMessage(await this.getMeUseCase.execute(requireUser().userId));
  }

  async updateMe(request: identityV1.UpdateMeRequest): Promise<identityV1.UpdateMeResponse> {
    const profile = await this.updateMeUseCase.execute({
      userId: requireUser().userId,
      firstName: request.firstName,
      lastName: request.lastName,
      preferredLanguage: request.preferredLanguage,
    });
    return toProfileMessage(profile);
  }

  async changeEmail(request: identityV1.ChangeEmailRequest): Promise<identityV1.ChangeEmailResponse> {
    const result = await this.changeEmailUseCase.execute({
      userId: requireUser().userId,
      email: request.email,
      ip: currentContext()?.client?.ip ?? null,
    });
    return {
      pendingEmail: result.pendingEmail,
      expiresInSeconds: result.expiresInSeconds,
      resendAfterSeconds: result.resendAfterSeconds,
    };
  }

  async confirmEmail(request: identityV1.ConfirmEmailRequest): Promise<identityV1.ConfirmEmailResponse> {
    const profile = await this.confirmEmailUseCase.execute({
      userId: requireUser().userId,
      code: request.code,
    });
    return { user: toUserMessage(profile.account), profileIncomplete: profile.profileIncomplete };
  }
}
