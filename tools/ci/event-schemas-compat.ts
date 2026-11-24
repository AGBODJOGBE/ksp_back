/**
 * Contrôle de compatibilité des schémas d'événements (contracts/events) contre une référence git,
 * utilisé par la CI (ADR-051) :
 *   tsx tools/ci/event-schemas-compat.ts origin/main
 *
 * Une version d'événement publiée ne change que par ajout : un consommateur écrit pour l'ancien
 * schéma doit lire tout message conforme au nouveau. Sont refusés : un schéma retiré, un type ou
 * une version modifiés, une propriété retirée ou redéfinie, une propriété obligatoire devenue
 * facultative. Sont permis : une nouvelle propriété (dans tout objet), une propriété facultative
 * devenue obligatoire, une description modifiée. Une rupture se fait dans un nouveau fichier v2.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Schema = Record<string, unknown>;

const ROOT = join(__dirname, '..', '..');
const EVENTS = 'contracts/events';
/** Annotations sans effet sur les messages acceptés. */
const ANNOTATIONS = new Set(['description', 'title', 'examples', '$comment']);

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function withoutAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ANNOTATIONS.has(key))
      .map(([key, child]) => [key, withoutAnnotations(child)]),
  );
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(withoutAnnotations(a)) === JSON.stringify(withoutAnnotations(b));

/** Ruptures de `next` par rapport à `previous`, avec le chemin JSON de chacune. */
export function breakingChanges(previous: unknown, next: unknown, path = '$'): string[] {
  if (!isObject(previous) || !isObject(next)) {
    return same(previous, next) ? [] : [`${path} : définition modifiée`];
  }
  const errors: string[] = [];
  const nested = new Set(['properties', 'required', '$defs', 'items']);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (ANNOTATIONS.has(key) || nested.has(key)) continue;
    if (!same(previous[key], next[key])) errors.push(`${path}.${key} : modifié`);
  }
  for (const container of ['properties', '$defs'] as const) {
    const before = isObject(previous[container]) ? previous[container] : {};
    const after = isObject(next[container]) ? next[container] : {};
    for (const [name, schema] of Object.entries(before)) {
      if (!(name in after)) errors.push(`${path}.${container}.${name} : retiré`);
      else errors.push(...breakingChanges(schema, after[name], `${path}.${container}.${name}`));
    }
  }
  const required = new Set(Array.isArray(next.required) ? (next.required as string[]) : []);
  for (const name of Array.isArray(previous.required) ? (previous.required as string[]) : []) {
    if (!required.has(name)) errors.push(`${path}.required : « ${name} » n'est plus obligatoire`);
  }
  if ('items' in previous || 'items' in next) {
    errors.push(...breakingChanges(previous.items, next.items, `${path}.items`));
  }
  return errors;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Rupture d'un schéma publié dans `base`, avec le type et la version de l'événement visé. */
export interface EventSchemaBreak {
  file: string;
  eventType: string;
  version: number;
  message: string;
}

/**
 * Ruptures des schémas d'événements de `currentRoot` (par défaut ce dépôt) par rapport à la
 * référence git `base`. Utilisé aussi par le contrôle des ruptures acceptées (accepted-breaks.ts).
 */
export function eventSchemaBreaks(
  base: string,
  currentRoot = ROOT,
): { files: number; breaks: EventSchemaBreak[] } {
  const files = git(['ls-tree', '-r', '--name-only', base, '--', EVENTS])
    .split('\n')
    .filter((file) => file.endsWith('.json'));
  const breaks: EventSchemaBreak[] = [];
  for (const file of files) {
    const previous = JSON.parse(git(['show', `${base}:${file}`])) as Schema;
    const eventType = String(previous['x-event-type'] ?? file);
    const version = Number(previous['x-event-version'] ?? 0);
    let current: string;
    try {
      current = readFileSync(join(currentRoot, file), 'utf8');
    } catch {
      breaks.push({
        file,
        eventType,
        version,
        message: 'schéma retiré (une version publiée reste en place)',
      });
      continue;
    }
    for (const message of breakingChanges(previous, JSON.parse(current) as unknown)) {
      breaks.push({ file, eventType, version, message });
    }
  }
  return { files: files.length, breaks };
}

function main(): void {
  const base = process.argv[2] ?? 'origin/main';
  const { files, breaks } = eventSchemaBreaks(base);
  if (breaks.length > 0) {
    for (const { file, message } of breaks) process.stderr.write(`::error::${file} : ${message}\n`);
    process.stderr.write(
      `\n${breaks.length} rupture(s) de compatibilité des événements : publier une version v2 à côté.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${files} schémas d'événements compatibles avec ${base}.\n`);
}

if (require.main === module) main();
