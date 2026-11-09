import { type DocumentContent } from '../domain/content';
import { type DocumentRecord, formatDocumentNumber, pdfFileName } from '../domain/document';
import { formatLongDate } from '../domain/format';
import { canProduce, findTemplate, TEST_TEMPLATE } from '../domain/templates/catalog';
import { DocumentErrors } from './errors';
import { type DocumentDeps } from './ports';
import {
  type DocumentView,
  optionalUuid,
  ownsDocument,
  requireIdempotencyKey,
  requireInternalCaller,
  requireSubject,
  requireUuid,
  UNVERIFIED_CALLER,
  viewOf,
} from './shared';

export interface GenerateInput {
  template?: string;
  templateVersion?: number;
  variablesJson?: string;
  subject?: { type?: string; id?: string } | null;
  ownerId?: string;
  idempotencyKey?: string;
}

/** Variables reçues en JSON : un objet, sinon refus (sans reprendre le contenu). */
function parseVariables(json: string | undefined): unknown {
  try {
    const value: unknown = JSON.parse(json || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Contenu jamais repris dans l'erreur ni journalisé.
  }
  throw DocumentErrors.variablesInvalid(['(racine)']);
}

/** Année du document, à l'heure du Bénin (un document du 31 décembre à 23 h 30 UTC est de l'année suivante). */
function yearIn(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(date));
}

/**
 * Production d'un document par un service métier (ADR-044) : modèle et version, variables
 * validées par leur schéma, numéro lisible, rendu PDF, stockage par file (rattaché au document),
 * empreinte SHA-256. Idempotente par la clé du service : un nouvel appel renvoie le même document.
 * Les variables ne sont pas conservées : le PDF fait foi.
 */
export class GenerateDocumentUseCase {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(input: GenerateInput): Promise<DocumentView> {
    const { settings, documents, clock, ids, renderer, pdfs, secrets } = this.deps;
    const caller = requireInternalCaller(settings.internalCallers);
    const code = (input.template ?? '').trim();
    const version = input.templateVersion ?? 0;
    if (!Number.isInteger(version) || version < 0) throw DocumentErrors.invalid('templateVersion');
    const entry = findTemplate(code, version);
    if (!entry || (code === TEST_TEMPLATE && !settings.genericTemplateEnabled)) {
      throw DocumentErrors.templateUnknown();
    }
    if (!canProduce(entry.info, caller === UNVERIFIED_CALLER ? null : caller))
      throw DocumentErrors.callerForbidden();
    const subject = requireSubject(input.subject);
    const ownerId = optionalUuid('ownerId', input.ownerId);
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);

    const prepared = entry.prepare(parseVariables(input.variablesJson));
    if (!prepared.ok) throw DocumentErrors.variablesInvalid(prepared.fields);

    const existing = await documents.findByIdempotencyKey(caller, idempotencyKey);
    if (existing) return this.replay(existing, entry.info.code, subject);

    const now = clock.now();
    const id = ids.next();
    const sequence = await documents.nextNumber(entry.info.numberPrefix, yearIn(now, settings.timeZone));
    const number = formatDocumentNumber(entry.info.numberPrefix, yearIn(now, settings.timeZone), sequence);
    const { document } = prepared;
    const content: DocumentContent = {
      title: document.title,
      number,
      dateLine: `Fait à ${document.place}, le ${formatLongDate(now, settings.timeZone)}`,
      blocks: document.build({ number, issuedAt: now, timeZone: settings.timeZone, issuer: settings.issuer }),
    };
    const pdf = await renderer.render(content, { title: document.title, createdAt: now });
    const { fileId } = await pdfs.store({
      documentId: id,
      fileName: pdfFileName(number, false),
      bytes: pdf,
      ownerId,
    });

    const record: DocumentRecord = {
      id,
      template: entry.info.code,
      templateVersion: entry.info.version,
      title: document.title,
      number,
      status: 'draft',
      subject,
      ownerId,
      producerService: caller,
      idempotencyKey,
      fileId,
      sha256: secrets.sha256(pdf),
      sizeBytes: pdf.byteLength,
      signedFileId: null,
      signedSha256: null,
      createdAt: now,
      signedAt: null,
      cancelledAt: null,
      cancellationReason: null,
    };
    if (await documents.create(record)) return { document: record, signature: null };

    // Même clé enregistrée en même temps par un autre appel : sa version fait foi.
    await pdfs.remove(fileId, id).catch(() => undefined);
    const winner = await documents.findByIdempotencyKey(caller, idempotencyKey);
    if (!winner) throw DocumentErrors.alreadyExists();
    return this.replay(winner, entry.info.code, subject);
  }

  private async replay(
    existing: DocumentRecord,
    template: string,
    subject: { type: string; id: string },
  ): Promise<DocumentView> {
    const same =
      existing.template === template &&
      existing.subject.type === subject.type &&
      existing.subject.id === subject.id;
    if (!same) throw DocumentErrors.alreadyExists();
    return viewOf(this.deps, existing);
  }
}

/** Lecture d'un document par le service qui l'a produit. */
export class GetDocumentUseCase {
  constructor(private readonly deps: DocumentDeps) {}

  async execute(documentId: string | undefined): Promise<DocumentView> {
    const caller = requireInternalCaller(this.deps.settings.internalCallers);
    const document = await this.deps.documents.findById(requireUuid('documentId', documentId));
    if (!document || !ownsDocument(document, caller)) throw DocumentErrors.notFound();
    return viewOf(this.deps, document);
  }
}
