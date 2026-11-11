import { allowedCallersOf } from '@ksp/platform';
import {
  DocumentGrpcController,
  DocumentInternalGrpcController,
  DocumentSigningGrpcController,
} from './document.controllers';

/** Métadonnées utilisateur non signées : espace connecté et lien réservés à la gateway (ADR-050). */
describe('appelants des contrôleurs document', () => {
  it.each([DocumentGrpcController, DocumentSigningGrpcController])('%p : gateway seule', (controller) => {
    expect(allowedCallersOf(controller)).toEqual(['gateway']);
  });

  it('DocumentInternalService : services métier, contrôlés par le cas d’usage', () => {
    expect(allowedCallersOf(DocumentInternalGrpcController)).toBeUndefined();
  });
});
