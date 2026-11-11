import { AllowedCallers } from '@ksp/platform';
import { fileV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { FILE_USE_CASES, type FileUseCases } from '../../application/use-cases';
import { presentDownload, presentFile, presentTicket } from './presenters';

/**
 * Adaptateur gRPC de l'espace connecté (gateway). Aucune règle métier ici ; aucune adresse
 * présignée n'est journalisée.
 */
@Controller()
@AllowedCallers('gateway')
@fileV1.FileServiceControllerMethods()
export class FileGrpcController implements fileV1.FileServiceController {
  constructor(@Inject(FILE_USE_CASES) private readonly useCases: FileUseCases) {}

  async createUpload(request: fileV1.CreateUploadRequest): Promise<fileV1.CreateUploadResponse> {
    return presentTicket(
      await this.useCases.createUpload.execute({
        purpose: request.purpose,
        fileName: request.fileName,
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
      }),
    );
  }

  async completeUpload(request: fileV1.CompleteUploadRequest): Promise<fileV1.CompleteUploadResponse> {
    return { file: presentFile(await this.useCases.completeUpload.byOwner(request.fileId)) };
  }

  async getMyFile(request: fileV1.GetMyFileRequest): Promise<fileV1.GetMyFileResponse> {
    return { file: presentFile(await this.useCases.getMyFile.execute(request.fileId)) };
  }

  async createMyDownloadUrl(
    request: fileV1.CreateMyDownloadUrlRequest,
  ): Promise<fileV1.CreateMyDownloadUrlResponse> {
    return { download: presentDownload(await this.useCases.createMyDownloadUrl.execute(request.fileId)) };
  }
}

/** Adaptateur gRPC des services métier (jeton de service) ; droits vérifiés par les cas d'usage. */
@Controller()
@fileV1.FileInternalServiceControllerMethods()
export class FileInternalGrpcController implements fileV1.FileInternalServiceController {
  constructor(@Inject(FILE_USE_CASES) private readonly useCases: FileUseCases) {}

  async createServiceUpload(
    request: fileV1.CreateServiceUploadRequest,
  ): Promise<fileV1.CreateServiceUploadResponse> {
    return presentTicket(
      await this.useCases.createServiceUpload.execute({
        purpose: request.purpose,
        fileName: request.fileName,
        contentType: request.contentType,
        sizeBytes: request.sizeBytes,
        subject: request.subject,
        ownerId: request.ownerId,
      }),
    );
  }

  async completeServiceUpload(
    request: fileV1.CompleteServiceUploadRequest,
  ): Promise<fileV1.CompleteServiceUploadResponse> {
    return { file: presentFile(await this.useCases.completeUpload.byService(request.fileId)) };
  }

  async attachFile(request: fileV1.AttachFileRequest): Promise<fileV1.AttachFileResponse> {
    const file = await this.useCases.attachFile.execute({
      fileId: request.fileId,
      subject: request.subject,
      ownerId: request.ownerId,
    });
    return { file: presentFile(file) };
  }

  async listFiles(request: fileV1.ListFilesRequest): Promise<fileV1.ListFilesResponse> {
    const files = await this.useCases.listFiles.execute({
      subject: request.subject,
      includeDownloadUrls: request.includeDownloadUrls,
    });
    return {
      files: files.map((item) => ({
        file: presentFile(item.file),
        download: item.download ? presentDownload(item.download) : undefined,
      })),
    };
  }

  async createDownloadUrl(
    request: fileV1.CreateDownloadUrlRequest,
  ): Promise<fileV1.CreateDownloadUrlResponse> {
    const result = await this.useCases.createDownloadUrl.execute({
      fileId: request.fileId,
      subject: request.subject,
    });
    return { file: presentFile(result.file), download: presentDownload(result.download) };
  }

  async deleteFile(request: fileV1.DeleteFileRequest): Promise<fileV1.DeleteFileResponse> {
    await this.useCases.deleteFile.execute({ fileId: request.fileId, subject: request.subject });
    return {};
  }
}
