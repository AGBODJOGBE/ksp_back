import { createHash } from 'node:crypto';
import { AppError } from '@ksp/platform';
import { localDay } from '../../domain/calendar';
import { changeStatus } from '../../domain/case';
import { type PlanOffer } from '../../domain/payment-plan';
import { caseFee, type PricingObject, type PricingRule, resolveRule, studyFee } from '../../domain/pricing';
import {
  type Clock,
  type Directory,
  type Documents,
  type Files,
  type FullSettings,
  type HolidayStore,
  type IdGenerator,
  type PricingRuleStore,
  type SettingsStore,
  type WalletGateway,
} from '../ports';
import { describeCommission } from '../pricing.use-cases';
import { loadSettings } from '../settings.use-cases';
import { type Creditor, currentCreditor } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import { creditorWriter, requireOwnCase } from './case-access';
import { CaseErrors } from './case-errors';
import { payCaseFee } from './case-fees';
import {
  type CaseContent,
  caseContentFrom,
  type CaseInputData,
  MAX_EVIDENCE,
  UUID,
  withContent,
} from './case-input';
import {
  amountDue,
  computeScore,
  creditorActor,
  debtorDisplayName,
  emptyCase,
  evidenceEntry,
  nameTokens,
  requireIdempotencyKey,
  requirePage,
  stableId,
} from './case-rules';
import { type CaseSummaryView, caseView, type CaseView, summaryViews } from './case-views';
import { persist } from './case-writes';
import {
  type CaseDocumentData,
  type CaseImportRepository,
  type CaseListFilter,
  type CaseQueries,
  type CaseRepository,
  type CreditorDashboardFigures,
  type CreditorPreferencesStore,
  type CreditorProfile,
  type CreditorProfiles,
  type EvidenceEntryData,
  noChanges,
  type RecoveryCaseRecord,
  type SimilarCaseProbe,
  type SpreadsheetReader,
} from './ports';

/** Dépendances des cas d'usage des dossiers (R2) ; un sous-ensemble de RecoveryDeps. */
export interface CaseDeps {
  cases: CaseRepository;
  caseQueries: CaseQueries;
  imports: CaseImportRepository;
  preferences: CreditorPreferencesStore;
  creditorProfiles: CreditorProfiles;
  spreadsheets: SpreadsheetReader;
  settings: SettingsStore;
  holidays: HolidayStore;
  rules: PricingRuleStore;
  wallet: WalletGateway;
  documents: Documents;
  files: Files;
  directory: Directory;
  clock: Clock;
  ids: IdGenerator;
}

/** Objet des pièces d'un dossier chez file et document. */
export const caseSubject = (caseId: string) => ({ type: 'recovery_case', id: caseId });

/** Durée du mandat imprimée sur le modèle v1 (à valider avec le juriste). */
export const MANDATE_DURATION_MONTHS = 12;

const NATURE_LABELS: Record<string, string> = {
  unpaid_invoice: 'Facture impayée',
  loan: 'Prêt',
  acknowledgment_of_debt: 'Reconnaissance de dette',
  bounced_cheque: 'Chèque impayé',
  service: 'Prestation',
  sale: 'Vente',
  rent: 'Loyers',
  other: 'Autre créance',
};

export function requireCaseId(caseId: string): string {
  if (!UUID.test(caseId ?? '')) throw CaseErrors.caseNotFound();
  return caseId.toLowerCase();
}

/** Montant minimum d'un dossier (R-SD-05) : le dû doit l'atteindre, et rester positif. */
export function requireMinimum(due: number, settings: FullSettings): void {
  const minimum = Math.max(1, settings.minimumCaseAmount);
  if (due < minimum) throw RecoveryErrors.amountBelowMinimum(minimum);
}

function contentDue(content: CaseContent): number {
  return (
    content.claims.reduce((sum, claim) => sum + claim.principal, 0) + content.interests - content.alreadyPaid
  );
}

/** Contacts et références d'un dossier, pour chercher les dossiers ouverts semblables (R-SD-06). */
export function similarityProbe(record: Pick<RecoveryCaseRecord, 'debtors' | 'claims'>): SimilarCaseProbe {
  const contacts = record.debtors.flatMap((debtor) => debtor.contacts);
  return {
    phones: contacts.filter((contact) => contact.channel === 'phone').map((contact) => contact.value),
    emails: contacts.filter((contact) => contact.channel === 'email').map((contact) => contact.value),
    references: record.claims.map((claim) => claim.reference),
  };
}

