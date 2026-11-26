import { localDay } from '../../domain/calendar';
import { splitJournal } from '../../domain/litigation';
import { mainDebtor, STAGE_LABELS } from '../amicable/amicable-rules';
import { requireCaseInScope } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import {
  agentActor,
  debtorDisplayName,
  evidenceEntry,
  requireIdempotencyKey,
  stableId,
} from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import {
  type CaseDocumentData,
  type EvidenceEntryData,
  type JournalKind,
  noChanges,
  type RecoveryCaseRecord,
} from '../cases/ports';
import { BACKOFFICE_MFA_SECONDS, requireStaff } from '../shared/access';
import { RecoveryErrors } from '../shared/errors';
import { type LitigationDeps, noLitigationWrites, type NoticeRecord } from './litigation.ports';
import { commitLitigation, LEGAL_AND_SUPERVISORS, oneLine } from './litigation-rules';

/**
 * Journal de preuve en PDF (ExportCaseJournal, R-PR-08), remis à l'huissier, à l'avocat ou au juge :
 * modèle `recovery_evidence_log` de document, sans les entrées internes. Au plus 1 000 entrées et
 * 750 Ko de variables JSON par document (la première limite atteinte s'applique) : au-delà, le journal
 * est découpé par période, une partie par document (variable `part`, ADR-060 point 12). Le rendu est
 * long : l'adaptateur de document lui donne une échéance propre (15 s). Chaque partie entre aux pièces
 * du dossier, visible du partenaire ; l'export est tracé au journal et à l'audit.
 */

const TEMPLATE = 'recovery_evidence_log';
/** Limites du modèle v1 (service document) : entrées par document, octets de JSON des entrées. */
export const EVIDENCE_LOG_LIMITS = { entries: 1000, bytes: 750_000 } as const;

const KIND_LABELS: Record<JournalKind, string> = {
  contact: 'Contact',
  message_sent: 'Message envoyé',
  letter: 'Courrier',
  promise: 'Promesse de paiement',
  payment: 'Paiement',
  plan: 'Échéancier',
  decision: 'Décision',
  stage_changed: 'Changement d’étape',
  status_changed: 'Changement de statut',
  dispute: 'Contestation',
  document: 'Pièce',
  partner_act: 'Acte du partenaire',
  note: 'Note',
  system: 'Système',
};

const CHANNEL_LABELS: Record<string, string> = {
  phone: 'appel',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  email: 'e-mail',
  letter: 'courrier',
  visit: 'visite',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'En cours',
  suspended: 'Suspendu (contestation)',
  closed: 'Clos',
  rejected: 'Refusé',
};

type Delivery = 'sent' | 'delivered' | 'read' | 'failed';
const DELIVERIES: ReadonlySet<string> = new Set(['sent', 'delivered', 'read', 'failed']);

/** Entrée du modèle : horodatage, action, auteur, canal, statut de remise, résumé (une ligne chacun). */
interface LogEntry {
  at: string;
  action: string;
  actor: string;
  channel?: string;
  delivery?: Delivery;
  outcome?: string;
}

const encoder = new TextEncoder();

