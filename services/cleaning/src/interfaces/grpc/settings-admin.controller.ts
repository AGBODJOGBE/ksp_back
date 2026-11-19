import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de SettingsAdminService — back-office : réglages du module (UC-NT-43). Métier v2
 * livré lot par lot (ADR-054) : chaque méthode pas encore livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.SettingsAdminServiceControllerMethods()
export class SettingsAdminGrpcController implements cleaningV1.SettingsAdminServiceController {
  getSettings(): Promise<cleaningV1.GetSettingsResponse> {
    return notImplemented('GetSettings');
  }

  updateSettings(): Promise<cleaningV1.UpdateSettingsResponse> {
    return notImplemented('UpdateSettings');
  }
}
