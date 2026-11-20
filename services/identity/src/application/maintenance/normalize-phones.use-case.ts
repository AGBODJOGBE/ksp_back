import { tryNormalizePhone } from '@ksp/platform';

/** Numéro enregistré d'un compte (table user_phones). */
export interface StoredPhone {
  id: string;
  userId: string;
  phoneE164: string;
}

/**
 * Issue d'une réécriture conditionnelle : `rewritten`, `taken` (le numéro cible appartient déjà à une
 * autre ligne, contrainte d'unicité) ou `changed` (la ligne a changé ou disparu entre la lecture et
 * l'écriture).
 */
export type PhoneRewriteOutcome = 'rewritten' | 'taken' | 'changed';

export interface PhoneNormalizationStore {
  /** Numéros enregistrés par lots, triés par identifiant, après `afterId`. */
  page(afterId: string | null, limit: number): Promise<StoredPhone[]>;
  findByNumber(phoneE164: string): Promise<StoredPhone | null>;
  /** Remplace `from` par `to` sur la ligne `id`, seulement si elle porte encore `from`. */
  rewrite(id: string, from: string, to: string): Promise<PhoneRewriteOutcome>;
}

/** Numéros masqués (indicatif et deux derniers chiffres) : le rapport ne montre jamais un numéro en clair. */
export interface PhoneChange {
  phoneId: string;
  userId: string;
  from: string;
  to: string;
}

export interface PhoneConflict extends PhoneChange {
  /** Compte qui porte déjà la forme normalisée ; null s'il n'a pas pu être relu. */
  holderUserId: string | null;
}

export interface PhoneNormalizationReport {
  applied: boolean;
  scanned: number;
  alreadyNormalized: number;
  /** Réécrits (`applied`) ou à réécrire (simulation). */
  changes: PhoneChange[];
  /** Réécritures refusées : elles créeraient un doublon. */
  conflicts: PhoneConflict[];
  /** Lignes modifiées par ailleurs pendant le passage, laissées telles quelles. */
  skipped: PhoneChange[];
  /** Valeurs qui ne se lisent pas comme un téléphone E.164, laissées telles quelles. */
  unreadable: { phoneId: string; userId: string }[];
}

const PAGE_SIZE = 500;

/** Forme masquée d'une valeur enregistrée, même illisible : +229******01. */
export function maskStoredPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`;
}

/**
 * Réécrit les numéros enregistrés avant la règle commune de normalisation (ADR-063) : un numéro
 * béninois `+229` à 8 chiffres devient `+229 01` suivi des 8 chiffres. Les autres numéros sont
 * inchangés. Idempotent : un second passage ne trouve plus rien à réécrire.
 * Une réécriture qui créerait un doublon (la forme normalisée appartient déjà à une ligne) est
 * refusée et rapportée : la décision revient à un humain. Sans `apply`, rien n'est écrit.
 */
export class NormalizePhonesUseCase {
  constructor(private readonly store: PhoneNormalizationStore) {}

  async execute(input: { apply: boolean }): Promise<PhoneNormalizationReport> {
    const report: PhoneNormalizationReport = {
      applied: input.apply,
      scanned: 0,
      alreadyNormalized: 0,
      changes: [],
      conflicts: [],
      skipped: [],
      unreadable: [],
    };
    let afterId: string | null = null;
    for (;;) {
      const rows = await this.store.page(afterId, PAGE_SIZE);
      for (const row of rows) await this.handle(row, input.apply, report);
      if (rows.length < PAGE_SIZE) return report;
      afterId = rows[rows.length - 1].id;
    }
  }

  private async handle(row: StoredPhone, apply: boolean, report: PhoneNormalizationReport): Promise<void> {
    report.scanned += 1;
    const target = tryNormalizePhone(row.phoneE164);
    if (target === null) {
      report.unreadable.push({ phoneId: row.id, userId: row.userId });
      return;
    }
    if (target === row.phoneE164) {
      report.alreadyNormalized += 1;
      return;
    }
    const change: PhoneChange = {
      phoneId: row.id,
      userId: row.userId,
      from: maskStoredPhone(row.phoneE164),
      to: maskStoredPhone(target),
    };
    const holder = await this.store.findByNumber(target);
    if (holder && holder.id !== row.id) {
      report.conflicts.push({ ...change, holderUserId: holder.userId });
      return;
    }
    if (!apply) {
      report.changes.push(change);
      return;
    }
    const outcome = await this.store.rewrite(row.id, row.phoneE164, target);
    if (outcome === 'rewritten') report.changes.push(change);
    else if (outcome === 'changed') report.skipped.push(change);
    else {
      // Numéro pris entre la vérification et l'écriture.
      const latest = await this.store.findByNumber(target);
      report.conflicts.push({ ...change, holderUserId: latest?.userId ?? null });
    }
  }
}
