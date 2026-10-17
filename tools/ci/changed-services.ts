/**
 * Liste les services à reconstruire depuis une référence git (utilisé par la CI).
 *   tsx tools/ci/changed-services.ts origin/main   →   ["identity","notification"]
 *
 * Règles : un fichier dans services/<nom>/ touche ce service ; une modification du socle
 * commun (libs/, contracts/, fichiers racine du build) ou de la CI elle-même (.github/workflows/, tools/ci/)
 * touche tous les services : une erreur dans la construction des images ne doit pas passer inaperçue.
 * Pas de regroupement de déploiements (ADR-015) : chaque service garde son image.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SHARED = [
  /^libs\//,
  /^contracts\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig\.base\.json$/,
  /^\.github\/workflows\//,
  /^tools\/ci\//,
];

export function affectedServices(changedFiles: string[], allServices: string[]): string[] {
  if (changedFiles.some((file) => SHARED.some((pattern) => pattern.test(file))))
    return [...allServices].sort();
  const touched = new Set<string>();
  for (const file of changedFiles) {
    const match = /^services\/([^/]+)\//.exec(file);
    if (match && allServices.includes(match[1])) touched.add(match[1]);
  }
  return [...touched].sort();
}

function main(): void {
  const base = process.argv[2] ?? 'origin/main';
  const allServices = readdirSync(join(ROOT, 'services'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  let changed: string[];
  try {
    changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    // Pas de base comparable (premier commit, historique tronqué) : on reconstruit tout.
    changed = ['package.json'];
  }
  process.stdout.write(JSON.stringify(affectedServices(changed, allServices)));
}

if (require.main === module) main();
