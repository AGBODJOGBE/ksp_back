/**
 * Score de recouvrabilité de 0 à 100 (R-SD-07), calculé à la recevabilité. Il sert à prioriser le
 * travail et à informer le créancier, jamais à refuser un dossier automatiquement. Critères et poids
 * se règlent au back-office (`ScoreWeights` du contrat, somme ramenée à 100) ; chaque critère donne une
 * note de 0 à 100, pondérée.
 */
export type EvidenceQuality = 'strong' | 'medium' | 'weak';

export interface ScoreInput {
  /** Jours depuis la date d'exigibilité. */
  debtAgeDays: number;
  /** Reconnaissance écrite de la dette par le débiteur. */
  writtenAcknowledgment: boolean;
  evidenceQuality: EvidenceQuality;
  /** Montant dû, en FCFA. */
  amountDue: number;
  /** Moyens de contact valides (téléphones, e-mails, adresses). */
  validContactCount: number;
  /** Paiements partiels déjà faits par le débiteur. */
  partialPaymentsMade: boolean;
}

/** Palier : jusqu'à `upTo` inclus (null = au-delà), note de 0 à 100. */
export interface ScoreStep {
  upTo: number | null;
  points: number;
}

export interface ScoreWeights {
  debtAge: number;
  writtenAcknowledgment: number;
  evidenceQuality: number;
  amount: number;
  validContacts: number;
  partialPayments: number;
}

export interface ScoreSettings {
  /** Poids des critères, de 0 à 100 chacun ; leur somme est ramenée à 100. */
  weights: ScoreWeights;
  debtAgeSteps: ScoreStep[];
  amountSteps: ScoreStep[];
  evidencePoints: Record<EvidenceQuality, number>;
  /** Moyens de contact valides pour la note maximale. */
  contactsForFullPoints: number;
}

export const DEFAULT_SCORE_SETTINGS: ScoreSettings = {
  weights: {
    debtAge: 25,
    writtenAcknowledgment: 20,
    evidenceQuality: 20,
    amount: 10,
    validContacts: 15,
    partialPayments: 10,
  },
  debtAgeSteps: [
    { upTo: 90, points: 100 },
    { upTo: 365, points: 60 },
    { upTo: 730, points: 30 },
    { upTo: null, points: 0 },
  ],
  amountSteps: [
    { upTo: 500_000, points: 100 },
    { upTo: 5_000_000, points: 70 },
    { upTo: null, points: 40 },
  ],
  evidencePoints: { strong: 100, medium: 60, weak: 20 },
  contactsForFullPoints: 2,
};

function stepPoints(steps: readonly ScoreStep[], value: number): number {
  return (
    (steps.find((step) => step.upTo === null || value <= step.upTo) ?? steps[steps.length - 1])?.points ?? 0
  );
}

export type ScoreBreakdown = Record<keyof ScoreWeights, number>;

export interface Score {
  value: number;
  /** Note de chaque critère (0 à 100), avant pondération, montrée au superviseur. */
  breakdown: ScoreBreakdown;
}

export function recoverabilityScore(input: ScoreInput, settings: ScoreSettings): Score {
  const breakdown: ScoreBreakdown = {
    debtAge: stepPoints(settings.debtAgeSteps, Math.max(0, input.debtAgeDays)),
    writtenAcknowledgment: input.writtenAcknowledgment ? 100 : 0,
    evidenceQuality: settings.evidencePoints[input.evidenceQuality],
    amount: stepPoints(settings.amountSteps, input.amountDue),
    validContacts: Math.round(
      (Math.min(input.validContactCount, settings.contactsForFullPoints) * 100) /
        Math.max(1, settings.contactsForFullPoints),
    ),
    partialPayments: input.partialPaymentsMade ? 100 : 0,
  };
  const keys = Object.keys(breakdown) as (keyof ScoreWeights)[];
  const weighted = keys.reduce((sum, key) => sum + breakdown[key] * settings.weights[key], 0);
  const totalWeight = keys.reduce((sum, key) => sum + settings.weights[key], 0);
  // Somme des poids ramenée à 100 ; sans aucun poids, le score est nul.
  return { value: totalWeight === 0 ? 0 : Math.round(weighted / totalWeight), breakdown };
}

/** Problèmes de réglage du score : poids entiers de 0 à 100 dont au moins un positif, notes de 0 à 100. Vide = valide. */
export function scoreSettingsProblems(settings: ScoreSettings): string[] {
  const problems: string[] = [];
  const weights = Object.values(settings.weights);
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0 || w > 100) || weights.every((w) => w === 0)) {
    problems.push('poids entiers de 0 à 100, au moins un positif');
  }
  const points = [
    ...settings.debtAgeSteps.map((s) => s.points),
    ...settings.amountSteps.map((s) => s.points),
    ...Object.values(settings.evidencePoints),
  ];
  if (points.some((p) => !Number.isSafeInteger(p) || p < 0 || p > 100)) problems.push('notes de 0 à 100');
  for (const steps of [settings.debtAgeSteps, settings.amountSteps]) {
    if (steps.length === 0 || steps[steps.length - 1]!.upTo !== null)
      problems.push('dernier palier sans limite');
  }
  if (!Number.isSafeInteger(settings.contactsForFullPoints) || settings.contactsForFullPoints < 1) {
    problems.push('au moins un moyen de contact pour la note maximale');
  }
  return problems;
}
