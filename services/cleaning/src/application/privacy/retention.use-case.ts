import { idempotencyCutoff, retentionCutoff } from '../../domain/privacy/retention';
import { type PrivacyDeps } from '../deps';
import { type ExpiredPhotos } from './privacy.ports';

/** Lot de la purge (règle commune des tâches automatiques, partie 14 : 200 au plus). */
export const PURGE_BATCH = 200;
/** Lots d'une même étape par passage : le reste attend le passage suivant. */
export const PURGE_MAX_BATCHES = 25;

export interface PurgeReport {
  /** false : une autre réplique tient le verrou, rien n'a été fait. */
  ran: boolean;
  /** Copies de position de demandes effacées. */
  requestLocations: number;
  /** Positions d'arrivée effacées, sur des visites et sur des séances. */
  visitArrivals: number;
  sessionArrivals: number;
  /** Lieux archivés dont la position a été effacée. */
  placeLocations: number;
  /** Photos de visites et de séances supprimées chez file, références retirées. */
  photos: number;
  /** Clés d'idempotence supprimées. */
  idempotencyRecords: number;
  /** Lots ou cibles en échec, repris au passage suivant. */
  failed: number;
}

export type PurgeStep =
  | 'request_locations'
  | 'session_arrivals'
  | 'place_locations'
  | 'visit_photos'
  | 'session_photos'
  | 'idempotency_records';

/**
 * Tâche planifiée de conservation (UC-NT-48, R-DP-01, RV-41), protégée par un verrou consultatif
 * contre deux répliques. Avec N = `retentionMonths` (réglage du back-office), sont effacées :
 * - la copie de la position d'une demande close, N mois après sa clôture, avec les positions
 *   d'arrivée de ses visites ; pour une demande acceptée, la clôture du dossier est la fin ou
 *   l'annulation de son dernier programme ;
 * - les positions d'arrivée des séances d'un programme, N mois après sa fin ou son annulation ;
 * - la position d'un lieu archivé, N mois après son archivage ;
 * - les photos des visites et des séances (R-EX-07), à la même échéance que leurs positions
 *   d'arrivée : supprimées chez file, puis leurs références retirées (R-EX-10).
 * Rien n'est effacé tant qu'une demande ouverte, un programme non terminé ou une séance à venir s'en
 * sert ; un lieu non archivé est gardé. Le départ est la clôture, la fin, l'annulation ou
 * l'archivage, jamais la dernière modification. Les clés d'idempotence de plus de 7 jours sont
 * supprimées au même passage (R-EX-05, RV-04).
 * Règle commune (partie 14) : lots de 200 au plus, chaque écriture conditionnée dans sa transaction ;
 * une étape ou une cible en échec est comptée et signalée sans arrêter les suivantes, et reprise au
 * passage suivant. Rien n'est publié ni journalisé sur les personnes : des nombres seulement.
 */
export class PurgeExpiredDataUseCase {
  constructor(
    private readonly deps: PrivacyDeps,
    private readonly onError: (step: PurgeStep, error: unknown) => void = () => undefined,
  ) {}

  async execute(): Promise<PurgeReport> {
    const report: PurgeReport = {
      ran: false,
      requestLocations: 0,
      visitArrivals: 0,
      sessionArrivals: 0,
      placeLocations: 0,
      photos: 0,
      idempotencyRecords: 0,
      failed: 0,
    };
    const { personalData } = this.deps;
    report.ran = await personalData.withPurgeLock(async () => {
      const now = this.deps.clock.now();
      const { settings } = await this.deps.moduleSettings.read();
      const cutoff = retentionCutoff(now, settings.retentionMonths);
      await this.lots('request_locations', report, async () => {
        const lot = await personalData.purgeRequestLocations(cutoff, now, PURGE_BATCH);
        report.requestLocations += lot.requests;
        report.visitArrivals += lot.visitArrivals;
        return lot.taken;
      });
      await this.lots('session_arrivals', report, async () => {
        const lot = await personalData.purgeSessionArrivals(cutoff, PURGE_BATCH);
        report.sessionArrivals += lot.sessionArrivals;
        return lot.taken;
      });
      await this.lots('place_locations', report, async () => {
        const erased = await personalData.purgePlaceLocations(cutoff, now, PURGE_BATCH);
        report.placeLocations += erased;
        return erased;
      });
      await this.lots('visit_photos', report, async () =>
        this.photos('visit_photos', report, now, await personalData.expiredVisitPhotos(cutoff, PURGE_BATCH)),
      );
      await this.lots('session_photos', report, async () =>
        this.photos(
          'session_photos',
          report,
          now,
          await personalData.expiredSessionPhotos(cutoff, PURGE_BATCH),
        ),
      );
      await this.lots('idempotency_records', report, async () => {
        const deleted = await personalData.purgeIdempotencyRecords(idempotencyCutoff(now), PURGE_BATCH);
        report.idempotencyRecords += deleted;
        return deleted;
      });
    });
    return report;
  }

  /**
   * Enchaîne les lots d'une étape tant qu'ils sont pleins. Un lot en échec (conflit, panne) est
   * compté et signalé : l'étape s'arrête là et reprend au passage suivant, les autres étapes passent.
   */
  private async lots(step: PurgeStep, report: PurgeReport, lot: () => Promise<number>): Promise<void> {
    for (let round = 0; round < PURGE_MAX_BATCHES; round += 1) {
      let taken: number;
      try {
        taken = await lot();
      } catch (error) {
        report.failed += 1;
        this.onError(step, error);
        return;
      }
      if (taken < PURGE_BATCH) return;
    }
  }

  /**
   * Photos d'un lot de visites ou de séances : supprimées chez file d'abord (suppression rejouable),
   * puis leurs références retirées. Une cible en échec, ou qui a changé entre-temps, garde ses
   * références et reviendra au passage suivant : le lot compte alors comme incomplet, pour qu'elle
   * ne soit pas relue sans fin dans le même passage.
   */
  private async photos(
    step: PurgeStep,
    report: PurgeReport,
    now: Date,
    lot: readonly ExpiredPhotos[],
  ): Promise<number> {
    let left = false;
    for (const photos of lot) {
      try {
        for (const fileId of photos.fileIds) await this.deps.photos.remove(fileId, photos.subject);
        if (await this.deps.personalData.erasePhotoReferences(photos, now)) {
          report.photos += photos.fileIds.length;
        } else {
          left = true;
        }
      } catch (error) {
        left = true;
        report.failed += 1;
        this.onError(step, error);
      }
    }
    return left ? 0 : lot.length;
  }
}
