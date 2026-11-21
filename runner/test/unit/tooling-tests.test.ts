// runner/test/tooling-tests.mjs: which slow tooling tests check.sh --quick
// leaves out, read from this checkout's own files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script with no types
import { leaveOut, TOOLING } from '../tooling-tests.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const left = (changed: string[]): string[] => (leaveOut(ROOT, changed) as { test: string }[]).map((o) => o.test);

test('a change outside the tooling leaves out the tooling tests that read none of it', () => {
  const out = left(['desktop/gpui/src/app.rs', 'web/src/main.tsx']);
  for (const t of ['perf-lock', 'check-remote-room', 'land-queue', 'upstream-refs']) assert.ok(out.includes(`test/unit/${t}.test.ts`), t);
  assert.ok(out.length >= (TOOLING as string[]).length - 3, `most of them: ${out.length}`);
  // A runner module counts for the tests that import it.
  const worktrees = left(['runner/src/worktrees.ts']);
  assert.ok(!worktrees.includes('test/unit/land-queue.test.ts'), 'land-queue imports worktrees.ts');
  assert.ok(worktrees.includes('test/unit/perf-lock.test.ts'), 'perf-lock reads nothing of it');
  // All the way down: release.test.ts boots src/main.ts, which reaches fsutil.ts.
  assert.ok(!left(['runner/src/fsutil.ts']).includes('test/unit/release.test.ts'), 'what main.ts imports counts');
  // A test that runs tb reads cli.ts.
  assert.ok(!left(['runner/src/cli.ts']).includes('test/unit/tb-dev.test.ts'), 'tb-dev runs bin/tb');
});

test('a test runs when it changes itself, or the tooling, check.sh or the packages change', () => {
  assert.ok(!left(['runner/test/unit/perf-lock.test.ts']).includes('test/unit/perf-lock.test.ts'));
  for (const f of ['scripts/perf-lock.pl', 'desktop/scripts/remote.sh', 'runner/test/helpers/fakes.ts', 'check.sh', 'runner/package.json', 'runner/test/tooling-tests.mjs']) {
    assert.deepEqual(left([f]), [], f);
  }
  // Nothing changed (main itself): everything runs.
  assert.deepEqual(left([]), []);
});

test('every name in the list is a test file here', async () => {
  const fs = await import('node:fs');
  for (const t of TOOLING as string[]) assert.ok(fs.existsSync(path.join(ROOT, 'runner', t)), t);
});