/** Saisie d'un dossier enregistré, pour comparer un rejeu de création (pièces exclues). */
function storedContent(record: RecoveryCaseRecord): Omit<CaseContent, 'evidenceFileIds'> {
  return {
    kind: record.kind as CaseContent['kind'],
    nature: record.nature,
    debtors: record.debtors.map((debtor) => ({
      kind: debtor.kind,
      role: debtor.role,
      firstNames: debtor.firstNames,
      lastName: debtor.lastName,
      legalName: debtor.legalName,
      ifu: debtor.ifu,
      rccm: debtor.rccm,
      representativeName: debtor.representativeName,
      address: debtor.address,
      communeKey: debtor.communeKey,
      phones: debtor.contacts.filter((c) => c.channel === 'phone').map((c) => c.value),
      emails: debtor.contacts.filter((c) => c.channel === 'email').map((c) => c.value),
    })),
    claims: record.claims.map((claim) => ({
      reference: claim.reference,
      nature: claim.nature,
      principal: claim.principal,
      dueDate: claim.dueDate,
      description: claim.description,
    })),
    interests: record.interests,
    alreadyPaid: record.claims.reduce((sum, claim) => sum + claim.paidBefore, 0),
    priorEffort: record.priorEffort,
    preserveRelationship: record.preserveRelationship,
    planScale: record.planScale,
  };
}

function withoutEvidence(content: CaseContent): Omit<CaseContent, 'evidenceFileIds'> {
  const { evidenceFileIds: _evidence, ...rest } = content;
  return rest;
}

/** Pièce justificative déposée par le créancier. */
function evidenceDocument(
  ids: IdGenerator,
  fileId: string,
  label: string,
  userId: string,
  at: Date,
): CaseDocumentData {
  return {
    id: ids.next(),
    kind: 'evidence',
    label,
    fileId,
    documentId: null,
    visibleToPartner: false,
    visibleToDebtor: false,
    addedBy: creditorActor(userId),
    addedAt: at,
  };
}

/** Pièces et preuve de reconnaissance rattachées au dossier chez file (idempotent pour le même objet). */
async function attachFiles(files: Files, caseId: string, fileIds: readonly string[], ownerId: string) {
  for (const fileId of fileIds) await files.attach({ fileId, subject: caseSubject(caseId), ownerId });
}

/**
 * Brouillon de dossier (CreateCase, UC-RC-01) : formulaire en cinq étapes contrôlé, montant minimum
 * (R-SD-05), pièces rattachées, numéro RC. Idempotent par (créancier, clé) : le rejeu de la même
 * saisie rend le même dossier (`created: false`), une autre saisie avec la même clé est refusée. Les
 * dossiers ouverts semblables (même débiteur, mêmes références) sont signalés sans bloquer (R-SD-06).
 */
