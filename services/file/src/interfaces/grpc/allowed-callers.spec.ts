import { allowedCallersOf } from '@ksp/platform';
import { FileGrpcController, FileInternalGrpcController } from './file.controllers';

/** Métadonnées utilisateur non signées : espace connecté réservé à la gateway (ADR-050). */
describe('appelants des contrôleurs file', () => {
  it('FileService : gateway seule', () => {
    expect(allowedCallersOf(FileGrpcController)).toEqual(['gateway']);
  });

  it('FileInternalService : services responsables d’une finalité, contrôlés par le cas d’usage', () => {
    expect(allowedCallersOf(FileInternalGrpcController)).toBeUndefined();
  });
});
