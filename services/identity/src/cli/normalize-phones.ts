/**
 * Réécrit les numéros enregistrés avant la règle commune de normalisation (ADR-063) : un numéro
 * béninois `+229` à 8 chiffres devient `+229 01` suivi des 8 chiffres.
 *   pnpm --filter @ksp/identity-service build
 *   pnpm --filter @ksp/identity-service phones:normalize            # simulation, rien n'est écrit
 *   pnpm --filter @ksp/identity-service phones:normalize --apply    # réécriture
 * Idempotent : relancer la commande ne réécrit rien de plus. Une réécriture qui créerait un doublon
 * est refusée et listée (conflits, code de sortie 1) : à trancher à la main au back-office.
 * Les numéros sont masqués dans le rapport. Lit DATABASE_URL (fichier .env du service s'il existe).
 */
import { ReadinessRegistry } from '@ksp/platform';
import {
  NormalizePhonesUseCase,
  type PhoneNormalizationReport,
} from '../application/maintenance/normalize-phones.use-case';
import { PrismaPhoneNormalizationStore } from '../infrastructure/maintenance/prisma-phone-normalization.store';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/** Rapport lisible ; code de sortie 1 s'il reste des conflits. */
export function formatReport(report: PhoneNormalizationReport): { text: string; exitCode: number } {
  const lines = [
    report.applied ? 'Réécriture des numéros (ADR-063)' : 'Simulation, rien n’est écrit (ajouter --apply)',
    `Numéros lus : ${report.scanned} ; déjà normalisés : ${report.alreadyNormalized}`,
    `${report.applied ? 'Réécrits' : 'À réécrire'} : ${report.changes.length}`,
    ...report.changes.map((c) => `  ${c.from} → ${c.to}  compte ${c.userId}`),
    `Conflits (réécriture refusée, doublon) : ${report.conflicts.length}`,
    ...report.conflicts.map(
      (c) =>
        `  ${c.from} → ${c.to}  compte ${c.userId}, numéro déjà porté par ${c.holderUserId ?? 'inconnu'}`,
    ),
  ];
  if (report.skipped.length > 0) {
    lines.push(`Modifiés pendant le passage, laissés tels quels : ${report.skipped.length}`);
    lines.push(...report.skipped.map((c) => `  ${c.from}  compte ${c.userId}`));
  }
  if (report.unreadable.length > 0) {
    lines.push(`Illisibles, laissés tels quels : ${report.unreadable.length}`);
    lines.push(...report.unreadable.map((u) => `  ligne ${u.phoneId}  compte ${u.userId}`));
  }
  return { text: `${lines.join('\n')}\n`, exitCode: report.conflicts.length > 0 ? 1 : 0 };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--apply');
  if (unknown.length > 0) {
    process.stderr.write('Usage : phones:normalize [--apply]\n');
    return 2;
  }
  const prisma = new PrismaService(new ReadinessRegistry());
  try {
    const report = await new NormalizePhonesUseCase(new PrismaPhoneNormalizationStore(prisma)).execute({
      apply: args.includes('--apply'),
    });
    const { text, exitCode } = formatReport(report);
    process.stdout.write(text);
    return exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
