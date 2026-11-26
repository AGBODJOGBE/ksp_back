import { addDaysToInstant, localDay } from '../../domain/calendar';
import { type ClosureReason, isUnrecoverableForLackOfContact } from '../../domain/case';
import { prescriptionState } from '../../domain/deadlines';
import {
  MANUAL_CLOSURE_REASONS,
  type ManualClosureReason,
  manualClosure,
  provisionRemainder,
} from '../../domain/litigation';
import { FIXED_RULES } from '../../domain/settings';
import { longDay } from '../amicable/debtor-messages';
import { CASE_SUPERVISORS, creditorWriter, requireCaseInScope, requireOwnCase } from '../cases/case-access';
import { CaseErrors } from '../cases/case-errors';
import { UUID } from '../cases/case-input';
import { agentActor, creditorActor, evidenceEntry, stableId, SYSTEM } from '../cases/case-rules';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import { type EvidenceEntryData, noChanges, type RecoveryCaseRecord } from '../cases/ports';
import { CaseClosure, type ClosureCause } from '../money/case-closure.service';
import { type MoneyCaseView, moneyCaseView } from '../money/money-views';
import { loadSettings } from '../settings.use-cases';
import { BACKOFFICE_MFA_SECONDS, requireStaff } from '../shared/access';
import { formatXof, RecoveryErrors, unwrap } from '../shared/errors';
import { type LitigationDeps, noLitigationWrites } from './litigation.ports';
import { commitLitigation, oneLine } from './litigation-rules';

/**
 * Fin d'un dossier (R-PR-06, R-PR-10, UC-RC-08 et 23), toujours par le service de clôture du lot R3
 * (`CaseClosure`) : état et trace enregistrés, puis attestation de solde s'il y a lieu, liens de
 * paiement et liens personnels du débiteur révoqués, `recovery.case.closed`. Le contentieux y ajoute :
 * la mission du partenaire terminée, le reste des provisions à rendre au créancier par la finance
 * (ADR-060, point 10). Les frais de dossier restent acquis ; la commission déjà retenue sur les
 * encaissements reste due, et un paiement direct reçu dans les 30 jours qui suivent l'arrêt reste
 * commissionné (R-PR-06, déclaration du créancier).
 */

const OTHER_PATHS: Record<Exclude<ClosureReason, ManualClosureReason>, string> = {
  paid: 'Un dossier soldé se clôt seul à l’encaissement.',
  settlement_executed: 'Un accord transactionnel exécuté clôt le dossier à son paiement.',
  dispute_upheld: 'Une contestation fondée se tranche par la décision du juriste sur la contestation.',
};

/**
 * Suite de la clôture propre au contentieux : missions des partenaires terminées et reste des
 * provisions signalé (une fois). Sans effet sur un dossier qui n'est pas clos ; la tâche du contentieux
 * la reprend pour les dossiers clos ailleurs (encaissement qui solde, décision échue).
 */
export async function settleLitigation(
  deps: LitigationDeps,
  caseId: string,
  extra: EvidenceEntryData[] = [],
): Promise<void> {
  const record = await deps.cases.find(caseId);
  if (!record || (record.status !== 'closed' && record.status !== 'rejected')) return;
  const now = deps.clock.now();
  const litigation = noLitigationWrites();
  for (const assignment of await deps.litigation.caseAssignments(caseId)) {
    if (assignment.status === 'active') {
      litigation.assignments.push({
        row: { ...assignment, status: 'completed', completedAt: now },
        expected: 'active',
      });
    }
  }
  const changes = noChanges();
  changes.evidence.push(...extra);
  const remainder = provisionRemainder(
    (await deps.litigation.provisions(caseId)).filter((provision) => provision.status === 'paid'),
  );
  if (remainder > 0 && !(await deps.amicable.hasEvidence(caseId, 'provision.remainder', new Date(0)))) {
    changes.evidence.push(
      evidenceEntry(deps.ids, record, now, SYSTEM, {
        action: 'provision.remainder',
        kind: 'payment',
        summary: `Reste des provisions non consommé : ${formatXof(remainder)}, rendu au créancier par la finance`,
        amount: remainder,
      }),
    );
  }
  if (litigation.assignments.length === 0 && changes.evidence.length === 0) return;
  await deps.litigation.commit({ touch: { caseId, at: now }, changes, litigation });
}

/**
 * Arrêt du dossier par le créancier (StopCase, R-PR-06), à tout moment tant qu'il est en cours : clos
 * « abandon par le créancier ». Rejoué sur un dossier déjà arrêté, il rend le dossier.
 */
export class StopCaseUseCase {
  private readonly closure: CaseClosure;

  constructor(private readonly deps: LitigationDeps) {
    this.closure = new CaseClosure(deps);
  }

