import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, rowsOf } from '../harness/checks.mjs';

test('rowsOf accepts an array or an object with one array', () => {
  assert.deepEqual(rowsOf({ json: [1] }), [1]);
  assert.deepEqual(rowsOf({ json: { rows: [1], count: 1 } }), [1]);
  assert.equal(rowsOf({ json: { a: [1], b: [2] } }), null);
  assert.equal(rowsOf({ json: 'x' }), null);
});

test('every check has an id, a group and an expectation', () => {
  const ids = new Set();
  for (const c of CHECKS) {
    assert.ok(/^[PFS]\d$/.test(c.id), c.id);
    assert.ok(!ids.has(c.id));
    ids.add(c.id);
    assert.ok(['must', 'should', 'scan'].includes(c.group));
    assert.ok(c.expect.length > 20);
  }
});
