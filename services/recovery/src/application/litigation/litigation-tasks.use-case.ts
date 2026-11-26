import { localDay } from '../../domain/calendar';
import { isPartnerSilent } from '../../domain/partner';
import { longDay } from '../amicable/debtor-messages';
import { evidenceEntry, SYSTEM } from '../cases/case-rules';
import { noChanges } from '../cases/ports';
import { type FullSettings } from '../ports';
import { loadSettings } from '../settings.use-cases';
import { settleLitigation } from './closures.use-cases';
import {
  type AssignmentRecord,
  type LitigationDeps,
  noLitigationWrites,
  type NoticeRecord,
} from './litigation.ports';
import { oneLine, PARTNER_KIND_LABELS } from './litigation-rules';

/**
 * Tâche planifiée du contentieux (UC-RC-26 et 29, ADR-060 point 17), à côté de celle de la procédure
 * amiable qui fait expirer les décisions (devis sans accord : dossier clos « abandon par le
 * créancier ») :
 * - mise en demeure restée sans effet au terme de son délai : passage à l'huissier proposé, le juriste
 *   soumettant son devis au créancier (R-PR-04) ;
 * - partenaire sans nouvelles depuis 15 jours (réglable) : alerte du juriste (R-HU-04) ;
 * - dossier clos ailleurs (encaissement qui solde, décision échue) : mission du partenaire terminée et
 *   reste des provisions signalé.
 * Écritures conditionnées : plusieurs instances peuvent tourner ; chaque alerte n'est écrite qu'une
 * fois. Seuls des compteurs sortent de la tâche.
 */

const BATCH = 100;

export interface LitigationReport {
  escalationsProposed: number;
  partnersSilent: number;
  missionsCompleted: number;
  failed: number;
}

export class WatchLitigationUseCase {
  constructor(private readonly deps: LitigationDeps) {}

  async execute(): Promise<LitigationReport> {
    const now = this.deps.clock.now();
    const { settings } = await loadSettings(this.deps.settings);
    const report: LitigationReport = {
      escalationsProposed: 0,
      partnersSilent: 0,
      missionsCompleted: 0,
      failed: 0,
    };
    await this.eachPage(
      (after) => this.deps.litigation.expiredNotices(now, after, BATCH),
      (notice) => notice.caseId,
      async (notice) => {
        if (await this.proposeBailiff(notice, now)) report.escalationsProposed += 1;
      },
      report,
    );
    const silentBefore = new Date(now.getTime() - settings.partnerSilenceAlertDays * 86_400_000);
    await this.eachPage(
      (after) => this.deps.litigation.silentAssignments(silentBefore, after, BATCH),
      (assignment) => assignment.id,
      async (assignment) => {
        if (await this.alertSilence(assignment, now, settings)) report.partnersSilent += 1;
      },
      report,
    );
    const closedCases = new Set(
      (await this.deps.litigation.assignmentsOfClosedCases(BATCH)).map((assignment) => assignment.caseId),
    );
    for (const caseId of closedCases) {
      try {
        await settleLitigation(this.deps, caseId);
        report.missionsCompleted += 1;
      } catch {
        report.failed += 1;
      }
    }
    return report;
  }

  private async eachPage<T>(
    load: (afterId: string | null) => Promise<T[]>,
    idOf: (item: T) => string,
    handle: (item: T) => Promise<void>,
    report: LitigationReport,
  ): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const items = await load(after);
      for (const item of items) {
        try {
          await handle(item);
        } catch {
          report.failed += 1;
        }
      }
      if (items.length < BATCH) return;
      after = idOf(items[items.length - 1]!);
    }
  }

  /** Mise en demeure sans effet : passage à l'huissier proposé, une fois par remise. */
  private async proposeBailiff(notice: NoticeRecord, now: Date): Promise<boolean> {
    const record = await this.deps.cases.find(notice.caseId);
    if (!record || record.status !== 'active' || record.stage !== 'formal_notice' || !notice.deliveredAt) {
      return false;
    }
    if (
      (await this.deps.amicable.pendingDecision(record.id, 'bailiff_escalation')) ||
      (await this.deps.amicable.hasEvidence(record.id, 'stage.bailiff_proposed', notice.deliveredAt))
    ) {
      return false;
    }
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, SYSTEM, {
        action: 'stage.bailiff_proposed',
        kind: 'system',
        summary:
          `Mise en demeure ${notice.documentNumber} restée sans effet au terme de son délai : passage à ` +
          'l’huissier à proposer au créancier, avec le devis du juriste',
      }),
    );
    const outcome = await this.deps.litigation.commit({
      touch: { caseId: record.id, at: now },
      changes,
      litigation: noLitigationWrites(),
    });
    return outcome === 'saved';
  }

  /** Partenaire sans nouvelles : alerte du juriste au journal (interne), une fois par silence. */
  private async alertSilence(
    assignment: AssignmentRecord,
    now: Date,
    settings: FullSettings,
  ): Promise<boolean> {
    if (!isPartnerSilent(assignment.lastUpdateAt, now, settings.partnerSilenceAlertDays)) return false;
    if (await this.deps.amicable.hasEvidence(assignment.caseId, 'partner.silent', assignment.lastUpdateAt)) {
      return false;
    }
    const record = await this.deps.cases.find(assignment.caseId);
    if (!record || (record.status !== 'active' && record.status !== 'suspended')) return false;
    const partner = await this.deps.litigation.partner(assignment.partnerId);
    const who = partner
      ? `de ${PARTNER_KIND_LABELS[partner.kind]} ${oneLine(partner.name, 200)}`
      : 'du partenaire';
    const changes = noChanges();
    changes.evidence.push(
      evidenceEntry(this.deps.ids, record, now, SYSTEM, {
        action: 'partner.silent',
        kind: 'system',
        summary:
          `Aucune nouvelle ${who} depuis le ${longDay(localDay(assignment.lastUpdateAt))} : point à faire ` +
          'par le juriste',
        internal: true,
      }),
    );
    const outcome = await this.deps.litigation.commit({
      touch: { caseId: record.id, at: now },
      changes,
      litigation: noLitigationWrites(),
    });
    return outcome === 'saved';
  }
}
