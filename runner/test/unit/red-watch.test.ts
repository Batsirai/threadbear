// One thread to fix a watched workflow gone red on main, told when it fails
// again and when it passes (red-watch.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { FRESH_MS, type Gh } from '../../src/land-gate.ts';
import { readWatch, watchDir, watchRed, type FixThreads, type FixThreadState } from '../../src/red-watch.ts';

const WORKFLOW = `# tb land: hold while red
name: Desktop app
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 60
`;

function repo(): string {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/desktop.yml'), WORKFLOW);
  fs.writeFileSync(path.join(root, '.github/workflows/other.yml'), WORKFLOW.replace('# tb land: hold while red\n', ''));
  return root;
}

const run = (id: number, conclusion: string, at: string) => ({ databaseId: id, status: 'completed', conclusion, headSha: `${id}abcdef0123`, url: `https://github.com/o/r/actions/runs/${id}`, createdAt: at, updatedAt: at, displayTitle: `Commit ${id}` });

// GitHub, whose runs on main the test changes as it goes.
function github() {
  const s = { runs: [] as object[], jobs: {} as Record<number, object[]>, calls: 0 };
  const gh: Gh = async (args) => {
    s.calls++;
    if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(s.runs), stderr: '' };
    return { ok: true, stdout: JSON.stringify({ jobs: s.jobs[Number(args[2])] ?? [] }), stderr: '' };
  };
  return { s, gh };
}

// The runner: threads started and messages sent.
function runner() {
  const started: { id: string; text: string; why: string; cwd: string }[] = [];
  const sent: { thread: string; text: string }[] = [];
  const states = new Map<string, FixThreadState>();
  let fail = false;
  const threads: FixThreads = {
    state: async (id) => states.get(id) ?? 'gone',
    start: async (p) => {
      if (fail) throw new Error('runner went away');
      const id = `thread-${started.length + 1}`;
      started.push({ id, ...p });
      states.set(id, 'open');
      return id;
    },
    send: async (thread, text) => void sent.push({ thread, text }),
  };
  return { threads, started, sent, states, failNext: (v: boolean) => (fail = v) };
}

