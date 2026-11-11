import { AllowedCallers } from '@ksp/platform';
import { documentV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { DOCUMENT_USE_CASES, type DocumentUseCases } from '../../application/use-cases';
import {
  presentDelivery,
  presentDocument,
  presentDownload,
  presentSession,
  presentSignature,
} from './presenters';

/**
 * Adaptateur gRPC des services métier (jeton de service) ; droits vérifiés par les cas d'usage.
 * Aucune règle métier ici ; ni les variables ni le contenu des documents ne sont journalisés.
 */
@Controller()
@documentV1.DocumentInternalServiceControllerMethods()
export class DocumentInternalGrpcController implements documentV1.DocumentInternalServiceController {
  constructor(@Inject(DOCUMENT_USE_CASES) private readonly useCases: DocumentUseCases) {}

  async generateDocument(
    request: documentV1.GenerateDocumentRequest,
  ): Promise<documentV1.GenerateDocumentResponse> {
    const view = await this.useCases.generateDocument.execute({
      template: request.template,
      templateVersion: request.templateVersion,
      variablesJson: request.variablesJson,
      subject: request.subject,
      ownerId: request.ownerId,
      idempotencyKey: request.idempotencyKey,
    });
    return { document: presentDocument(view) };
  }

  async getDocument(request: documentV1.GetDocumentRequest): Promise<documentV1.GetDocumentResponse> {
    return { document: presentDocument(await this.useCases.getDocument.execute(request.documentId)) };
  }

  async requestSignature(
    request: documentV1.RequestSignatureRequest,
  ): Promise<documentV1.RequestSignatureResponse> {
    const result = await this.useCases.requestSignature.execute({
      documentId: request.documentId,
      signer: request.signer,
      expiresInHours: request.expiresInHours,
      notice: request.notice,
      idempotencyKey: request.idempotencyKey,
    });
    return { document: presentDocument(result.view), signature: presentSignature(result.signature) };
  }

  async cancelDocument(
    request: documentV1.CancelDocumentRequest,
  ): Promise<documentV1.CancelDocumentResponse> {
    const view = await this.useCases.cancelDocument.execute({
      documentId: request.documentId,
      reason: request.reason,
    });
    return { document: presentDocument(view) };
  }

  async createDownloadUrl(
    request: documentV1.CreateDownloadUrlRequest,
  ): Promise<documentV1.CreateDownloadUrlResponse> {
    const link = await this.useCases.createDownloadUrl.execute({
      documentId: request.documentId,
      version: request.version,
    });
    return { download: presentDownload(link) };
  }
}

/** Adaptateur gRPC de l'espace connecté (gateway) : propriétaire et signataire connecté. */
@Controller()
@AllowedCallers('gateway')
@documentV1.DocumentServiceControllerMethods()
export class DocumentGrpcController implements documentV1.DocumentServiceController {
  constructor(@Inject(DOCUMENT_USE_CASES) private readonly useCases: DocumentUseCases) {}

  async getMyDocument(request: documentV1.GetMyDocumentRequest): Promise<documentV1.GetMyDocumentResponse> {
    return { document: presentDocument(await this.useCases.myDocuments.get(request.documentId)) };
  }

  async createMyDownloadUrl(
    request: documentV1.CreateMyDownloadUrlRequest,
  ): Promise<documentV1.CreateMyDownloadUrlResponse> {
    return { download: presentDownload(await this.useCases.myDocuments.downloadUrl(request.documentId)) };
  }

  async sendSignatureCode(
    request: documentV1.SendSignatureCodeRequest,
  ): Promise<documentV1.SendSignatureCodeResponse> {
    return {
      delivery: presentDelivery(await this.useCases.userSignature.sendCode(request.signatureRequestId)),
    };
  }

  async signDocument(request: documentV1.SignDocumentRequest): Promise<documentV1.SignDocumentResponse> {
    const view = await this.useCases.userSignature.sign({
      requestId: request.signatureRequestId,
      code: request.code,
      consent: request.consent,
    });
    return { document: presentDocument(view) };
  }
}

/** Adaptateur gRPC du lien de signature (route publique de la gateway) ; le jeton n'est jamais journalisé. */
@Controller()
@AllowedCallers('gateway')
@documentV1.DocumentSigningServiceControllerMethods()
export class DocumentSigningGrpcController implements documentV1.DocumentSigningServiceController {
  constructor(@Inject(DOCUMENT_USE_CASES) private readonly useCases: DocumentUseCases) {}

  async getSigningSession(
    request: documentV1.GetSigningSessionRequest,
  ): Promise<documentV1.GetSigningSessionResponse> {
    return { session: presentSession(await this.useCases.linkSignature.session(request.token)) };
  }

  async sendSigningCode(
    request: documentV1.SendSigningCodeRequest,
  ): Promise<documentV1.SendSigningCodeResponse> {
    return { delivery: presentDelivery(await this.useCases.linkSignature.sendCode(request.token)) };
  }

  async signWithLink(request: documentV1.SignWithLinkRequest): Promise<documentV1.SignWithLinkResponse> {
    const session = await this.useCases.linkSignature.sign({
      token: request.token,
      code: request.code,
      consent: request.consent,
    });
    return { session: presentSession(session) };
  }
}
