/**
 * Contrôle des ruptures de contrat (ADR-051 ; ruptures acceptées : ADR-054, décision 7), lancé par la
 * CI et par « pnpm contracts:breaking » :
 *   tsx tools/ci/accepted-breaks.ts [--against main] [--base <branche visée>] [--head <branche>]
 *                                   [--current <dossier>] [--accepted <fichier>] [--oasdiff <binaire>]
 *
 * Les trois contrôles de compatibilité tournent sans changement de règle :
 *   - buf breaking (règles de buf.yaml) sur contracts/proto ;
 *   - oasdiff breaking sur contracts/openapi/ksp-api.v1.yaml, niveau ERR (comme « --fail-on ERR ») ;
 *   - compatibilité des schémas d'événements (event-schemas-compat.ts).
 * Chaque rupture trouvée est cherchée dans contracts/accepted-breaks.yaml. Le contrôle échoue sur :
 *   - toute rupture absente du fichier ;
 *   - une entrée invalide, trop large, en double ou dont la date limite est passée ;
 *   - toute entrée présente hors de la refonte du Nettoyage : seules la branche refonte/nettoyage-v2,
 *     une demande de fusion qui la vise et sa fusion vers main peuvent déclarer des ruptures.
 * Les ruptures acceptées sont écrites dans le résumé du job (GITHUB_STEP_SUMMARY).
 *
 * oasdiff : option --oasdiff ou variable OASDIFF_BIN (la CI passe le binaire vérifié), sinon
 * « oasdiff » dans le PATH, sinon l'image Docker officielle tufin/oasdiff à la même version.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { eventSchemaBreaks } from './event-schemas-compat';

const ROOT = join(__dirname, '..', '..');
const ACCEPTED_FILE = 'contracts/accepted-breaks.yaml';
const OPENAPI_FILE = 'contracts/openapi/ksp-api.v1.yaml';
/** Seule branche dont les demandes de fusion peuvent déclarer des ruptures (ADR-054, décision 6). */
export const INTEGRATION_BRANCH = 'refonte/nettoyage-v2';
/** Même version que OASDIFF_VERSION dans .github/workflows/ci.yml. */
const OASDIFF_VERSION = process.env.OASDIFF_VERSION ?? '1.34.1';
/** Niveau « ERR » d'oasdiff : seul niveau qui fait échouer « oasdiff breaking --fail-on ERR ». */
const OASDIFF_ERR = 3;

export type Tool = 'buf' | 'oasdiff' | 'events';

export type ContractBreak =
  | { tool: 'buf'; file: string; rule: string; message: string }
  | { tool: 'oasdiff'; path: string; method: string; id: string; message: string }
  | { tool: 'events'; event: string; version: number; file: string; message: string };

interface Justification {
  reason: string;
  adr: string;
  expires: string;
}

export type AcceptedBreak = Justification &
  (
    | { tool: 'buf'; file: string; rule: string }
    | { tool: 'oasdiff'; path: string; id: string }
    | { tool: 'events'; event: string; version: number }
  );

const FIELDS: Record<Tool, string[]> = {
  buf: ['file', 'rule'],
  oasdiff: ['path', 'id'],
  events: ['event', 'version'],
};
const COMMON = ['tool', 'reason', 'adr', 'expires'];
/** Formes exactes attendues : aucun caractère de motif (*, ?, [) n'y passe. */
const PATTERNS: Record<string, RegExp> = {
  file: /^[a-z0-9_]+(\/[a-z0-9_]+)*\.proto$/,
  rule: /^[A-Z][A-Z0-9_]+$/,
  // Préfixe de chemin REST : au moins trois segments (/api/v1/<domaine>), sans barre finale.
  path: /^\/api(\/[A-Za-z0-9_.{}-]+){2,}$/,
  id: /^[a-z0-9]+(-[a-z0-9]+)+$/,
  event: /^[a-z0-9_]+(\.[a-z0-9_]+){2,}$/,
  adr: /^ADR-\d{3}$/,
  expires: /^\d{4}-\d{2}-\d{2}$/,
};

