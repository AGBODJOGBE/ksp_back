import { currentContext } from '@ksp/platform';
import { type DocumentRecord, type DocumentSubject, SUBJECT_ID, SUBJECT_TYPE } from '../domain/document';
import { effectiveStatus, type SignatureRequestRecord, type SignatureStatus } from '../domain/signature';
import { DocumentErrors } from './errors';
import { type DocumentDeps } from './ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_.-]{1,200}$/;

/** Appelant de développement, sans jeton de service vérifié (interdit en production par le kit). */
export const UNVERIFIED_CALLER = 'unverified';

/**
 * Service métier appelant DocumentInternalService (jeton de service vérifié par le kit). La
 * gateway et tout service hors de la liste sont refusés. Sans vérificateur (développement),
 * l'appelant n'est pas connu : `unverified`.
 */
export function requireInternalCaller(allowed: readonly string[]): string {
  const caller = currentContext()?.callerService;
  if (!caller) return UNVERIFIED_CALLER;
  if (!allowed.includes(caller)) throw DocumentErrors.callerForbidden();
  return caller;
}

/** Le service ne voit que ses documents (en développement, tous). */
export function ownsDocument(document: DocumentRecord, caller: string): boolean {
  return caller === UNVERIFIED_CALLER || document.producerService === caller;
}

export function requireUuid(field: string, value: string | undefined): string {
  if (!value || !UUID.test(value)) throw DocumentErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

/** Identifiant de document reçu d'un utilisateur : mal formé = introuvable (pas d'indice). */
export function documentIdOrNotFound(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw DocumentErrors.notFound();
  return value.toLowerCase();
}

export function optionalUuid(field: string, value: string | undefined): string | null {
  return value ? requireUuid(field, value) : null;
}

export function requireIdempotencyKey(value: string | undefined): string {
  const key = (value ?? '').trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw DocumentErrors.invalid('idempotencyKey', 'Clé d’idempotence obligatoire (200 caractères au plus).');
  }
  return key;
}

export function requireSubject(value: { type?: string; id?: string } | null | undefined): DocumentSubject {
  const type = value?.type ?? '';
  const id = value?.id ?? '';
  if (!SUBJECT_TYPE.test(type)) throw DocumentErrors.invalid('subject.type', 'Type d’objet invalide.');
  if (!SUBJECT_ID.test(id)) throw DocumentErrors.invalid('subject.id', 'Identifiant d’objet invalide.');
  return { type, id: UUID.test(id) ? id.toLowerCase() : id };
}

/** Demande de signature telle que présentée : statut réel et expiration du code en cours. */
export interface SignatureView {
  request: SignatureRequestRecord;
  status: SignatureStatus;
  codeExpiresAt: Date | null;
}

export interface DocumentView {
  document: DocumentRecord;
  signature: SignatureView | null;
}

/**
 * Document et sa demande la plus récente, statuts réels : une demande en attente dont la date est
 * passée est présentée expirée (et le document aussi), même avant le passage de la tâche planifiée.
 */
export async function viewOf(deps: DocumentDeps, document: DocumentRecord): Promise<DocumentView> {
  const now = deps.clock.now();
  const request = await deps.documents.latestRequest(document.id);
  if (!request) return { document, signature: null };
  const signature = await signatureViewOf(deps, request, now);
  const expired = signature.status === 'expired' && document.status === 'pending_signature';
  return { document: expired ? { ...document, status: 'expired' } : document, signature };
}

export async function signatureViewOf(
  deps: DocumentDeps,
  request: SignatureRequestRecord,
  now: Date,
): Promise<SignatureView> {
  const status = effectiveStatus(request, now);
  const code =
    status === 'pending'
      ? await deps.documents.activeCode(request.id, now, deps.settings.codePolicy.maxAttempts)
      : null;
  return { request, status, codeExpiresAt: code?.expiresAt ?? null };
}