export class CreateCaseUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { idempotencyKey: string; input: CaseInputData | null }): Promise<{
    view: CaseView;
    duplicates: CaseSummaryView[];
    created: boolean;
  }> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const key = requireIdempotencyKey(input.idempotencyKey);
    if (!input.input) throw RecoveryErrors.invalid('input', 'Saisie du dossier obligatoire.');
    const content = caseContentFrom(input.input, localDay(now));
    const { settings } = await loadSettings(this.deps.settings);
    requireMinimum(contentDue(content), settings);

    const replay = async (existing: RecoveryCaseRecord) => {
      if (JSON.stringify(storedContent(existing)) !== JSON.stringify(withoutEvidence(content))) {
        throw RecoveryErrors.keyReused();
      }
      return this.result(existing, settings, now, false);
    };
    const existing = await this.deps.cases.findByIdempotencyKey(creditor.holder, key);
    if (existing) return replay(existing);

    const id = stableId('recovery_case', creditor.holder.type, creditor.holder.id, key);
    const ownedFiles = [
      ...content.evidenceFileIds,
      ...(content.priorEffort.acknowledgmentFileId ? [content.priorEffort.acknowledgmentFileId] : []),
    ];
    await attachFiles(this.deps.files, id, ownedFiles, creditor.userId);
    const preferences = await this.deps.preferences.get(creditor.holder);
    const defaultScale = content.kind === 'b2b' ? preferences?.b2bScale : preferences?.b2cScale;
    const base = emptyCase({
      id,
      creditor: creditor.holder,
      createdBy: creditor.userId,
      source: 'form',
      importId: null,
      idempotencyKey: key,
      planScale: defaultScale ?? null,
      now,
    });
    const record: RecoveryCaseRecord = {
      ...withContent(base, content, () => this.deps.ids.next()),
      documents: content.evidenceFileIds.map((fileId, index) =>
        evidenceDocument(this.deps.ids, fileId, `Justificatif ${index + 1}`, creditor.userId, now),
      ),
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, creditorActor(creditor.userId), {
        action: 'case.created',
        kind: 'status_changed',
        summary:
          `Dossier créé (brouillon) : ${record.claims.length} créance(s), ${record.debtors.length} ` +
          `débiteur(s), ${record.documents.length} pièce(s), montant dû ${formatXof(amountDue(record))}`,
      }),
    );
    const created = await this.deps.cases.create(record, changes);
    if (created === 'duplicate') {
      const raced = await this.deps.cases.findByIdempotencyKey(creditor.holder, key);
      if (raced) return replay(raced);
      throw CaseErrors.concurrentUpdate('draft');
    }
    return this.result(created, settings, now, true);
  }

  private async result(record: RecoveryCaseRecord, settings: FullSettings, now: Date, created: boolean) {
    const similar = await this.deps.cases.findSimilarOpen(
      record.creditor,
      similarityProbe(record),
      record.id,
    );
    return {
      view: await caseView(this.deps, record, settings, now),
      duplicates: await summaryViews(this.deps, similar, settings, now),
      created,
    };
  }
}

/**
 * Modification d'un dossier (UpdateCase) : un brouillon se modifie librement (un mandat préparé mais
 * pas signé est alors à refaire) ; un dossier « complément demandé » reçoit la réponse du créancier
 * (UC-RC-04) et repasse en examen, avec un score recalculé. Les nouvelles pièces sont rattachées ;
 * une pièce déjà déposée reste au dossier.
 */
export class UpdateCaseUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: {
    caseId: string;
    input: CaseInputData | null;
    completionNote: string;
  }): Promise<CaseView> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    if (record.status !== 'draft' && record.status !== 'info_requested') {
      throw CaseErrors.invalidTransition(
        record.status,
        'Seul un brouillon, ou un dossier en attente de complément, se modifie.',
      );
    }
    if (!input.input) throw RecoveryErrors.invalid('input', 'Saisie du dossier obligatoire.');
    const content = caseContentFrom(input.input, localDay(now));
    const note = input.completionNote?.trim() ?? '';
    if (note.length > 2000) throw RecoveryErrors.invalid('completionNote', '2 000 caractères au plus.');
    const { settings } = await loadSettings(this.deps.settings);
    requireMinimum(contentDue(content), settings);

    const known = new Set(record.documents.map((document) => document.fileId));
    const added = content.evidenceFileIds.filter((fileId) => !known.has(fileId));
    const evidenceCount = record.documents.filter((document) => document.kind === 'evidence').length;
    if (evidenceCount + added.length > MAX_EVIDENCE) {
      throw RecoveryErrors.invalid('evidenceFileIds', `${MAX_EVIDENCE} pièces au plus.`);
    }
    const acknowledgment = content.priorEffort.acknowledgmentFileId;
    await attachFiles(
      this.deps.files,
      record.id,
      [
        ...added,
        ...(acknowledgment && acknowledgment !== record.priorEffort.acknowledgmentFileId
          ? [acknowledgment]
          : []),
      ],
      creditor.userId,
    );
    let next: RecoveryCaseRecord = {
      ...withContent(record, content, () => this.deps.ids.next()),
      documents: [
        ...record.documents,
        ...added.map((fileId, index) =>
          evidenceDocument(
            this.deps.ids,
            fileId,
            `Justificatif ${evidenceCount + index + 1}`,
            creditor.userId,
            now,
          ),
        ),
      ],
    };
    const actor = creditorActor(creditor.userId);
    const changes = noChanges();
    if (record.status === 'draft') {
      if (record.mandate && record.mandate.signedAt === null) {
        // Le mandat préparé décrivait l'ancienne saisie : il sera produit de nouveau.
        next = { ...next, mandate: null, pricing: null, fee: { ...next.fee, amount: 0, studyFee: 0 } };
      }
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, actor, {
          action: 'case.updated',
          kind: 'status_changed',
          summary: `Brouillon modifié : montant dû ${formatXof(amountDue(next))}`,
        }),
      );
    } else {
      const state = unwrap(changeStatus(next, 'under_review'));
      next = { ...next, status: state.status, infoRequestedAt: null, completionNote: note || null };
      next = { ...next, score: computeScore(next, settings, now) };
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, actor, {
          action: 'case.completed',
          kind: 'status_changed',
          summary: 'Complément envoyé par le créancier : dossier de nouveau en examen',
        }),
      );
    }
    const saved = await persist(this.deps.cases, next, changes, { content: true, now });
    return caseView(this.deps, saved, settings, now);
  }
}

