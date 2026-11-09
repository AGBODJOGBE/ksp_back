import { type Json } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur le service document (ADR-044), indépendante de gRPC. Le PDF ne passe
 * jamais par la gateway : seules des adresses de lecture de courte durée transitent. Le jeton d'un
 * lien de signature est un secret : jamais journalisé.
 */
export interface SignInput {
  code: string;
  consent: boolean;
}

/** Un appel par méthode de ksp.document.v1.DocumentService et DocumentSigningService exposée en REST. */
export interface DocumentApi {
  getMyDocument(id: string): Promise<Json>;
  createMyDownloadUrl(id: string): Promise<Json>;
  sendSignatureCode(signatureRequestId: string): Promise<Json>;
  signDocument(signatureRequestId: string, input: SignInput): Promise<Json>;
  getSigningSession(token: string): Promise<Json>;
  sendSigningCode(token: string): Promise<Json>;
  signWithLink(token: string, input: SignInput): Promise<Json>;
}
