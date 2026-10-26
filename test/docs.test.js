import { test } from 'node:test';
import assert from 'node:assert/strict';
import { direction } from '../sync/docs.js';

const byRevision = (a, b) => a.revision > b.revision;

test('the copy with the higher revision wins', () => {
  assert.equal(direction({ revision: 3 }, { revision: 5 }, byRevision), 'pull');
  assert.equal(direction({ revision: 5 }, { revision: 3 }, byRevision), 'push');
  assert.equal(direction({ revision: 4 }, { revision: 4 }, byRevision), null);
});

test('a missing copy is filled from the other', () => {
  assert.equal(direction(null, { revision: 1 }, byRevision), 'pull');
  assert.equal(direction({ revision: 1 }, null, byRevision), 'push');
  assert.equal(direction(null, null, byRevision), null);
});