/**
 * Justificatif ajouté à un dossier (AddCaseDocument) : fichier déjà envoyé par file (finalité
 * `recovery_evidence`), rattaché au dossier au nom du créancier ; 20 pièces au plus. Le même fichier
 * ajouté deux fois rend la même pièce.
 */
export class AddCaseDocumentUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { caseId: string; fileId: string; label: string }): Promise<CaseDocumentData> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    if (record.status === 'closed' || record.status === 'rejected') {
      throw CaseErrors.invalidTransition(record.status, 'Un dossier refusé ou clos ne reçoit plus de pièce.');
    }
    if (!UUID.test(input.fileId ?? '')) throw RecoveryErrors.invalid('fileId', 'Identifiant invalide.');
    const fileId = input.fileId.toLowerCase();
    const label = input.label?.trim() || 'Justificatif';
    if (label.length > 140) throw RecoveryErrors.invalid('label', '140 caractères au plus.');
    const known = record.documents.find((document) => document.fileId === fileId);
    if (known) return known;
    if (record.documents.filter((document) => document.kind === 'evidence').length >= MAX_EVIDENCE) {
      throw RecoveryErrors.invalid('fileId', `${MAX_EVIDENCE} pièces au plus.`);
    }
    await attachFiles(this.deps.files, record.id, [fileId], creditor.userId);
    const document = evidenceDocument(this.deps.ids, fileId, label, creditor.userId, now);
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, creditorActor(creditor.userId), {
        action: 'document.added',
        kind: 'document',
        summary: 'Pièce justificative ajoutée par le créancier',
        ref: { type: 'file', id: fileId },
      }),
    );
    await persist(this.deps.cases, { ...record, documents: [...record.documents, document] }, changes, {
      now,
    });
    return document;
  }
}

/** Règle publiée applicable au dossier pour un objet (tarif négocié du créancier prioritaire). */
async function applicableRule(
  rules: PricingRuleStore,
  object: PricingObject,
  record: RecoveryCaseRecord,
  now: Date,
): Promise<PricingRule | null> {
  const candidates = (await rules.listByObject(object)).map((stored) => stored.rule);
  return resolveRule(
    candidates,
    object,
    { offer: record.kind as PlanOffer, communeKey: record.communeKey, creditorId: record.creditor.id },
    now,
  );
}

/**
 * Honoraires de résultat imprimés sur le mandat v1, qui n'a qu'un taux (une décimale, 50 % au plus) :
 * taux de la règle, taux amiable d'une règle par étape, première tranche d'une règle par tranches. Le
 * détail exact (`commissionSummary`) est figé sur le dossier ; un modèle v2 devra l'imprimer.
 */
