import { type identityV1 } from '@ksp/contracts';
import { GrpcCaller } from '@ksp/platform';
import { of } from 'rxjs';
import { IdentityStaffDirectory } from './identity-staff-directory';

function directory(userIds: string[]) {
  const requests: identityV1.ListStaffByPermissionRequest[] = [];
  const client = {
    listStaffByPermission: (request: identityV1.ListStaffByPermissionRequest) => {
      requests.push(request);
      return of({ userIds });
    },
  } as unknown as identityV1.IdentityServiceClient;
  return { requests, staff: new IdentityStaffDirectory(client, new GrpcCaller({ target: 'identity' })) };
}

describe('IdentityStaffDirectory', () => {
  it('lit le personnel de la zone par ListStaffByPermission', async () => {
    const { staff, requests } = directory(['u-1', 'u-2']);
    await expect(staff.findStaff('cleaning.request.process', 'cotonou')).resolves.toEqual(['u-1', 'u-2']);
    expect(requests).toEqual([{ permission: 'cleaning.request.process', zoneKey: 'cotonou' }]);
  });

  it('sans zone : clé vide (attributions globales seulement)', async () => {
    const { staff, requests } = directory([]);
    await expect(staff.findStaff('cleaning.agent.manage', null)).resolves.toEqual([]);
    expect(requests).toEqual([{ permission: 'cleaning.agent.manage', zoneKey: '' }]);
  });
});
