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

function main(): void {
  const base = process.argv[2] ?? 'origin/main';
  const files = git(['ls-tree', '-r', '--name-only', base, '--', EVENTS])
    .split('\n')
    .filter((file) => file.endsWith('.json'));
  const errors: string[] = [];
  for (const file of files) {
    let current: string;
    try {
      current = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      errors.push(`${file} : schéma retiré (une version publiée reste en place)`);
      continue;
    }
    const previous = JSON.parse(git(['show', `${base}:${file}`])) as unknown;
    for (const error of breakingChanges(previous, JSON.parse(current) as unknown)) {
      errors.push(`${file} ${error}`);
    }
  }
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`::error::${error}\n`);
    process.stderr.write(
      `\n${errors.length} rupture(s) de compatibilité des événements : publier une version v2 à côté.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${files.length} schémas d'événements compatibles avec ${base}.\n`);
}

if (require.main === module) main();
