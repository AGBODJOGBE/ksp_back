import { type ContactWindow, contactWindowProblems } from './contact-policy';

/**
 * Réglages du Recouvrement, modifiables au back-office (cahier des charges, partie 17.1). Noms et bornes
 * du contrat `RecoverySettings` (recovery.proto, OpenAPI). Les barèmes d'échéancier par défaut et les
 * poids du score, qui font aussi partie des réglages du contrat, sont décrits dans `payment-plan` et
 * `score`. Les réglages de la gestion locative appartiennent au service rental.
 */
export interface RecoverySettings {
  /** Montant minimum d'un dossier, en FCFA (R-SD-05) : 25 000. */
  minimumCaseAmount: number;
  /** Jours pour payer les frais de dossier ; au-delà, le brouillon est supprimé (R-SD-04) : 7. */
  feePaymentDays: number;
  /** Jours ouvrés d'examen de recevabilité (4.4) : 2. */
  reviewBusinessDays: number;
  /** Jours laissés au créancier pour compléter son dossier (4.4) : 15. */
  infoCompletionDays: number;
  /** Jours laissés au débiteur pour répondre à la notification du mandat (étape 1) : 8. */
  noticeResponseDays: number;
  /** Jours de grâce après chaque échéance (étape 2) : 5. */
  installmentGraceDays: number;
  /** Échéances manquées qui font passer en relance amiable (étape 2) : 2. */
  missedInstallmentsBeforeAmicable: number;
  /** Durée de la relance amiable (étape 3) : 21 jours. */
  amicableDurationDays: number;
  /** Jours après la réception de la mise en demeure (étape 4) : 15. */
  formalNoticeDays: number;
  /** Jours laissés au créancier pour accepter une étape payante (R-PR-04) : 15. */
  creditorApprovalDays: number;
  /** Jours laissés au créancier pour répondre à une contestation (R-PR-02) : 10. */
  disputeAnswerDays: number;
  /** Jours d'alerte avant la prescription (partie 2) : 90. */
  prescriptionAlertDays: number;
  /** Plage de contact du débiteur (partie 2, décision 6) : 08:00 – 19:00, du lundi au samedi. */
  contactWindow: ContactWindow;
  /** Validité du lien du débiteur (partie 7) : 30 jours. */
  debtorLinkDays: number;
  /** Jours ouvrés au plus pour reverser au créancier (R-CO-03) : 5. */
  remittanceBusinessDays: number;
  /** Années de conservation d'un dossier clos (17.1, décision 14) : 5. */
  closedCaseRetentionYears: number;
  /** Jours laissés au créancier pour un échéancier hors barème, refusé ensuite (R-EC-01) : 3. */
  planCreditorApprovalDays: number;
  /** Jours sans mise à jour d'un partenaire avant l'alerte du juriste (R-HU-04) : 15. */
  partnerSilenceAlertDays: number;
  /** Durée d'une session du débiteur après son code (ADR-061) : 30 minutes. */
  debtorSessionMinutes: number;
  /** Mois sans contact possible avant de classer « irrecouvrable » (R-PR-10) : 6. */
  unrecoverableAfterMonths: number;
}

export type NumericSetting = Exclude<keyof RecoverySettings, 'contactWindow'>;

export const DEFAULT_SETTINGS: RecoverySettings = {
  minimumCaseAmount: 25_000,
  feePaymentDays: 7,
  reviewBusinessDays: 2,
  infoCompletionDays: 15,
  noticeResponseDays: 8,
  installmentGraceDays: 5,
  missedInstallmentsBeforeAmicable: 2,
  amicableDurationDays: 21,
  formalNoticeDays: 15,
  creditorApprovalDays: 15,
  disputeAnswerDays: 10,
  prescriptionAlertDays: 90,
  contactWindow: { start: '08:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
  debtorLinkDays: 30,
  remittanceBusinessDays: 5,
  closedCaseRetentionYears: 5,
  planCreditorApprovalDays: 3,
  partnerSilenceAlertDays: 15,
  debtorSessionMinutes: 30,
  unrecoverableAfterMonths: 6,
};

/** Bornes du contrat (partie 17.1 pour ceux qu'elle cite). */
export const SETTING_BOUNDS: Record<NumericSetting, readonly [number, number]> = {
  minimumCaseAmount: [0, 10_000_000],
  feePaymentDays: [1, 30],
  reviewBusinessDays: [1, 10],
  infoCompletionDays: [3, 60],
  noticeResponseDays: [3, 30],
  installmentGraceDays: [0, 15],
  missedInstallmentsBeforeAmicable: [1, 5],
  amicableDurationDays: [7, 90],
  formalNoticeDays: [8, 60],
  creditorApprovalDays: [3, 60],
  disputeAnswerDays: [3, 30],
  prescriptionAlertDays: [30, 365],
  debtorLinkDays: [7, 90],
  remittanceBusinessDays: [1, 30],
  closedCaseRetentionYears: [1, 10],
  planCreditorApprovalDays: [1, 15],
  partnerSilenceAlertDays: [3, 60],
  debtorSessionMinutes: [5, 120],
  unrecoverableAfterMonths: [1, 24],
};

/**
 * Valeurs fixées par le cahier des charges ou les ADR, absentes des réglages du contrat : passées en
 * paramètre aux règles comme les réglages, elles deviendraient réglables par un ajout au contrat.
 */
export const FIXED_RULES = {
  /** Rappel avant chaque échéance, en jours (R-EC-03). */
  installmentReminderDaysBefore: 3,
  /** Jours ouvrés laissés au partenaire pour virer à KSP ce qu'il a encaissé (R-HU-05). */
  partnerTransferBusinessDays: 5,
  /** Jours après l'arrêt pendant lesquels un paiement direct reste commissionné (R-PR-06, décision 4). */
  directPaymentCommissionDays: 30,
  /** Codes faux du débiteur avant blocage (ADR-061). */
  debtorCodeMaxAttempts: 5,
  /** Durée du blocage du débiteur, en minutes (ADR-061). */
  debtorLockMinutes: 60,
  /** Seuil de « prescription proche » qui permet un saut d'étape, en jours (R-PR-03). */
  prescriptionNearDays: 90,
} as const;

/** Applique une modification partielle aux réglages courants. */
export function mergeSettings(current: RecoverySettings, patch: Partial<RecoverySettings>): RecoverySettings {
  const merged: RecoverySettings = { ...current };
  for (const key of Object.keys(patch) as (keyof RecoverySettings)[]) {
    const value = patch[key];
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

/** Problèmes de réglages (`RECOVERY_SETTING_OUT_OF_BOUNDS`) : entier hors bornes, plage de contact. Vide = valide. */
export function settingsProblems(settings: RecoverySettings): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(SETTING_BOUNDS) as NumericSetting[]) {
    const [min, max] = SETTING_BOUNDS[key];
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${key} doit être un entier de ${min} à ${max}`);
    }
  }
  return [...problems, ...contactWindowProblems(settings.contactWindow).map((p) => `contactWindow : ${p}`)];
}
