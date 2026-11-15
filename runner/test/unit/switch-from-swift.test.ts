// desktop/scripts/switch-from-swift.sh, which the Swift app's "Start using
// the new app" thread runs on someone else's Mac. Tried end to end on Tinker
// Desk as a stranger's copy (15 Nov 2026): with no Rust and a cold cache it
// took 31 minutes and about 4 GB, where the thread's brief said 10 minutes
// and 3 GB. Here, with stage-update.sh replaced by a stub on main, so
// nothing is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO, 'desktop', 'scripts', 'switch-from-swift.sh');
const GiB = 1024 * 1024;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// A home with cargo in ~/.cargo/bin (so rustup is never fetched) unless
// noRust, and a checkout whose main has a stage-update.sh that makes an
// empty bundle where it's told to, or exits with stageExit.
function world(o: { noRust?: boolean; warm?: boolean; stageExit?: number } = {}) {
  const root = fs.realpathSync(tmpDir());
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  if (!o.noRust) {
    fs.mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cargo', 'bin', 'cargo'), '#!/bin/sh\n', { mode: 0o755 });
  }
  if (o.warm) fs.mkdirSync(path.join(home, 'Library', 'Caches', 'Threadbear', 'update-desktop', 'target', 'release'), { recursive: true });
  const scripts = path.join(checkout, 'desktop', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const stage = o.stageExit
    ? `#!/bin/bash\necho "stub failed" >&2\nexit ${o.stageExit}\n`
    : '#!/bin/bash\n[ "$2" = --next ] || exit 9\nmkdir -p "$3/Contents"\necho staged\n';
  fs.writeFileSync(path.join(scripts, 'stage-update.sh'), stage);
  git(root, 'init', '-q', '-b', 'main', checkout);
  git(checkout, 'add', '-A');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'stub');
  return { home, checkout };
}

function run(w: { home: string; checkout: string }, freeKb: number) {
  return spawnSync('/bin/bash', [SCRIPT, w.checkout, '--no-open'], {
    encoding: 'utf8',
    env: { HOME: w.home, TMPDIR: path.join(w.home, 'tmp'), PATH: '/usr/bin:/bin', THREADBEAR_SWITCH_FREE_KB: String(freeKb) },
  });
}

test('too little disk for Rust and a first build stops before either, saying how much it needs', () => {
  const w = world({ noRust: true });
  const r = run(w, 3 * GiB);
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stderr, /needs about 5 GB free .* has 3\.0 GB/);
  assert.doesNotMatch(r.stdout, /STEP Installing Rust/);
  assert.equal(fs.existsSync(path.join(w.home, '.cargo')), false);
});

test('with Rust already here a first build needs a little less', () => {
  assert.equal(run(world(), 3 * GiB).status, 6);
  const r = run(world(), 4 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a build cache from an earlier try needs much less', () => {
  const r = run(world({ warm: true }), 2 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('with room it builds, installs into ~/Applications and says a first build takes a while', () => {
  const w = world();
  const r = run(w, 50 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /STEP Building the new app \(a first build takes 20 to 40 minutes/);
  assert.match(r.stdout, /Installed .*Threadbear GPUI\.app/);
  assert.equal(fs.existsSync(path.join(w.home, 'Applications', 'Threadbear GPUI.app', 'Contents')), true);
});

test("a build that couldn't run says what to do in this thread, not that an app will try later", () => {
  const r = run(world({ stageExit: 4 }), 50 * GiB);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /run this again/i);
});
