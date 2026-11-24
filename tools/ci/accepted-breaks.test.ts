// Lancé par la CI : tsx --test tools/ci/*.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  breaksAllowed,
  classify,
  type ContractBreak,
  expiredEntries,
  parseAcceptedBreaks,
} from './accepted-breaks';

const justification = `    reason: Refonte du Nettoyage\n    adr: ADR-054\n    expires: '2027-02-28'\n`;
const file = (body: string) => `breaks:\n${body}`;

test('le fichier du dépôt est valide', () => {
  const text = readFileSync(join(__dirname, '..', '..', 'contracts', 'accepted-breaks.yaml'), 'utf8');
  assert.doesNotThrow(() => parseAcceptedBreaks(text));
});

test('fichier vide ou liste vide : aucune entrée', () => {
  assert.deepEqual(parseAcceptedBreaks(''), []);
  assert.deepEqual(parseAcceptedBreaks('breaks: []\n'), []);
});

test('entrées nommées des trois outils', () => {
  const entries = parseAcceptedBreaks(
    file(
      `  - tool: buf\n    file: ksp/cleaning/v1/cleaning.proto\n    rule: FIELD_NO_DELETE\n${justification}` +
        `  - tool: oasdiff\n    path: /api/v1/cleaning/simulations\n    id: new-required-request-property\n${justification}` +
        `  - tool: events\n    event: cleaning.quote.sent\n    version: 1\n${justification}`,
    ),
  );
  assert.equal(entries.length, 3);
});

test('motifs larges, champs manquants, doublons et clés inconnues refusés', () => {
  const refused = [
    `  - tool: buf\n    file: ksp/cleaning/v1/*.proto\n    rule: FIELD_NO_DELETE\n${justification}`,
    `  - tool: buf\n    file: ksp/cleaning/v1/cleaning.proto\n    rule: '*'\n${justification}`,
    `  - tool: oasdiff\n    path: /api/v1\n    id: api-path-removed-without-deprecation\n${justification}`,
    `  - tool: oasdiff\n    path: /api/v1/*\n    id: api-path-removed-without-deprecation\n${justification}`,
    `  - tool: events\n    event: cleaning.*\n    version: 1\n${justification}`,
    `  - tool: events\n    event: cleaning.quote.sent\n${justification}`,
    `  - tool: buf\n    file: ksp/cleaning/v1/cleaning.proto\n    rule: FIELD_NO_DELETE\n    adr: ADR-054\n    expires: '2027-02-28'\n`,
    `  - tool: buf\n    file: ksp/cleaning/v1/cleaning.proto\n    rule: FIELD_NO_DELETE\n    ignore: true\n${justification}`,
    `  - tool: autre\n${justification}`,
    `  - tool: buf\n    file: ksp/cleaning/v1/cleaning.proto\n    rule: FIELD_NO_DELETE\n${justification}`.repeat(
      2,
    ),
  ];
  for (const body of refused) assert.throws(() => parseAcceptedBreaks(file(body)), body);
  assert.throws(() => parseAcceptedBreaks('ignore: true\nbreaks: []\n'));
});

test('date limite : refusée le lendemain, acceptée le jour même', () => {
  const [entry] = parseAcceptedBreaks(
    file(`  - tool: events\n    event: cleaning.quote.sent\n    version: 1\n${justification}`),
  );
  assert.deepEqual(expiredEntries([entry], '2027-02-28'), []);
  assert.deepEqual(expiredEntries([entry], '2027-03-01'), [entry]);
});

test('branches : seule la refonte du Nettoyage peut déclarer des ruptures', () => {
  assert.equal(breaksAllowed('refonte/v2-adr', 'refonte/nettoyage-v2'), true);
  assert.equal(breaksAllowed('refonte/nettoyage-v2', 'main'), true);
  assert.equal(breaksAllowed('refonte/nettoyage-v2', undefined), true);
  assert.equal(breaksAllowed('feat/autre', 'main'), false);
  assert.equal(breaksAllowed('refonte/v2-adr', undefined), false);
  assert.equal(breaksAllowed('refonte/nettoyage-v2', 'develop'), false);
});

test('classement : chaque rupture doit correspondre exactement à une entrée', () => {
  const entries = parseAcceptedBreaks(
    file(
      `  - tool: buf\n    file: ksp/cleaning/v1/cleaning.proto\n    rule: FIELD_NO_DELETE\n${justification}` +
        `  - tool: oasdiff\n    path: /api/v1/cleaning\n    id: api-path-removed-without-deprecation\n${justification}` +
        `  - tool: events\n    event: cleaning.quote.sent\n    version: 1\n${justification}` +
        `  - tool: events\n    event: cleaning.quote.expired\n    version: 1\n${justification}`,
    ),
  );
  const found: ContractBreak[] = [
    { tool: 'buf', file: 'ksp/cleaning/v1/cleaning.proto', rule: 'FIELD_NO_DELETE', message: 'a' },
    { tool: 'buf', file: 'ksp/cleaning/v1/cleaning.proto', rule: 'FIELD_SAME_TYPE', message: 'b' },
    { tool: 'buf', file: 'ksp/billing/v1/billing.proto', rule: 'FIELD_NO_DELETE', message: 'c' },
    {
      tool: 'oasdiff',
      path: '/api/v1/cleaning/missions',
      method: 'GET',
      id: 'api-path-removed-without-deprecation',
      message: 'd',
    },
    {
      tool: 'oasdiff',
      path: '/api/v1/cleaningx/missions',
      method: 'GET',
      id: 'api-path-removed-without-deprecation',
      message: 'e',
    },
    { tool: 'oasdiff', path: '/api/v1/cleaning/missions', method: 'GET', id: 'other-rule', message: 'f' },
    { tool: 'events', event: 'cleaning.quote.sent', version: 1, file: 'x', message: 'g' },
    { tool: 'events', event: 'cleaning.quote.sent', version: 2, file: 'y', message: 'h' },
  ];
  const result = classify(found, entries);
  assert.deepEqual(
    result.refused.map((item) => item.message),
    ['b', 'c', 'e', 'f', 'h'],
  );
  assert.equal(result.accepted.size, 3);
  assert.deepEqual(
    result.unused.map((entry) => entry.tool === 'events' && entry.event),
    ['cleaning.quote.expired'],
  );
});
