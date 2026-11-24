import { type CleaningDeps } from '../deps';
import { audit } from '../planning/assignment-support';
import { type StoredPhoto } from '../ports';
import { cleaningErrors } from '../shared/errors';
import { requireAgentAdmin } from './agent-access';
import { agentErrors } from './agent-errors';
import { type AgentRecord } from './agent.ports';
import { cipherContext } from './agent-views';

/** Une face de la pièce d'identité : fichier chez file et son adresse de lecture temporaire. */
export interface IdDocumentFile {
  fileId: string;
  /** Date du dépôt chez file ; celle de la candidature si le fichier n'est plus conservé. */
  uploadedAt: Date;
  /** Null : le fichier n'est plus conservé chez file. */
  url: string | null;
  urlExpiresAt: Date | null;
}

export interface AgentIdDocument {
  front: IdDocumentFile;
  back: IdDocumentFile;
}

/**
 * Pièce d'identité d'un agent (UC-NT-34, parties 9.1 et 16.3) : admin Nettoyage seulement. La pièce
 * est déchiffrée, ses deux fichiers sont lus chez file avec des adresses temporaires, et chaque
 * consultation est écrite au journal d'audit (`agent.id_document_read` : qui, quel agent, quand)
 * avant que les adresses ne soient rendues. Ni les fichiers, ni les adresses, ni le contenu de la
 * pièce n'entrent dans le journal, les traces ou un événement.
 */
export class GetAgentIdDocumentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(agentId: string): Promise<AgentIdDocument> {
    const actorId = requireAgentAdmin();
    const agent = await this.deps.planning.agentById(agentId);
    if (!agent) throw cleaningErrors.agentNotFound();
    if (!agent.idDocumentEncrypted) throw agentErrors.idDocumentMissing();
    const { frontFileId, backFileId } = JSON.parse(
      this.deps.cipher.decrypt(agent.idDocumentEncrypted, cipherContext.idDocument(agent.id)),
    ) as { frontFileId: string; backFileId: string };
    // Les erreurs de file sont transmises telles quelles : sans les fichiers, rien n'est consulté.
    const stored = await this.deps.photos.list({ type: 'cleaning_agent', id: agent.id });
    const document: AgentIdDocument = {
      front: side(agent, frontFileId, stored),
      back: side(agent, backFileId, stored),
    };
    // Trace écrite avant de rendre les adresses : sans elle, la pièce n'est pas montrée.
    const entry = audit(actorId, 'agent.id_document_read', 'agent', agent.id, this.deps.clock.now());
    await this.deps.planning.transaction((tx) => tx.write({ events: [], audit: [entry] }));
    return document;
  }
}

function side(agent: AgentRecord, fileId: string, stored: readonly StoredPhoto[]): IdDocumentFile {
  const file = stored.find((candidate) => candidate.fileId === fileId);
  return {
    fileId,
    uploadedAt: file?.uploadedAt ?? agent.createdAt,
    url: file?.downloadUrl ?? null,
    urlExpiresAt: file?.downloadExpiresAt ?? null,
  };
}
