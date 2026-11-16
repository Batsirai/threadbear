// node --test web/src/token.test.ts
// The website's sign-in link (API 81): a one-use code in the fragment, never
// the browser's token, and an old link's token is never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSignInHash } from './token.ts';

test('a sign-in link gives a one-use code to trade', () => {
  const code = 'tbp_' + 'a1'.repeat(24);
  assert.deepEqual(readSignInHash(`#code=${code}`), { code, oldLink: false });
});

test("an old link's token is never taken as this browser's", () => {
  const read = readSignInHash('#token=tb_0123456789abcdef');
  assert.equal(read.code, undefined);
  assert.equal(read.oldLink, true);
  // A token put where the code goes isn't one either.
  assert.equal(readSignInHash('#code=tb_0123456789abcdef').code, undefined);
});

test('anything else in the fragment is no sign-in at all', () => {
  assert.deepEqual(readSignInHash('#usage'), { code: undefined, oldLink: false });
  assert.deepEqual(readSignInHash(''), { code: undefined, oldLink: false });
  assert.equal(readSignInHash('#code=tbp_<script>').code, undefined);
});
