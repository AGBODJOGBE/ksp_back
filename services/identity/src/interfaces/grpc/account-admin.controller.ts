import { identityV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { FindAccountByPhoneUseCase } from '../../application/account-admin/find-account-by-phone.use-case';
import { USER_STATUS } from './mappers';

/**
 * Adaptateur gRPC de la recherche de compte au back-office (ADR-029), réservé à la gateway.
 * Rôles et double authentification revérifiés par le cas d'usage.
 */
@Controller()
@identityV1.AccountAdminServiceControllerMethods()
export class AccountAdminGrpcController implements identityV1.AccountAdminServiceController {
  constructor(private readonly findAccountByPhoneUseCase: FindAccountByPhoneUseCase) {}

  async findAccountByPhone(
    request: identityV1.FindAccountByPhoneRequest,
  ): Promise<identityV1.FindAccountByPhoneResponse> {
    const match = await this.findAccountByPhoneUseCase.execute({ phone: request.phoneE164 });
    return {
      account: {
        userId: match.userId,
        status: USER_STATUS[match.status],
        firstName: match.firstName ?? '',
        lastName: match.lastName ?? '',
        phoneMasked: match.phoneMasked,
      },
    };
  }
}