function clip(text: string, max: number): string {
  const line = oneLine(text, 10_000);
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export class ExportCaseJournalUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(input: { caseId: string; idempotencyKey: string }): Promise<{ documentId: string }> {
    const now = this.deps.clock.now();
    const staff = requireStaff(LEGAL_AND_SUPERVISORS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const key = requireIdempotencyKey(input.idempotencyKey);
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const partId = (index: number) =>
      stableId('recovery-evidence-log', record.id, staff.userId, key, String(index));
    const known = await this.deps.litigation.notice(partId(1));
    if (known) return { documentId: known.documentId };

    const journal = await this.deps.litigation.evidenceLog(record.id);
    if (journal.length === 0) {
      throw CaseErrors.invalidTransition(record.status, 'Le journal de ce dossier est vide.', record.stage);
    }
    const entries = await this.entries(record, journal);
    const parts = splitJournal(
      entries,
      (entry) => encoder.encode(JSON.stringify(entry)).length + 1,
      EVIDENCE_LOG_LIMITS.entries,
      EVIDENCE_LOG_LIMITS.bytes,
    );
    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const creditorName = names.holder(record.creditor);
    if (!creditorName) throw RecoveryErrors.dependencyUnavailable('identity');
    const base = {
      caseReference: record.number,
      creditor: { name: clip(creditorName, 200) },
      debtor: { name: clip(debtorDisplayName(mainDebtor(record)), 200) || 'Débiteur' },
      openedOn: localDay(record.createdAt),
      currentStage:
        record.status === 'active' && record.stage
          ? clip(STAGE_LABELS[record.stage], 80).replace(/^./, (c) => c.toUpperCase())
          : (STATUS_LABELS[record.status] ?? 'En cours'),
    };
    const actor = agentActor(staff.userId);
    const notices: NoticeRecord[] = [];
    const documents: CaseDocumentData[] = [];
    for (const [index, part] of parts.entries()) {
      const id = partId(index + 1);
      const document = await this.deps.documents.generate({
        template: TEMPLATE,
        variables: {
          ...base,
          ...(parts.length > 1
            ? { part: { index: index + 1, total: parts.length, from: part[0]!.at, to: part.at(-1)!.at } }
            : {}),
          entries: part,
        },
        subject: caseSubject(record.id),
        idempotencyKey: `recovery:evidence-log:${id}`,
      });
      notices.push({
        id,
        caseId: record.id,
        kind: 'evidence_log',
        documentId: document.id,
        documentNumber: document.number,
        signedBy: staff.userId,
        issuedAt: now,
        deadlineDays: null,
        deliveryMethod: null,
        deliveredAt: null,
        deliveredBy: null,
        proofFileId: null,
        deadlineAt: null,
      });
      documents.push({
        id: stableId('recovery-evidence-log-document', id),
        kind: 'evidence_log',
        label: `Journal de preuve ${document.number}${parts.length > 1 ? ` (partie ${index + 1}/${parts.length})` : ''}`,
        fileId: null,
        documentId: document.id,
        visibleToPartner: true,
        visibleToDebtor: false,
        addedBy: actor,
        addedAt: now,
      });
    }
    const next = { ...record, documents: [...record.documents, ...documents] };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, actor, {
        action: 'journal.exported',
        kind: 'document',
        summary:
          `Journal de preuve exporté (${entries.length} entrée(s)` +
          `${parts.length > 1 ? `, ${parts.length} parties` : ''}) : ` +
          notices.map((notice) => notice.documentNumber).join(', '),
        ref: { type: 'document', id: notices[0]!.documentId },
      }),
    );
    changes.audit.push({
      actorId: staff.userId,
      action: 'case.journal_exported',
      entityType: 'recovery_case',
      entityId: record.id,
      at: now,
      details: {
        entries: entries.length,
        parts: parts.length,
        documentIds: notices.map((n) => n.documentId),
      },
    });
    const litigation = noLitigationWrites();
    litigation.notices.push(...notices.map((row) => ({ row, expected: null })));
    await commitLitigation(this.deps, { record: next, changes, litigation });
    return { documentId: notices[0]!.documentId };
  }

  /** Entrées du modèle, dans l'ordre : auteur nommé (sans coordonnées), canal et remise en clair. */
  private async entries(
    record: RecoveryCaseRecord,
    journal: readonly EvidenceEntryData[],
  ): Promise<LogEntry[]> {
    const people = [
      ...new Set(
        journal
          .filter((entry) => entry.actor.type !== 'debtor' && entry.actor.type !== 'system' && entry.actor.id)
          .map((entry) => entry.actor.id!),
      ),
    ];
    const names = await displayNames(this.deps.directory, [record.creditor], people);
    const author = (entry: EvidenceEntryData): string => {
      const name = entry.actor.id ? names.user(entry.actor.id) : '';
      switch (entry.actor.type) {
        case 'system':
          return 'Système';
        case 'debtor':
          return 'Débiteur';
        case 'creditor':
          return clip(`${name || names.holder(record.creditor) || 'Créancier'}, créancier`, 100);
        case 'partner':
          return clip(`${name || 'Partenaire'}, partenaire`, 100);
        default:
          return clip(`${name || 'Équipe'}, KSP`, 100);
      }
    };
    return journal.map((entry) => ({
      at: entry.occurredAt.toISOString(),
      action: KIND_LABELS[entry.kind] ?? 'Action',
      actor: author(entry),
      ...(entry.channel && CHANNEL_LABELS[entry.channel] ? { channel: CHANNEL_LABELS[entry.channel] } : {}),
      ...(entry.deliveryStatus && DELIVERIES.has(entry.deliveryStatus)
        ? { delivery: entry.deliveryStatus as Delivery }
        : {}),
      ...(entry.summary.trim() ? { outcome: clip(entry.summary, 250) } : {}),
    }));
  }
}
