// Lancé par la CI : tsx --test tools/ci/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakingChanges } from './event-schemas-compat';

const v1 = {
  'x-event-type': 'billing.invoice.paid',
  'x-event-version': 1,
  type: 'object',
  additionalProperties: false,
  required: ['invoiceId', 'total'],
  $defs: { money: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } } },
  properties: {
    invoiceId: { type: 'string', format: 'uuid', description: 'Facture' },
    total: { $ref: '#/$defs/money' },
    note: { type: 'string' },
  },
};

const clone = (): typeof v1 => JSON.parse(JSON.stringify(v1)) as typeof v1;

test('ajouts permis : propriété, définition, obligation renforcée, description', () => {
  const next = clone() as Record<string, unknown> & typeof v1;
  (next.properties as Record<string, unknown>)['paidAt'] = { type: 'string' };
  (next.$defs.money.properties as Record<string, unknown>)['currency'] = { const: 'XOF' };
  next.required = [...next.required, 'note'];
  next.properties.invoiceId.description = 'Identifiant de la facture';
  assert.deepEqual(breakingChanges(v1, next), []);
});

test('ruptures : propriété retirée ou redéfinie, obligation levée, type ou version modifiés', () => {
  const next = clone() as Record<string, unknown> & typeof v1;
  delete (next.properties as Record<string, unknown>)['note'];
  next.properties.invoiceId = { type: 'integer' } as never;
  next.required = ['invoiceId'];
  next['x-event-version'] = 2;
  next.$defs.money.properties.amount = { type: 'number' };
  const errors = breakingChanges(v1, next);
  assert.ok(errors.some((e) => e.includes('properties.note : retiré')));
  assert.ok(errors.some((e) => e.includes('properties.invoiceId.type')));
  assert.ok(errors.some((e) => e.includes("« total » n'est plus obligatoire")));
  assert.ok(errors.some((e) => e.includes('x-event-version')));
  assert.ok(errors.some((e) => e.includes('$defs.money.properties.amount.type')));
});

test('schéma identique : aucune rupture', () => {
  assert.deepEqual(breakingChanges(v1, clone()), []);
});