/** Lit et valide le fichier des ruptures acceptées ; lève une erreur listant chaque problème. */
export function parseAcceptedBreaks(text: string): AcceptedBreak[] {
  const document = (parse(text) ?? {}) as unknown;
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('le fichier doit contenir une clé « breaks » (liste, éventuellement vide)');
  }
  const unknownKeys = Object.keys(document).filter((key) => key !== 'breaks');
  if (unknownKeys.length > 0) throw new Error(`clé(s) inconnue(s) : ${unknownKeys.join(', ')}`);
  const list = (document as { breaks?: unknown }).breaks ?? [];
  if (!Array.isArray(list)) throw new Error('« breaks » doit être une liste');

  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((raw: unknown, index) => {
    const where = `entrée ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`${where} : objet attendu`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const tool = entry.tool as Tool;
    if (!(tool in FIELDS)) {
      errors.push(`${where} : « tool » doit valoir buf, oasdiff ou events`);
      return;
    }
    const allowed = [...COMMON, ...FIELDS[tool]];
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) errors.push(`${where} : clé « ${key} » inconnue pour ${tool}`);
    }
    for (const key of allowed.filter((name) => name !== 'tool')) {
      const value = entry[key];
      if (key === 'version') {
        if (!Number.isInteger(value) || (value as number) < 1) {
          errors.push(`${where} : « version » doit être un entier positif`);
        }
      } else if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${where} : « ${key} » obligatoire`);
      } else if (PATTERNS[key] && !PATTERNS[key].test(value)) {
        errors.push(`${where} : « ${key} » invalide ou trop large (${value})`);
      } else if (key === 'expires' && Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        errors.push(`${where} : date limite invalide (${value})`);
      }
    }
    const key = [tool, ...FIELDS[tool].map((name) => String(entry[name]))].join(' ');
    if (seen.has(key)) errors.push(`${where} : entrée en double (${key})`);
    seen.add(key);
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return list as AcceptedBreak[];
}

/** Entrées dont la date limite (incluse) est passée au jour `today` (AAAA-MM-JJ). */
export function expiredEntries(entries: AcceptedBreak[], today: string): AcceptedBreak[] {
  return entries.filter((entry) => entry.expires < today);
}

/**
 * Des ruptures ne peuvent être déclarées que pendant la refonte : sur refonte/nettoyage-v2, sur une
 * demande de fusion qui la vise, ou sur sa fusion vers main.
 */
export function breaksAllowed(head: string | undefined, base: string | undefined): boolean {
  if (base === INTEGRATION_BRANCH) return true;
  return head === INTEGRATION_BRANCH && (base === undefined || base === 'main');
}

export function entryMatches(entry: AcceptedBreak, found: ContractBreak): boolean {
  if (entry.tool !== found.tool) return false;
  switch (found.tool) {
    case 'buf': {
      const accepted = entry as Extract<AcceptedBreak, { tool: 'buf' }>;
      return accepted.file === found.file && accepted.rule === found.rule;
    }
    case 'oasdiff': {
      const accepted = entry as Extract<AcceptedBreak, { tool: 'oasdiff' }>;
      const inside = found.path === accepted.path || found.path.startsWith(`${accepted.path}/`);
      return inside && accepted.id === found.id;
    }
    case 'events': {
      const accepted = entry as Extract<AcceptedBreak, { tool: 'events' }>;
      return accepted.event === found.event && accepted.version === found.version;
    }
  }
}

export interface Classification {
  accepted: Map<AcceptedBreak, ContractBreak[]>;
  refused: ContractBreak[];
  unused: AcceptedBreak[];
}

export function classify(found: ContractBreak[], entries: AcceptedBreak[]): Classification {
  const accepted = new Map<AcceptedBreak, ContractBreak[]>(entries.map((entry) => [entry, []]));
  const refused: ContractBreak[] = [];
  for (const item of found) {
    const entry = entries.find((candidate) => entryMatches(candidate, item));
    if (entry) accepted.get(entry)!.push(item);
    else refused.push(item);
  }
  const unused = entries.filter((entry) => accepted.get(entry)!.length === 0);
  for (const entry of unused) accepted.delete(entry);
  return { accepted, refused, unused };
}

