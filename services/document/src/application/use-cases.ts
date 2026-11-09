import { GenerateDocumentUseCase, GetDocumentUseCase } from './generate.use-case';
import { EraseAccountUseCase, ExpireSignaturesUseCase } from './maintenance.use-cases';
import { type DocumentDeps } from './ports';
import {
  CancelDocumentUseCase,
  CreateDownloadUrlUseCase,
  RequestSignatureUseCase,
} from './request-signature.use-cases';
import { LinkSignatureUseCases, MyDocumentUseCases, UserSignatureUseCases } from './signing.use-cases';

/** Cas d'usage du service, reliés aux mêmes dépendances. */
export function createUseCases(deps: DocumentDeps) {
  return {
    generateDocument: new GenerateDocumentUseCase(deps),
    getDocument: new GetDocumentUseCase(deps),
    requestSignature: new RequestSignatureUseCase(deps),
    cancelDocument: new CancelDocumentUseCase(deps),
    createDownloadUrl: new CreateDownloadUrlUseCase(deps),
    myDocuments: new MyDocumentUseCases(deps),
    userSignature: new UserSignatureUseCases(deps),
    linkSignature: new LinkSignatureUseCases(deps),
    expireSignatures: new ExpireSignaturesUseCase(deps),
    eraseAccount: new EraseAccountUseCase(deps),
  };
}

export type DocumentUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const DOCUMENT_USE_CASES = Symbol('DOCUMENT_USE_CASES');
