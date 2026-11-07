import { Body, Controller, Inject, Param } from '@nestjs/common';
import { type FileApi } from '../../application/file/file.ports';
import { FILE_API } from '../../tokens';
import { idFrom } from './cleaning.controller';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/**
 * Routes /api/v1/file/* (ADR-038) : métadonnées et adresses présignées seulement, le contenu est
 * envoyé et lu directement dans le stockage. Droits revérifiés par file (propriétaire seul).
 */
@Controller()
export class FileHttpController {
  constructor(@Inject(FILE_API) private readonly files: FileApi) {}

  @Route('createFileUpload')
  createUpload(@Body() body: unknown) {
    return this.files.createUpload(parseBody(requestBodies.createFileUpload, body));
  }

  /** Pas de corps : file relit le contenu reçu par le stockage. */
  @Route('completeFileUpload')
  complete(@Param('id') id: unknown) {
    return this.files.completeUpload(idFrom(id));
  }

  @Route('getMyFile')
  get(@Param('id') id: unknown) {
    return this.files.getMyFile(idFrom(id));
  }

  @Route('getMyFileDownloadUrl')
  downloadUrl(@Param('id') id: unknown) {
    return this.files.createMyDownloadUrl(idFrom(id));
  }
}