export function successFeePercent(rule: PricingRule): number {
  const mode = rule.mode;
  const bps =
    mode.kind === 'percentage'
      ? mode.rateBps
      : mode.kind === 'by_stage'
        ? mode.stageRates.amicable
        : mode.kind === 'tiered'
          ? (mode.tiers[0]?.rateBps ?? 0)
          : 0;
  return Math.min(50, Math.floor(bps / 10) / 10);
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** Variables du modèle `recovery_mandate` v1 (document) : jamais conservées par document. */
export function mandateVariables(
  record: RecoveryCaseRecord,
  creditor: CreditorProfile,
  fee: number,
  commissionRule: PricingRule,
): Record<string, unknown> {
  const main = record.debtors[0]!;
  const phone = main.contacts.find((contact) => contact.channel === 'phone' && contact.valid)?.value;
  const references = record.claims.map((claim) => claim.reference).join(', ');
  const cause = `${NATURE_LABELS[record.nature] ?? 'Créance'} — références : ${references}`;
  return {
    caseReference: record.number,
    creditor: {
      name: oneLine(creditor.name || 'Créancier', 200),
      kind: creditor.kind,
      ...(creditor.identification ? { identification: oneLine(creditor.identification, 100) } : {}),
      address: oneLine(creditor.address || 'Non communiquée', 300),
      ...(creditor.phone ? { phoneE164: creditor.phone } : {}),
      ...(creditor.email ? { email: creditor.email } : {}),
      ...(creditor.representative ? { representative: oneLine(creditor.representative, 200) } : {}),
    },
    debtor: {
      name: oneLine(debtorDisplayName(main), 200),
      ...(main.address ? { address: oneLine(main.address, 300) } : {}),
      ...(phone ? { phoneE164: phone } : {}),
    },
    claim: {
      principal: record.principal,
      cause: cause.slice(0, 1000),
      ...(record.earliestDueDate ? { dueDate: record.earliestDueDate } : {}),
      evidenceCount: Math.min(
        500,
        record.documents.filter((document) => document.kind === 'evidence').length,
      ),
    },
    fees: { successFeePercent: successFeePercent(commissionRule), ...(fee > 0 ? { fixedFee: fee } : {}) },
    durationMonths: MANDATE_DURATION_MONTHS,
  };
}

/**
 * Préparation du mandat (PrepareMandate, R-SD-03) : sur un brouillon complet (une pièce au moins,
 * montant minimum), dossiers semblables confirmés (R-SD-06). Fige les règles des frais, de la
 * commission et du forfait d'étude (R-CO-02), produit le mandat (document, modèle `recovery_mandate`)
 * et demande sa signature par code au créancier connecté. Le dossier passe « frais à payer » à la
 * signature (`document.signature.completed`). Rejouée avec la même saisie, elle rend le même mandat.
 */
export class PrepareMandateUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { caseId: string; duplicatesAcknowledged: boolean }): Promise<{
    view: CaseView;
    documentId: string;
    signatureRequestId: string;
  }> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    if (record.status !== 'draft') {
      throw CaseErrors.invalidTransition(record.status, 'Le mandat se prépare sur un brouillon.');
    }
    if (!record.documents.some((document) => document.kind === 'evidence')) {
      throw RecoveryErrors.invalid(
        'evidenceFileIds',
        'Au moins une pièce prouvant la créance avant le mandat.',
      );
    }
    const { settings } = await loadSettings(this.deps.settings);
    const due = amountDue(record);
    requireMinimum(due, settings);
    const similar = await this.deps.cases.findSimilarOpen(
      record.creditor,
      similarityProbe(record),
      record.id,
    );
    if (similar.length > 0 && !input.duplicatesAcknowledged) {
      throw duplicatesError(similar.map((item) => item.number));
    }
    const feeRule = await applicableRule(this.deps.rules, 'case_fee', record, now);
    if (!feeRule) throw RecoveryErrors.noApplicableRule('case_fee');
    const commissionRule = await applicableRule(this.deps.rules, 'recovery_commission', record, now);
    if (!commissionRule) throw RecoveryErrors.noApplicableRule('recovery_commission');
    const studyRule = await applicableRule(this.deps.rules, 'study_fee', record, now);
    const fee = caseFee(feeRule, due).amount;
    const retained = studyRule ? studyFee(studyRule, fee) : 0;

    const profile = await this.deps.creditorProfiles.profile(creditor);
    const variables = mandateVariables(record, profile, fee, commissionRule);
    const digest = createHash('sha256').update(JSON.stringify(variables)).digest('hex').slice(0, 16);
    const document = await this.deps.documents.generate({
      template: 'recovery_mandate',
      variables,
      subject: caseSubject(record.id),
      ownerId: creditor.userId,
      idempotencyKey: `recovery:mandate:${record.id}:${digest}`,
    });
    if (record.mandate?.documentId === document.id && record.mandate.signatureRequestId) {
      // Même mandat déjà demandé : le code se redemande à document (SendSignatureCode).
      return {
        view: await caseView(this.deps, record, settings, now),
        documentId: document.id,
        signatureRequestId: record.mandate.signatureRequestId,
      };
    }
    const signature = await this.deps.documents.requestSignature({
      documentId: document.id,
      signer: { userId: creditor.userId, displayName: profile.representative ?? profile.name },
      notice: 'code',
      idempotencyKey: `recovery:mandate-signature:${document.id}`,
    });
    const next: RecoveryCaseRecord = {
      ...record,
      mandate: { documentId: document.id, signatureRequestId: signature.signatureId, signedAt: null },
      pricing: {
        feeRuleId: feeRule.id,
        feeRuleVersion: feeRule.version,
        commissionRuleId: commissionRule.id,
        commissionRuleVersion: commissionRule.version,
        commissionSummary: describeCommission(commissionRule),
        studyFeeRuleId: studyRule?.id ?? null,
        studyFeeRuleVersion: studyRule?.version ?? null,
      },
      fee: { ...record.fee, amount: fee, studyFee: retained },
    };
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, next, now, creditorActor(creditor.userId), {
        action: 'mandate.prepared',
        kind: 'document',
        summary:
          `Mandat ${document.number} préparé, en attente de la signature du créancier ; frais de ` +
          `dossier ${formatXof(fee)}`,
        ref: { type: 'document', id: document.id },
      }),
    );
    const saved = await persist(this.deps.cases, next, changes, { now });
    return {
      view: await caseView(this.deps, saved, settings, now),
      documentId: document.id,
      signatureRequestId: signature.signatureId,
    };
  }
}