test('a red stretch gets one fix thread, told when it fails again and when it passes', async () => {
  const root = repo();
  let now = Date.parse('2026-11-24T00:00:00Z');
  const cache = { dir: path.join(tmpDir(), 'gate'), now: () => now };
  const { s, gh } = github();
  const r = runner();
  const look = async () => {
    now += FRESH_MS + 1;
    return watchRed(root, { gh, threads: r.threads, cache, now: () => now });
  };

  // Green: nothing to do.
  s.runs = [run(1, 'success', '2026-11-24T00:00:00Z')];
  assert.deepEqual(await look(), []);
  assert.equal(readWatch(cache.dir, 'desktop.yml')?.state, 'green');

  // Red: one thread, in the repo's checkout, saying what failed and how to go on.
  s.runs = [run(2, 'failure', '2026-11-24T01:00:00Z'), ...s.runs];
  s.jobs[2] = [{ name: 'Windows', conclusion: 'failure', steps: [{ name: 'Link', conclusion: 'failure' }] }];
  assert.deepEqual(await look(), ['Desktop app (desktop.yml) is red on main: started fix thread thread-1.']);
  assert.equal(r.started.length, 1);
  const first = r.started[0];
  assert.equal(first.cwd, root);
  assert.equal(first.why, 'desktop.yml red on main');
  assert.match(first.text, /^Desktop app \(desktop\.yml\) is red on main\. Find out why, fix it in your worktree and land the fix with tb land\./);
  assert.match(first.text, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/2 \(2abcdef0: Commit 2,/);
  assert.match(first.text, /Failed: Windows \(Link\)/);
  assert.match(first.text, /gh run view 2 --log-failed/);
  assert.match(first.text, /gh run rerun 2 --failed/);

  // The same run again, however often it's looked at: nothing more.
  assert.deepEqual(await look(), []);
  assert.deepEqual(await look(), []);
  assert.equal(r.started.length, 1);
  assert.equal(r.sent.length, 0);

  // A newer run fails too: told to the same thread, not a new one.
  s.runs = [run(3, 'failure', '2026-11-24T02:00:00Z'), ...s.runs];
  await look();
  assert.equal(r.started.length, 1);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].thread, 'thread-1');
  assert.match(r.sent[0].text, /^Desktop app \(desktop\.yml\) failed on main again: https:\/\/github\.com\/o\/r\/actions\/runs\/3/);

  // Green again: the thread hears it, once.
  s.runs = [run(4, 'success', '2026-11-24T03:00:00Z'), ...s.runs];
  await look();
  await look();
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[1].thread, 'thread-1');
  assert.match(r.sent[1].text, /^Desktop app \(desktop\.yml\) is green on main again: https:\/\/github\.com\/o\/r\/actions\/runs\/4/);

  // Red again while that thread is still open: it's told, rather than a second one starting.
  s.runs = [run(5, 'failure', '2026-11-24T04:00:00Z'), ...s.runs];
  await look();
  assert.equal(r.started.length, 1);
  assert.equal(r.sent[2].thread, 'thread-1');
  assert.match(r.sent[2].text, /is red on main again\./);

  // Green, the thread archived, then red: a new stretch gets a new thread.
  s.runs = [run(6, 'success', '2026-11-24T05:00:00Z'), ...s.runs];
  await look();
  r.states.set('thread-1', 'archived');
  s.runs = [run(7, 'failure', '2026-11-24T06:00:00Z'), ...s.runs];
  await look();
  assert.equal(r.started.length, 2);
  assert.equal(readWatch(cache.dir, 'desktop.yml')?.state, 'red');

  // Its thread deleted: nothing more is sent to it, nor started again for this stretch.
  r.states.delete('thread-2');
  const before = r.sent.length;
  s.runs = [run(8, 'failure', '2026-11-24T07:00:00Z'), ...s.runs];
  await look();
  s.runs = [run(9, 'success', '2026-11-24T08:00:00Z'), ...s.runs];
  await look();
  assert.equal(r.started.length, 2);
  assert.equal(r.sent.length, before);
  // The unmarked workflow was never asked about.
  assert.equal(fs.readdirSync(cache.dir).filter((n) => n.startsWith('other')).length, 0);
});

test("a thread that couldn't be started is tried again next look, and two looks at once start one", async () => {
  const root = repo();
  let now = Date.parse('2026-11-24T00:00:00Z');
  const cache = { dir: path.join(tmpDir(), 'gate'), now: () => now };
  const { s, gh } = github();
  s.runs = [run(2, 'failure', '2026-11-24T01:00:00Z')];
  const r = runner();
  r.failNext(true);
  await assert.rejects(watchRed(root, { gh, threads: r.threads, cache, now: () => now }), /couldn't start or tell a fix thread[\s\S]*runner went away/);
  assert.equal(readWatch(cache.dir, 'desktop.yml'), undefined);
  r.failNext(false);

  // Another look has the workflow: this one leaves it alone.
  const lock = path.join(watchDir(cache.dir), 'desktop.yml.lock');
  fs.writeFileSync(lock, '1');
  assert.deepEqual(await watchRed(root, { gh, threads: r.threads, cache, now: () => now }), ['Desktop app (desktop.yml): another look has it.']);
  assert.equal(r.started.length, 0);
  // One left by a look that died goes after a few minutes.
  const old = new Date(Date.now() - 6 * 60_000);
  fs.utimesSync(lock, old, old);
  const both = await Promise.all([watchRed(root, { gh, threads: r.threads, cache, now: () => now }), watchRed(root, { gh, threads: r.threads, cache, now: () => now })]);
  assert.equal(r.started.length, 1, both.flat().join('\n'));
  assert.ok(!fs.existsSync(lock));
});