export function describeEntry(entry: AcceptedBreak): string {
  switch (entry.tool) {
    case 'buf':
      return `buf ${entry.file} ${entry.rule}`;
    case 'oasdiff':
      return `oasdiff ${entry.path} ${entry.id}`;
    case 'events':
      return `événement ${entry.event} v${entry.version}`;
  }
}

export function describeBreak(found: ContractBreak): string {
  switch (found.tool) {
    case 'buf':
      return `buf ${found.file} ${found.rule} : ${found.message}`;
    case 'oasdiff':
      return `oasdiff ${found.method} ${found.path} ${found.id} : ${found.message}`;
    case 'events':
      return `événement ${found.event} v${found.version} (${found.file}) : ${found.message}`;
  }
}

// --- Lancement des contrôles -------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Recopie les fichiers de `paths` tels qu'ils sont dans la référence git `ref` (marche aussi dans une copie de travail git). */
function exportFromGit(ref: string, paths: string[], target: string): void {
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', ...paths])
    .split('\n')
    .filter(Boolean);
  for (const file of files) {
    const destination = join(target, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, git(['show', `${ref}:${file}`]));
  }
}

/** buf breaking, avec les règles de buf.yaml du dossier courant, contre la référence exportée. */
function bufBreaks(current: string, against: string): ContractBreak[] {
  const buf = require.resolve('@bufbuild/buf/bin/buf', { paths: [ROOT] });
  const run = spawnSync(
    process.execPath,
    [buf, 'breaking', '.', '--against', against, '--error-format', 'json'],
    { cwd: current, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  // 0 : aucune rupture ; 100 : ruptures trouvées ; tout autre code : buf n'a pas pu comparer.
  if (run.status !== 0 && run.status !== 100) {
    throw new Error(`buf breaking a échoué (code ${run.status}) :\n${run.stderr}${run.stdout}`);
  }
  return run.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const annotation = JSON.parse(line) as { path?: string; type: string; message: string };
      // Chemin relatif au module (contracts/proto), quel que soit le système.
      const file = (annotation.path ?? '').replace(/\\/g, '/').replace(/^(.*\/)?contracts\/proto\//, '');
      return { tool: 'buf' as const, file, rule: annotation.type, message: annotation.message };
    });
}

function commandWorks(command: string, args: string[]): boolean {
  const run = spawnSync(command, args, { encoding: 'utf8', stdio: 'ignore' });
  return run.status === 0;
}

/** oasdiff breaking au format JSON ; seules les ruptures de niveau ERR comptent. */
function oasdiffBreaks(workdir: string, binary: string | undefined): ContractBreak[] {
  const args = ['breaking', 'base.yaml', 'current.yaml', '--format', 'json'];
  let run;
  if (binary || commandWorks('oasdiff', ['--version'])) {
    run = spawnSync(binary ?? 'oasdiff', args, {
      cwd: workdir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } else if (commandWorks('docker', ['version'])) {
    const image = `tufin/oasdiff:v${OASDIFF_VERSION}`;
    run = spawnSync('docker', ['run', '--rm', '-v', `${workdir}:/specs`, '-w', '/specs', image, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } else {
    throw new Error(
      'oasdiff introuvable : passer --oasdiff <binaire>, définir OASDIFF_BIN, installer oasdiff ou démarrer Docker.',
    );
  }
  if (run.error || run.status !== 0) {
    throw new Error(`oasdiff a échoué (code ${run.status}) :\n${run.error ?? ''}${run.stderr}${run.stdout}`);
  }
  const changes = JSON.parse(run.stdout || '[]') as {
    id: string;
    text: string;
    level: number;
    operation?: string;
    path?: string;
  }[];
  return changes
    .filter((change) => change.level >= OASDIFF_ERR)
    .map((change) => ({
      tool: 'oasdiff' as const,
      path: change.path ?? '',
      method: change.operation ?? '',
      id: change.id,
      message: change.text,
    }));
}

function eventBreaks(against: string, current: string): { files: number; breaks: ContractBreak[] } {
  const { files, breaks } = eventSchemaBreaks(against, current);
  return {
    files,
    breaks: breaks.map(({ file, eventType, version, message }) => ({
      tool: 'events' as const,
      event: eventType,
      version,
      file,
      message,
    })),
  };
}

// --- Contexte de la CI et résumé -----------------------------------------------------------------

interface Options {
  against: string;
  current: string;
  accepted: string;
  head?: string;
  base?: string;
  oasdiff?: string;
}

function readOptions(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} attend une valeur`);
    return next;
  };
  const known = ['against', 'current', 'accepted', 'head', 'base', 'oasdiff'];
  for (const arg of argv.filter((item) => item.startsWith('--'))) {
    if (!known.includes(arg.slice(2))) throw new Error(`option inconnue : ${arg}`);
  }
  const current = resolve(value('current') ?? ROOT);
  return {
    against: value('against') ?? 'main',
    current,
    accepted: resolve(value('accepted') ?? join(current, ACCEPTED_FILE)),
    head: value('head'),
    base: value('base'),
    oasdiff: value('oasdiff') ?? (process.env.OASDIFF_BIN || undefined),
  };
}

/** Branche de travail et branche visée, d'après GitHub Actions ou, en local, d'après git. */
function branches(options: Options): { head?: string; base?: string } {
  const env = process.env;
  const pullRequest = env.GITHUB_EVENT_NAME === 'pull_request';
  let head = options.head;
  if (!head && pullRequest) {
    // Le nom de branche d'une copie (fork) ne compte pas : seule une branche du dépôt peut être la refonte.
    const event = env.GITHUB_EVENT_PATH
      ? (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as {
          pull_request?: { head?: { repo?: { full_name?: string } } };
        })
      : {};
    const sameRepository = event.pull_request?.head?.repo?.full_name === env.GITHUB_REPOSITORY;
    head = sameRepository ? env.GITHUB_HEAD_REF : `${env.GITHUB_HEAD_REF} (copie externe)`;
  }
  head ??= env.GITHUB_ACTIONS ? env.GITHUB_REF_NAME : git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const base = options.base ?? (pullRequest ? env.GITHUB_BASE_REF : undefined);
  return { head, base };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function summary(
  result: Classification,
  counts: Record<Tool, number>,
  context: string,
  failures: string[],
): string {
  const acceptedTotal = [...result.accepted.values()].reduce((sum, items) => sum + items.length, 0);
  const lines = [
    '## Contrats — ruptures de compatibilité',
    '',
    `${context}`,
    '',
    `Ruptures trouvées : buf ${counts.buf}, oasdiff ${counts.oasdiff}, événements ${counts.events}.`,
    `**${acceptedTotal} rupture(s) acceptée(s)**, ${result.refused.length} refusée(s).`,
    '',
  ];
  if (failures.length > 0) {
    lines.push('### Échec', '', ...failures.map((failure) => `- ${escapeCell(failure)}`), '');
  }
  if (result.accepted.size > 0) {
    const byAdr = new Map<string, number>();
    for (const [entry, items] of result.accepted)
      byAdr.set(entry.adr, (byAdr.get(entry.adr) ?? 0) + items.length);
    lines.push(
      [...byAdr].map(([adr, count]) => `${count} ruptures acceptées par ${adr}.`).join(' '),
      '',
      '| Entrée | Ruptures | Motif | ADR | Date limite |',
      '| --- | ---: | --- | --- | --- |',
      ...[...result.accepted].map(
        ([entry, items]) =>
          `| ${escapeCell(describeEntry(entry))} | ${items.length} | ${escapeCell(entry.reason)} | ${entry.adr} | ${entry.expires} |`,
      ),
      '',
      '<details><summary>Détail des ruptures acceptées</summary>',
      '',
      ...[...result.accepted.values()].flat().map((item) => `- ${escapeCell(describeBreak(item))}`),
      '',
      '</details>',
      '',
    );
  }
  if (result.refused.length > 0) {
    lines.push(
      '### Ruptures refusées',
      '',
      ...result.refused.map((item) => `- ${escapeCell(describeBreak(item))}`),
      '',
    );
  }
  if (result.unused.length > 0) {
    lines.push(
      '### Entrées sans rupture correspondante (à retirer si elles ne servent plus)',
      '',
      ...result.unused.map((entry) => `- ${escapeCell(describeEntry(entry))}`),
      '',
    );
  }
  return lines.join('\n');
}

function main(): void {
  const options = readOptions(process.argv.slice(2));
  const failures: string[] = [];

  let entries: AcceptedBreak[] = [];
  if (existsSync(options.accepted)) {
    try {
      entries = parseAcceptedBreaks(readFileSync(options.accepted, 'utf8'));
    } catch (error) {
      failures.push(`${ACCEPTED_FILE} refusé :\n${(error as Error).message}`);
    }
  }
  const { head, base } = branches(options);
  const context = `Branche ${head ?? 'inconnue'}${base ? ` vers ${base}` : ''}, comparée à ${options.against}.`;
  // Une entrée refusée (mauvaise branche, date limite passée) n'accepte aucune rupture.
  let usable = entries;
  if (entries.length > 0 && !breaksAllowed(head, base)) {
    failures.push(
      `${ACCEPTED_FILE} contient ${entries.length} entrée(s) : seules la branche ${INTEGRATION_BRANCH}, ` +
        `une demande de fusion qui la vise et sa fusion vers main peuvent déclarer des ruptures (${context})`,
    );
    usable = [];
  }
  const today = new Date().toISOString().slice(0, 10);
  const expired = expiredEntries(entries, today);
  for (const entry of expired) {
    failures.push(`date limite dépassée (${entry.expires}) : ${describeEntry(entry)}`);
  }
  usable = usable.filter((entry) => !expired.includes(entry));

  const workdir = mkdtempSync(join(tmpdir(), 'ksp-contracts-'));
  let found: ContractBreak[];
  const counts: Record<Tool, number> = { buf: 0, oasdiff: 0, events: 0 };
  try {
    const against = join(workdir, 'against');
    exportFromGit(options.against, ['buf.yaml', 'contracts/proto'], against);
    const buf = bufBreaks(options.current, against);

    const specs = join(workdir, 'openapi');
    mkdirSync(specs);
    writeFileSync(join(specs, 'base.yaml'), git(['show', `${options.against}:${OPENAPI_FILE}`]));
    writeFileSync(join(specs, 'current.yaml'), readFileSync(join(options.current, OPENAPI_FILE)));
    const oasdiff = oasdiffBreaks(specs, options.oasdiff);

    const events = eventBreaks(options.against, options.current);
    found = [...buf, ...oasdiff, ...events.breaks];
    Object.assign(counts, { buf: buf.length, oasdiff: oasdiff.length, events: events.breaks.length });
    process.stdout.write(`${events.files} schémas d'événements comparés.\n`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  const result = classify(found, usable);
  for (const item of result.refused)
    process.stderr.write(`::error::Rupture non acceptée : ${describeBreak(item)}\n`);
  for (const entry of result.unused) {
    process.stdout.write(`::warning::Entrée sans rupture correspondante : ${describeEntry(entry)}\n`);
  }
  if (result.refused.length > 0) {
    failures.push(
      `${result.refused.length} rupture(s) de compatibilité non déclarée(s) dans ${ACCEPTED_FILE} : ` +
        'ajouter un champ ou une version à côté (ADR-051), ou, pendant la refonte du Nettoyage seulement, une entrée nommée (ADR-054).',
    );
  }

  const report = summary(result, counts, context, failures);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  for (const [entry, items] of result.accepted) {
    process.stdout.write(
      `Acceptée (${entry.adr}, jusqu'au ${entry.expires}) : ${describeEntry(entry)} — ${items.length}\n`,
    );
  }
  process.stdout.write(
    `Ruptures : buf ${counts.buf}, oasdiff ${counts.oasdiff}, événements ${counts.events} ; ` +
      `${found.length - result.refused.length} acceptée(s), ${result.refused.length} refusée(s). ${context}\n`,
  );
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();