/** Dossiers semblables non confirmés (R-SD-06) : leurs numéros, pour les montrer au créancier. */
function duplicatesError(numbers: readonly string[]): AppError {
  return AppError.invalid(
    'RECOVERY_VALIDATION_FAILED',
    'Des dossiers semblables sont déjà ouverts : confirmez-les avant de préparer le mandat.',
    { field: 'duplicatesAcknowledged', duplicates: [...numbers] },
  );
}

/**
 * Paiement des frais de dossier (PayCaseFee, R-SD-04) : un débit du portefeuille prépayé du contexte
 * actif, puis le dossier part en examen. Mandat non signé : RECOVERY_MANDATE_NOT_SIGNED ; solde
 * insuffisant : RECOVERY_INSUFFICIENT_FUNDS, à rejouer après recharge. La clé du débit est propre au
 * dossier : un rejeu, quelle que soit la clé du client, ne débite jamais deux fois.
 */
export class PayCaseFeeUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { caseId: string; idempotencyKey: string }): Promise<CaseView> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    requireIdempotencyKey(input.idempotencyKey);
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    const { settings } = await loadSettings(this.deps.settings);
    if (record.fee.paidAt) return caseView(this.deps, record, settings, now);
    if (record.status === 'draft') throw CaseErrors.mandateNotSigned();
    if (record.status !== 'awaiting_fee') {
      throw CaseErrors.invalidTransition(
        record.status,
        'Les frais se paient sur un dossier au mandat signé.',
      );
    }
    const paid = await payCaseFee(this.deps, record, settings, creditorActor(creditor.userId));
    return caseView(this.deps, paid, settings, now);
  }
}

const STATUSES = [
  'draft',
  'awaiting_fee',
  'under_review',
  'info_requested',
  'active',
  'suspended',
  'closed',
  'rejected',
] as const;
const STAGES = ['notice', 'payment_plan', 'amicable', 'formal_notice', 'bailiff', 'litigation'] as const;
const KINDS = ['b2b', 'b2c', 'rent'] as const;

function allOf<T extends string>(field: string, values: readonly string[], allowed: readonly T[]): T[] {
  return values.map((value, index) => {
    if (!allowed.includes(value as T)) {
      throw RecoveryErrors.invalid(`${field}[${index}]`, `Valeur attendue : ${allowed.join(', ')}.`);
    }
    return value as T;
  });
}

