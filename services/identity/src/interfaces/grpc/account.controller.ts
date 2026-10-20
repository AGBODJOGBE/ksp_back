import { identityV1 } from '@ksp/contracts';
import { requireUser } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { GetMeUseCase, type Profile, UpdateMeUseCase } from '../../application/account/account.use-cases';
import { toUserMessage } from './mappers';

function toProfileMessage(profile: Profile): identityV1.GetMeResponse {
  return { user: toUserMessage(profile.account), profileIncomplete: profile.profileIncomplete };
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
}
