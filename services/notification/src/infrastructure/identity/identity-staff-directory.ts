import { type identityV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { type StaffDirectory } from '../../application/events/event-notification.ports';

/**
 * Personnel du Nettoyage lu dans identity par gRPC (ListStaffByPermission, réservé à notification),
 * avec le jeton de service de notification (ADR-022). Identifiants seulement : les coordonnées se
 * lisent ensuite par GetUsersByIds. Lecture sans effet : l'appel peut être rejoué par l'appelant.
 */
export class IdentityStaffDirectory implements StaffDirectory {
  constructor(
    private readonly client: identityV1.IdentityServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async findStaff(permission: string, zoneKey: string | null): Promise<string[]> {
    // Convention protobuf : une chaîne vide vaut une valeur absente (attributions globales seulement).
    const request: identityV1.ListStaffByPermissionRequest = { permission, zoneKey: zoneKey ?? '' };
    const response = await this.caller.call(
      'listStaffByPermission',
      (metadata) => this.client.listStaffByPermission(request, metadata),
      { idempotent: true },
    );
    return response.userIds;
  }
}
