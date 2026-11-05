import { identityV1 } from '@ksp/contracts';
import { currentContext, requireUser } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { GetMeUseCase, type Profile, UpdateMeUseCase } from '../../application/account/account.use-cases';
import {
  CancelDeletionUseCase,
  RequestDeletionUseCase,
} from '../../application/deletion/account-deletion.use-cases';
import { ChangeEmailUseCase } from '../../application/email/change-email.use-case';
import { ConfirmEmailUseCase } from '../../application/email/confirm-email.use-case';
import { toActiveContextMessage, toDeletionMessage, toUserMessage } from './mappers';

function toProfileMessage(profile: Profile): identityV1.GetMeResponse {
  return {
    user: toUserMessage(profile.account),
    profileIncomplete: profile.profileIncomplete,
    pendingEmail: profile.pendingEmail ?? '',
    activeContext: toActiveContextMessage(profile.activeContext),
    ...(profile.deletion ? { deletion: toDeletionMessage(profile.deletion) } : {}),
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
    private readonly requestDeletionUseCase: RequestDeletionUseCase,
    private readonly cancelDeletionUseCase: CancelDeletionUseCase,
  ) {}

  async getMe(): Promise<identityV1.GetMeResponse> {
    const user = requireUser();
    return toProfileMessage(await this.getMeUseCase.execute(user.userId, user.activeContext));
  }

  async updateMe(request: identityV1.UpdateMeRequest): Promise<identityV1.UpdateMeResponse> {
    const user = requireUser();
    const profile = await this.updateMeUseCase.execute({
      userId: user.userId,
      activeContext: user.activeContext,
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
    const user = requireUser();
    const profile = await this.confirmEmailUseCase.execute({
      userId: user.userId,
      code: request.code,
      activeContext: user.activeContext,
    });
    return {
      user: toUserMessage(profile.account),
      profileIncomplete: profile.profileIncomplete,
      activeContext: toActiveContextMessage(profile.activeContext),
    };
  }

  async requestDeletion(): Promise<identityV1.RequestDeletionResponse> {
    const deletion = await this.requestDeletionUseCase.execute(requireUser().userId);
    return { deletion: toDeletionMessage(deletion) };
  }

  async cancelDeletion(): Promise<identityV1.CancelDeletionResponse> {
    const user = requireUser();
    const result = await this.cancelDeletionUseCase.execute({
      userId: user.userId,
      sessionId: user.sessionId,
    });
    return {
      user: toUserMessage(result.account),
      profileIncomplete: result.profileIncomplete,
      activeContext: toActiveContextMessage(result.activeContext),
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    };
  }
}
