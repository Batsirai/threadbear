// Daybreak 126 (15 Nov 2026): a schedule's check is approved by a digest
// of the command and every file it reaches, taken again just before each
// run, and then `/bin/sh` opens those files from the live folder. A check
// like `sleep 30; ./check.sh` passed its digest, and an Auto thread in the
// same folder could replace check.sh in those 30 seconds (or any time
// before a run): nothing made that edit ask, so its words ran unattended
// as the runner's user. Now everything an active check reaches is code to
// writeRunsAsCode, so outside Full access an edit of it always asks, from
// the moment the check exists until it's gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';
import { PatchTrust } from '../../src/patch-trust.ts';
import { Scheduler } from '../../src/schedules.ts';
import type { ThreadRecord } from '../../src/store.ts';

function put(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

async function setup() {
  const root = fs.realpathSync(tmpDir());
  const cwd = path.join(root, 'repo');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  put(path.join(cwd, 'README.md'), 'hi\n');
  put(path.join(cwd, 'check.sh'), '#!/bin/sh\nsh ./lib/inner.sh\n', 0o755);
  put(path.join(cwd, 'lib', 'inner.sh'), 'echo inner\n');
  // A script outside the repo, by its absolute path, and one reached
  // through a link.
  const outside = path.join(root, 'tools', 'watch.sh');
  put(outside, '#!/bin/sh\necho watch\n', 0o755);
  put(path.join(root, 'real', 'linked.sh'), 'echo linked\n', 0o755);
  fs.symlinkSync(path.join(root, 'real', 'linked.sh'), path.join(cwd, 'linked.sh'));
  const data = tmpDir();
  const h = makeHarness(data, {}, { panelsRoot: root, patchTrust: new PatchTrust({ file: path.join(data, 'patch-trust.json'), claudeHome: root }) });
  const sched = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC', runCheck: async () => ({ ok: true, output: '' }) });
  sched.start();
  h.runner.scheduleChecks = () => sched.localChecks();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd, permissionMode: 'auto' });
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  const runsAsCode = (file: string) => h.runner.writeRunsAsCode({ ...thread, cwd } as unknown as ThreadRecord, file);
  return { h, sched, root, cwd, outside, thread, runsAsCode };
}

test("an Auto thread's edit of a script an approved check opens later asks, transitive, absolute and linked ones too", async () => {
  const { sched, root, cwd, outside, runsAsCode } = await setup();
  assert.equal(runsAsCode(path.join(cwd, 'check.sh')), false, 'nothing runs it yet');
  // The benign-looking check of the write-up: a pause, then the script.
  await sched.create({ text: 'Look', cron: '*/5 * * * *', cwd, check: `sleep 30; ./check.sh; ${outside}; sh ./linked.sh` });
  assert.equal(runsAsCode(path.join(cwd, 'check.sh')), true, 'the script the shell opens after the pause');
  assert.equal(runsAsCode(path.join(cwd, 'lib', 'inner.sh')), true, 'what that script runs in turn');
  assert.equal(runsAsCode(outside), true, 'a script outside the repo by its absolute path');
  assert.equal(runsAsCode(path.join(cwd, 'linked.sh')), true, 'the link, as an edit writes through it');
  assert.equal(runsAsCode(path.join(root, 'real', 'linked.sh')), true, 'the file a link leads to');
  assert.equal(runsAsCode(path.join(cwd, 'README.md')), false, "a file it doesn't reach");
});

test('a script a check names that is not there yet asks too, as writing it adds code the check runs', async () => {
  const { sched, cwd, runsAsCode } = await setup();
  await sched.create({ text: 'Look', cron: '*/5 * * * *', cwd, check: 'sleep 1; ./later.sh' });
  assert.equal(runsAsCode(path.join(cwd, 'later.sh')), true);
});

test('changing or deleting a schedule changes what is guarded at once', async () => {
  const { sched, cwd, runsAsCode } = await setup();
  put(path.join(cwd, 'other.sh'), 'echo other\n', 0o755);
  const sc = await sched.create({ text: 'Look', cron: '*/5 * * * *', cwd, check: './check.sh' });
  assert.equal(runsAsCode(path.join(cwd, 'check.sh')), true);
  await sched.update({ scheduleId: sc.id, check: './other.sh' });
  assert.equal(runsAsCode(path.join(cwd, 'other.sh')), true, 'the new check');
  assert.equal(runsAsCode(path.join(cwd, 'check.sh')), false, 'the old one no longer runs');
  await sched.update({ scheduleId: sc.id, paused: true });
  assert.equal(runsAsCode(path.join(cwd, 'other.sh')), true, 'paused, Resume runs it again without a new approval');
  await sched.delete(sc.id);
  assert.equal(runsAsCode(path.join(cwd, 'other.sh')), false, 'gone');
});

test("a check that runs something that can't be followed makes every edit in its repo ask, and none outside it", async () => {
  const { sched, root, cwd, runsAsCode } = await setup();
  put(path.join(root, 'elsewhere', 'notes.md'), 'x\n');
  await sched.create({ text: 'Look', cron: '*/5 * * * *', cwd, check: 'sh -c "$(cat ./list.txt)"' });
  assert.equal(runsAsCode(path.join(cwd, 'README.md')), 'unsure');
  assert.equal(runsAsCode(path.join(root, 'elsewhere', 'notes.md')), false);
});