/** Filtres communs des listes : statuts, étapes, offres, numéro ou nom du débiteur (3 caractères). */
export function listFilter(input: {
  statuses: readonly string[];
  stages: readonly string[];
  kinds: readonly string[];
  search: string;
}): CaseListFilter {
  const filter: CaseListFilter = {};
  if (input.statuses.length > 0) filter.statuses = allOf('filter.statuses', input.statuses, STATUSES);
  if (input.stages.length > 0) filter.stages = allOf('filter.stages', input.stages, STAGES);
  if (input.kinds.length > 0) filter.kinds = allOf('filter.kinds', input.kinds, KINDS);
  const search = input.search?.trim() ?? '';
  if (search) {
    if (search.length < 3) throw RecoveryErrors.invalid('filter.search', '3 caractères au moins.');
    const number = /^(rc-?)?(\d+)$/i.exec(search);
    if (number) {
      filter.number = number[2]!;
    } else {
      const tokens = nameTokens(search);
      if (tokens.length === 0) throw RecoveryErrors.invalid('filter.search', 'Mots de 3 lettres au moins.');
      filter.debtorNameTokens = tokens;
    }
  }
  return filter;
}

/** Dossiers du contexte actif (ListMyCases), les plus récents d'abord ; lecture ouverte aux lecteurs. */
export class ListMyCasesUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: {
    statuses: readonly string[];
    stages: readonly string[];
    kinds: readonly string[];
    search: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: CaseSummaryView[]; nextCursor: string | null; total: number }> {
    const creditor = currentCreditor();
    const now = this.deps.clock.now();
    const filter = { ...listFilter(input), creditor: creditor.holder };
    const result = await this.deps.caseQueries.list(filter, requirePage(input.page));
    const { settings } = await loadSettings(this.deps.settings);
    return {
      items: await summaryViews(this.deps, result.items, settings, now),
      nextCursor: result.nextCursor,
      total: result.total,
    };
  }
}

/** Fiche d'un dossier du créancier (GetMyCase). */
export class GetMyCaseUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { caseId: string }): Promise<CaseView> {
    const creditor = currentCreditor();
    const now = this.deps.clock.now();
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    const { settings } = await loadSettings(this.deps.settings);
    return caseView(this.deps, record, settings, now);
  }
}

export interface JournalView {
  entries: { entry: EvidenceEntryData; authorName: string }[];
  nextCursor: string | null;
}

/** Entrées du journal avec le nom affiché de leurs auteurs (comptes KSP). */
export async function journalView(
  deps: Pick<CaseDeps, 'directory'>,
  items: readonly EvidenceEntryData[],
  nextCursor: string | null,
): Promise<JournalView> {
  const ids = [...new Set(items.map((entry) => entry.actor.id).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    try {
      for (const person of await deps.directory.usersByIds(ids)) names.set(person.userId, person.displayName);
    } catch {
      // identity indisponible : auteurs sans nom affiché.
    }
  }
  return {
    entries: items.map((entry) => ({
      entry,
      authorName: entry.actor.id ? (names.get(entry.actor.id) ?? '') : '',
    })),
    nextCursor,
  };
}

/** Journal du dossier pour le créancier (ListMyCaseJournal), sans les notes internes (R-PR-08). */
export class ListMyCaseJournalUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(input: { caseId: string; page?: { limit?: number; cursor?: string } }): Promise<JournalView> {
    const creditor = currentCreditor();
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    const page = await this.deps.caseQueries.journal(
      record.id,
      { includeInternal: false },
      requirePage(input.page),
    );
    return journalView(this.deps, page.items, page.nextCursor);
  }
}

/** Taux de recouvrement en points de base : recouvré / confié. */
export function recoveryRateBps(recovered: number, entrusted: number): number {
  return entrusted > 0 ? Math.min(10_000, Math.floor((recovered * 10_000) / entrusted)) : 0;
}

/** Tableau de bord du créancier (GetMyDashboard, 14.1). */
export class GetMyDashboardUseCase {
  constructor(private readonly deps: CaseDeps) {}

  async execute(): Promise<CreditorDashboardFigures & { recoveryRateBps: number }> {
    const creditor: Creditor = currentCreditor();
    const figures = await this.deps.caseQueries.creditorDashboard(
      creditor.holder,
      localDay(this.deps.clock.now()),
    );
    return { ...figures, recoveryRateBps: recoveryRateBps(figures.recovered, figures.entrusted) };
  }
}
