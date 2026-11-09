import { AppError } from '@ksp/platform';
import { Body, Controller, Inject, Param } from '@nestjs/common';
import { type DocumentApi } from '../../application/document/document.ports';
import { DOCUMENT_API } from '../../tokens';
import { idFrom } from './cleaning.controller';
import { SIGNING_TOKEN } from './document-schemas';
import { Route } from './route.decorator';
import { parseBody, requestBodies } from './schemas';

/** Jeton du lien : mal formé, introuvable comme un jeton inconnu (aucun indice). */
function tokenFrom(value: unknown): string {
  if (typeof value !== 'string' || !SIGNING_TOKEN.test(value)) {
    throw AppError.notFound('DOCUMENT_SIGNATURE_NOT_FOUND', 'Cette demande de signature est introuvable.');
  }
  return value;
}

/**
 * Routes /api/v1/document/* (ADR-044) : lecture d'un document, signature par code depuis l'espace
 * KSP ou par un lien personnel sans compte. Droits revérifiés par document ; le PDF est lu
 * directement dans le stockage par une adresse de courte durée.
 */
@Controller()
export class DocumentHttpController {
  constructor(@Inject(DOCUMENT_API) private readonly documents: DocumentApi) {}

  @Route('getMyDocument')
  get(@Param('id') id: unknown) {
    return this.documents.getMyDocument(idFrom(id));
  }

  @Route('getMyDocumentDownloadUrl')
  downloadUrl(@Param('id') id: unknown) {
    return this.documents.createMyDownloadUrl(idFrom(id));
  }

  /** Pas de corps : le code part au téléphone (ou à l'e-mail vérifié) du compte signataire. */
  @Route('sendDocumentSignatureCode')
  sendCode(@Param('id') id: unknown) {
    return this.documents.sendSignatureCode(idFrom(id));
  }

  @Route('signDocument')
  sign(@Param('id') id: unknown, @Body() body: unknown) {
    return this.documents.signDocument(idFrom(id), parseBody(requestBodies.signDocument, body));
  }

  @Route('getSigningSession')
  session(@Param('token') token: unknown) {
    return this.documents.getSigningSession(tokenFrom(token));
  }

  @Route('sendSigningCode')
  sendLinkCode(@Param('token') token: unknown) {
    return this.documents.sendSigningCode(tokenFrom(token));
  }

  @Route('signWithLink')
  signWithLink(@Param('token') token: unknown, @Body() body: unknown) {
    return this.documents.signWithLink(tokenFrom(token), parseBody(requestBodies.signWithLink, body));
  }
}
