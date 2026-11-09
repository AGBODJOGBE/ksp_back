import { type Json } from '../cleaning/cleaning.ports';

/**
 * Vue de la gateway sur le service file (ADR-038), indépendante de gRPC. Le contenu des fichiers
 * ne passe jamais par la gateway : seules les métadonnées et les adresses présignées transitent.
 */
export interface FileUploadInput {
  purpose: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** Un appel par méthode de ksp.file.v1.FileService exposée en REST. */
export interface FileApi {
  createUpload(input: FileUploadInput): Promise<Json>;
  completeUpload(id: string): Promise<Json>;
  getMyFile(id: string): Promise<Json>;
  createMyDownloadUrl(id: string): Promise<Json>;
}
