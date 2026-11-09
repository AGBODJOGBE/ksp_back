/**
 * Événements publiés par document (ADR-044). Source de vérité :
 * contracts/events/document/*.schema.json. Identifiants et empreintes seulement : ni téléphone, ni
 * nom, ni adresse IP du signataire (la preuve complète reste dans la base de document).
 */
export interface DocumentEventPayloads {
  'document.signature.completed': {
    documentId: string;
    signatureRequestId: string;
    /** Modèle du document : recovery_mandate, recovery_settlement_agreement… */
    template: string;
    templateVersion: number;
    /** Service métier qui a produit le document et demandé la signature. */
    producerService: string;
    subjectType: string;
    subjectId: string;
    ownerId: string | null;
    /** null : signataire sans compte (débiteur), identifié par son téléphone. */
    signerUserId: string | null;
    method: 'one_time_code';
    /** Canal par lequel le code validé a été reçu. */
    channel: 'whatsapp' | 'email' | 'sms';
    /** Empreinte SHA-256 du PDF présenté et signé. */
    documentSha256: string;
    signedFileId: string;
    /** Empreinte SHA-256 du PDF signé (pages d'origine et page de certificat). */
    signedDocumentSha256: string;
    signedAt: string;
  };
}

export type DocumentEventType = keyof DocumentEventPayloads;
