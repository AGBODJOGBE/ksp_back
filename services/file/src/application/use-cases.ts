import {
  AttachFileUseCase,
  CreateDownloadUrlUseCase,
  CreateMyDownloadUrlUseCase,
  DeleteFileUseCase,
  GetMyFileUseCase,
  ListFilesUseCase,
} from './access.use-cases';
import { EraseAccountFilesUseCase, PurgeFilesUseCase } from './maintenance.use-cases';
import { type FileDeps } from './ports';
import { CompleteUploadUseCase, CreateServiceUploadUseCase, CreateUploadUseCase } from './uploads.use-cases';

/** Cas d'usage du service (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: FileDeps) {
  return {
    createUpload: new CreateUploadUseCase(deps),
    createServiceUpload: new CreateServiceUploadUseCase(deps),
    completeUpload: new CompleteUploadUseCase(deps),
    getMyFile: new GetMyFileUseCase(deps),
    createMyDownloadUrl: new CreateMyDownloadUrlUseCase(deps),
    attachFile: new AttachFileUseCase(deps),
    listFiles: new ListFilesUseCase(deps),
    createDownloadUrl: new CreateDownloadUrlUseCase(deps),
    deleteFile: new DeleteFileUseCase(deps),
    purgeFiles: new PurgeFilesUseCase(deps),
    eraseAccountFiles: new EraseAccountFilesUseCase(deps),
  };
}

export type FileUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const FILE_USE_CASES = Symbol('FILE_USE_CASES');