  async execute(input: { caseId: string; reason: string }): Promise<MoneyCaseView> {
    const creditor = creditorWriter();
    const now = this.deps.clock.now();
    const record = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor);
    const reason = oneLine(input.reason ?? '', 1000);
    if (reason.length < 3 || reason.length > 500) {
      throw RecoveryErrors.invalid('reason', 'Motif de 3 à 500 caractères.');
    }
    if (record.status === 'closed' && record.closureReason === 'abandoned_by_creditor') {
      return moneyCaseView(this.deps, record, now);
    }
    if (record.status !== 'active' && record.status !== 'suspended') {
      throw CaseErrors.invalidTransition(
        record.status,
        'Seul un dossier en cours de recouvrement peut être arrêté.',
        record.stage,
      );
    }
    const actor = creditorActor(creditor.userId);
    const closed = await this.closure.close(record.id, {
      reason: 'abandoned_by_creditor',
      actor,
      note: reason,
      staff: null,
    });
    const until = longDay(localDay(addDaysToInstant(now, FIXED_RULES.directPaymentCommissionDays)));
    await settleLitigation(this.deps, record.id, [
      evidenceEntry(this.deps.ids, record, now, actor, {
        action: 'case.stopped',
        kind: 'status_changed',
        summary:
          `Dossier arrêté par le créancier : ${reason}. Commission due sur les sommes encaissées et sur ` +
          `tout paiement reçu directement jusqu’au ${until}, à déclarer`,
      }),
    ]);
    return moneyCaseView(this.deps, (await this.deps.cases.find(record.id)) ?? closed, now);
  }
}

/**
 * Clôture décidée au back-office (CloseCase, R-PR-10) : abandon par le créancier (sur sa demande ou
 * après son refus d'une étape payante), irrecouvrable (constat d'insolvabilité ou de disparition joint
 * ou enregistré par l'huissier, ou N mois sans contact possible), prescrit (date atteinte). Les autres
 * motifs suivent leur propre chemin. Rejouée sur un dossier déjà clos pour ce motif, elle le rend.
 */
export class CloseCaseUseCase {
  private readonly closure: CaseClosure;

  constructor(private readonly deps: LitigationDeps) {
    this.closure = new CaseClosure(deps);
  }

  async execute(input: {
    caseId: string;
    reason: string;
    note: string;
    proofFileId: string;
  }): Promise<MoneyCaseView> {
    const now = this.deps.clock.now();
    const staff = requireStaff(CASE_SUPERVISORS, BACKOFFICE_MFA_SECONDS, now.getTime());
    const record = requireCaseInScope(await this.deps.cases.find(requireCaseId(input.caseId)), staff);
    const reason = input.reason as ManualClosureReason;
    if (!MANUAL_CLOSURE_REASONS.includes(reason)) {
      const other = OTHER_PATHS[input.reason as keyof typeof OTHER_PATHS];
      throw RecoveryErrors.invalid(
        'reason',
        other ?? `Valeur attendue : ${MANUAL_CLOSURE_REASONS.join(', ')}.`,
      );
    }
    const note = oneLine(input.note ?? '', 4000) || null;
    if (note && note.length > 2000) throw RecoveryErrors.invalid('note', '2 000 caractères au plus.');
    if (input.proofFileId && !UUID.test(input.proofFileId)) {
      throw RecoveryErrors.invalid('proofFileId', 'Identifiant de fichier invalide.');
    }
    const proofFileId = input.proofFileId ? input.proofFileId.toLowerCase() : null;
    if (record.status === 'closed' && record.closureReason === reason) {
      return moneyCaseView(this.deps, record, now);
    }
    if (record.status !== 'active' && record.status !== 'suspended') {
      throw CaseErrors.invalidTransition(record.status, 'Ce dossier n’est plus en cours.', record.stage);
    }
    const { settings } = await loadSettings(this.deps.settings);
    const lastContact =
      (await this.deps.litigation.lastReachedContactAt(record.id)) ?? record.acceptedAt ?? record.createdAt;
    const acts = reason === 'unrecoverable' ? await this.deps.litigation.caseActs(record.id) : [];
    unwrap(
      manualClosure(reason, {
        prescribed:
          record.prescriptionDate !== null &&
          prescriptionState(record.prescriptionDate, localDay(now), settings.prescriptionAlertDays) ===
            'prescribed',
        insolvencyEstablished: proofFileId !== null || acts.some((act) => act.type === 'insolvency_report'),
        noContactForLong: isUnrecoverableForLackOfContact(
          lastContact,
          now,
          settings.unrecoverableAfterMonths,
        ),
      }),
    );
    const actor = agentActor(staff.userId);
    if (proofFileId && !record.documents.some((document) => document.fileId === proofFileId)) {
      await this.deps.files.attach({
        fileId: proofFileId,
        subject: caseSubject(record.id),
        ownerId: staff.userId,
      });
      const next: RecoveryCaseRecord = {
        ...record,
        documents: [
          ...record.documents,
          {
            id: stableId('recovery-closure-proof', record.id, proofFileId),
            kind: 'evidence',
            label: 'Constat d’insolvabilité ou de disparition',
            fileId: proofFileId,
            documentId: null,
            visibleToPartner: false,
            visibleToDebtor: false,
            addedBy: actor,
            addedAt: now,
          },
        ],
      };
      const changes = noChanges();
      changes.evidence.push(
        evidenceEntry(this.deps.ids, next, now, actor, {
          action: 'document.added',
          kind: 'document',
          summary: 'Constat d’insolvabilité ou de disparition joint au dossier',
          ref: { type: 'file', id: proofFileId },
        }),
      );
      await commitLitigation(this.deps, { record: next, changes, litigation: noLitigationWrites() });
    }
    const cause: ClosureCause = { reason, actor, note, staff };
    const closed = await this.closure.close(record.id, cause);
    await settleLitigation(this.deps, record.id);
    return moneyCaseView(this.deps, (await this.deps.cases.find(record.id)) ?? closed, now);
  }
}
