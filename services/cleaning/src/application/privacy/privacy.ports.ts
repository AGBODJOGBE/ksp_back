import {
  type AssignmentFact,
  type DirectPaymentFact,
  type MoneySubject,
  type ProgramFact,
  type UnpaidSessionFact,
} from '../../domain/privacy/obligations';
import { type FileSubject } from '../ports';
import { type Owner } from '../requests/requests.ports';

/**
 * Données personnelles tenues par cleaning (partie 16.3) : ce qui bloque la suppression d'un compte,
 * ce qui est effacé à sa suppression (R-DP-02) et après la durée de conservation (R-DP-01). Le dépôt
 * ne déchiffre rien : il lit des numéros et des dates, et met les colonnes chiffrées à null.
 */

/** Ce que la base sait des obligations d'un titulaire, hors demandes (lues par le dépôt du dossier). */
export interface StoredObligations {
  /** Programmes non terminés, ou terminés avec une séance encore à venir. */
  programs: ProgramFact[];
  /** Séances « à payer » ou « en retard ». */
  unpaidSessions: UnpaidSessionFact[];
  /** Opérations du wallet du titulaire encore « en cours ». */
  walletOperations: MoneySubject[];
  /** Paiements directs du titulaire pas encore aboutis. */
  directPayments: DirectPaymentFact[];
  /** Factures mensuelles impayées de l'organisation ; 0 pour un compte personnel. */
  overdueInvoices: number;
  /** Affectations en vigueur du compte, s'il est agent, dont la fin est après maintenant. */
  assignments: AssignmentFact[];
}

/** Événement reçu, marqué « traité » dans la transaction de son effet (inbox). */
export interface ProcessedEventRef {
  eventId: string;
  /** Nom du consommateur dans l'inbox (processed_events). */
  consumer: string;
}

/** Ce qu'un compte supprimé a perdu chez cleaning : des nombres, jamais d'identifiant. */
export interface AccountErasure {
  /** `duplicate` : événement déjà traité, rien n'a été écrit. */
  status: 'processed' | 'duplicate';
  /** Lieux personnels dont la position, le repère et les adresses ont été effacés. */
  places: number;
  /** Demandes dont la copie de la position a été effacée. */
  requests: number;
  /** Positions d'arrivée de l'agent effacées, sur ses visites et sur ses séances. */
  visitArrivals: number;
  sessionArrivals: number;
  /** Fiche d'agent vidée de sa pièce d'identité, de sa personne à prévenir et de son Mobile Money. */
  agentProfiles: number;
}

/** Un lot de la purge : lignes prises (pour savoir s'il en reste) et ce qui a été effacé. */
export interface RequestPurgeLot {
  /** Dossiers pris par le lot. */
  taken: number;
  /** Copies de position effacées. */
  requests: number;
  /** Positions d'arrivée de leurs visites effacées. */
  visitArrivals: number;
}

export interface SessionPurgeLot {
  /** Programmes pris par le lot. */
  taken: number;
  /** Positions d'arrivée de leurs séances effacées. */
  sessionArrivals: number;
}

/** Photos d'une visite ou d'une séance dont la durée de conservation est écoulée (R-EX-07). */
export interface ExpiredPhotos {
  /** Objet auquel les fichiers sont rattachés chez file. */
  subject: FileSubject & { type: 'cleaning_visit' | 'cleaning_session' };
  /** Toutes les photos que la cible porte encore, sans doublon. */
  fileIds: string[];
}

export interface PersonalDataRepository {
  /**
   * Lecture seule. `agentUserId` : compte dont les affectations d'agent sont lues (contexte
   * personnel) ; null pour une organisation.
   */
  storedObligations(holder: Owner, agentUserId: string | null, now: Date): Promise<StoredObligations>;
  /**
   * R-DP-02 : efface, en une transaction avec la marque « événement traité », les données
   * personnelles du compte supprimé. Seules les lignes qui portent encore une donnée sont écrites
   * (version + 1) : rejoué, l'effacement ne change rien.
   */
  eraseAccount(userId: string, event: ProcessedEventRef, now: Date): Promise<AccountErasure>;

  // --- Purge par durée de conservation (R-DP-01, UC-NT-48) : `cutoff` = maintenant − N mois. -----
  /**
   * Verrou consultatif de la purge (deux répliques) : `work` ne s'exécute que si le verrou est pris ;
   * rend false sinon.
   */
  withPurgeLock(work: () => Promise<void>): Promise<boolean>;
  /**
   * Dossiers clos avant `cutoff` (demande close ; ou demande acceptée dont tous les programmes sont
   * finis avant `cutoff`) : copie de la position et positions d'arrivée de leurs visites. Rien tant
   * qu'un programme non terminé, une séance à venir ou une réactivation en attente s'en sert.
   */
  purgeRequestLocations(cutoff: Date, now: Date, limit: number): Promise<RequestPurgeLot>;
  /** Programmes finis ou annulés avant `cutoff`, sans séance à venir : positions d'arrivée de leurs séances. */
  purgeSessionArrivals(cutoff: Date, limit: number): Promise<SessionPurgeLot>;
  /**
   * Lieux archivés avant `cutoff` : position, repère et adresses. Rien tant qu'une demande ouverte,
   * un programme non terminé ou une séance à venir utilise le lieu ; un lieu non archivé est gardé.
   * Rend le nombre de lieux effacés.
   */
  purgePlaceLocations(cutoff: Date, now: Date, limit: number): Promise<number>;
  /**
   * Visites de dossiers clos avant `cutoff` qui portent encore des photos (photos de la visite, photo
   * du lieu d'une absence).
   */
  expiredVisitPhotos(cutoff: Date, limit: number): Promise<ExpiredPhotos[]>;
  /**
   * Séances de programmes finis avant `cutoff` qui portent encore des photos (avant, après, absence,
   * incidents) ; jamais une séance visée par une réclamation ouverte (R-EX-10). La signature et les
   * photos d'une réclamation sont conservées.
   */
  expiredSessionPhotos(cutoff: Date, limit: number): Promise<ExpiredPhotos[]>;
  /**
   * Retire les références des photos déjà supprimées chez file et date l'effacement. Rend false,
   * sans rien écrire, si la cible porte entre-temps une autre photo : elle sera reprise.
   */
  erasePhotoReferences(photos: ExpiredPhotos, now: Date): Promise<boolean>;
  /** Clés d'idempotence créées avant `before` (7 jours) ; rend le nombre de clés supprimées. */
  purgeIdempotencyRecords(before: Date, limit: number): Promise<number>;
}
