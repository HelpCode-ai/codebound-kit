import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expectedFiles } from '../scripts/generate-expected.mjs';
import { priceDrift, catalogueTotal, stuckOrders } from '../mocks/reference.mjs';
import { dataset } from '../mocks/data.mjs';

test('expected/*.json matches the reference answers', () => {
  for (const [name, body] of Object.entries(expectedFiles())) {
    assert.deepEqual(JSON.parse(fs.readFileSync(`expected/${name}`, 'utf8')), JSON.parse(JSON.stringify(body)), `${name} is stale: run npm run expected`);
  }
});

test('the dataset is deterministic', () => {
  assert.equal(dataset('A').articles.length, 450);
  assert.equal(dataset('A').articles.filter((a) => a.status === 'inactive').length, 50);
  assert.equal(dataset('A').orders.length, 120);
});

test('the numbers the brief quotes', () => {
  assert.equal(priceDrift('A', 5).length, 4);
  assert.equal(priceDrift('A', 10).length, 2);
  assert.deepEqual(catalogueTotal('A', 'fasteners'), { category: 'fasteners', total: 800, complete: true });
  assert.deepEqual(catalogueTotal('A', 'legacy'), { category: 'legacy', total: 200, complete: false });
  assert.equal(stuckOrders('A', 3).length, 5);
  assert.equal(stuckOrders('A', 7).length, 2);
});

test('workspaces never share an identifier', () => {
  const a = new Set(dataset('A').articles.map((x) => x.sku));
  assert.ok(dataset('B').articles.every((x) => !a.has(x.sku)));
  assert.ok(dataset('B').articles.every((x) => x.sku.startsWith('B-')));
});
