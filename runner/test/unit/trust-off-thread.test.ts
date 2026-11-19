// The trust worker (trust-off-thread.ts): the same answers as on the main
// thread, a look shared only where it may be, and a stuck worker replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCommands, CLAUDE_PATCH_ID } from '../../src/claude-trust.ts';
import { PatchTrust, TRUST_ALL } from '../../src/patch-trust.ts';
import { TrustOffThread } from '../../src/trust-off-thread.ts';
import { codeOfUnhashedPatch } from '../../src/unhashed-scan.ts';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { until } from '../helpers/worktrees-harness.ts';

function hooked(folder: string): string {
  fs.mkdirSync(path.join(folder, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.claude', 'hooks', 'start.mjs'), 'console.log("hi")\n');
  const settings = path.join(folder, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/start.mjs' }] }] } }));
  return settings;
}

test('a look on the worker finds what the same look on this thread does', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const root = tmpDir();
  const folder = path.join(root, 'cloned');
  hooked(folder);
  // A nested skill outside git, found by the walk.
  fs.mkdirSync(path.join(folder, 'a', 'b', '.claude', 'skills', 'go'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'a', 'b', '.claude', 'skills', 'go', 'SKILL.md'), '---\nname: go\nhooks:\n  Stop: node x.mjs\n---\n');
  for (const grants of [false, true]) {
    const here = claudeCommands(folder, root, { grants });
    assert.ok(here?.files.length);
    assert.deepEqual(await off.claudeCommands(folder, root, [grants], 'urgent'), [here]);
    assert.deepEqual(await off.claudeCommands(folder, root, [grants], 'background'), [here]);
  }
  // Both kinds in one call, in the order asked.
  assert.deepEqual(await off.claudeCommands(folder, root, [false, true], 'urgent'), [claudeCommands(folder, root, {}), claudeCommands(folder, root, { grants: true })]);
  assert.deepEqual(await off.claudeCommands(path.join(root, 'nothing'), root, [false], 'background'), [undefined]);

  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, `const cmd = ['ec', 'ho'].join('');\nexport default { actions: [{ title: 'Go', run: cmd + ' hi' }] };\n`);
  const scan = codeOfUnhashedPatch(patch, folder, 0);
  assert.deepEqual(await off.editsAsk(patch, folder, 0), { all: scan.all, ...(scan.why ? { why: scan.why } : {}) });
});

test('the background lane shares a look under way; the urgent lane never does', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const root = tmpDir();
  hooked(root + '/f');
  const f = path.join(root, 'f');
  const a = off.claudeCommands(f, root, [false], 'background');
  const b = off.claudeCommands(f, root, [false], 'background');
  assert.equal(a, b);
  // Another kind of thread is another look.
  assert.notEqual(off.claudeCommands(f, root, [true], 'background'), a);
  const u1 = off.claudeCommands(f, root, [false], 'urgent');
  const u2 = off.claudeCommands(f, root, [false], 'urgent');
  assert.notEqual(u1, u2);
  await Promise.all([a, u1, u2]);
  // Once it's done, the next is a fresh look: it sees a change.
  fs.rmSync(path.join(f, '.claude'), { recursive: true });
  assert.deepEqual(await off.claudeCommands(f, root, [false], 'background'), [undefined]);
});

test('a worker that never answers is given up on, and the next call gets a new one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'silent.mjs');
  fs.writeFileSync(script, "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => {});\n");
  const off = new TrustOffThread({ timeoutMs: 300, script: new URL(`file://${script}`) });
  t.after(() => off.close());
  await assert.rejects(off.claudeCommands(dir, dir, [false], 'urgent'), /took over/);
  await assert.rejects(off.claudeCommands(dir, dir, [false], 'urgent'), /took over/);
});

test("a worker that can't start leaves the look to this thread, as before", async (t) => {
  const off = new TrustOffThread({ script: new URL('file:///nonexistent/trust-worker.mjs') });
  t.after(() => off.close());
  const root = tmpDir();
  const settings = hooked(path.join(root, 'f'));
  const [got] = await off.claudeCommands(path.join(root, 'f'), root, [false], 'urgent');
  assert.deepEqual(got?.files, [settings]);
});

// A worker that hangs on a folder named "hang", stops on one named
// "crash", and otherwise answers at once.
function picky(dir: string): URL {
  const script = path.join(dir, 'picky.mjs');
  fs.writeFileSync(
    script,
    "import { parentPort } from 'node:worker_threads';\n" +
      "parentPort.postMessage({ ready: true });\n" +
      "parentPort.on('message', (r) => {\n" +
      "  if (r.cwd.endsWith('hang')) return;\n" +
      "  if (r.cwd.endsWith('crash')) process.exit(1);\n" +
      "  parentPort.postMessage({ id: r.id, ok: true, value: [r.cwd] });\n" +
      "});\n",
  );
  return new URL(`file://${script}`);
}

test("one folder that hangs fails its own look alone: the looks queued behind it go to a new worker, with their own time limit", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ timeoutMs: 400, script: picky(dir) });
  t.after(() => off.close());
  const hung = off.claudeCommands('/x/hang', dir, [false], 'urgent');
  const after = [1, 2, 3].map((i) => off.claudeCommands(`/x/ok${i}`, dir, [false], 'urgent'));
  await assert.rejects(hung, /Looking at \/x\/hang took over/);
  // Each waited longer than one time limit in all, but none was cut short.
  assert.deepEqual(await Promise.all(after), [['/x/ok1'], ['/x/ok2'], ['/x/ok3']]);
});

test('a worker that stops partway fails only the look it was on, which is never run again on this thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ script: picky(dir) });
  t.after(() => off.close());
  assert.deepEqual(await off.claudeCommands('/x/first', dir, [false], 'urgent'), ['/x/first']);
  const crash = off.claudeCommands('/x/crash', dir, [false], 'urgent');
  const next = off.claudeCommands('/x/next', dir, [false], 'urgent');
  await assert.rejects(crash, /trust worker stopped/);
  assert.deepEqual(await next, ['/x/next']);
});

test('closing fails what is waiting rather than running it on this thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ script: picky(dir) });
  const a = off.claudeCommands('/x/hang', dir, [false], 'urgent');
  const b = off.claudeCommands('/x/ok', dir, [false], 'urgent');
  off.close();
  await assert.rejects(a, /closed/);
  await assert.rejects(b, /closed/);
});

test('runner with the worker: an untrusted folder starts its CLI without the settings, shows them in Patches, and trusting them gives the next CLI them', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const root = tmpDir();
  const project = path.join(root, 'cloned');
  const settings = hooked(project);
  const home = tmpDir();
  const h = makeHarness(home, {}, { panelsRoot: root, offThread: off, patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: root, offThread: off }) });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project });
  await until(() => Boolean(h.adapter.sessions.length), 'the CLI to start');
  const s = h.adapter.last;
  assert.deepEqual(s.opts.untrustedProjectSettings, {});
  await until(() => Boolean(h.runner.get(thread.id).patches?.some((p) => p.id === CLAUDE_PATCH_ID)), 'Patches to list the settings');
  const waiting = h.runner.get(thread.id).patches!.find((p) => p.id === CLAUDE_PATCH_ID)!;
  assert.equal(waiting.file, settings);
  assert.equal(waiting.untrusted, 'new');

  s.init();
  s.result('completed');
  await tick();
  await h.runner.trustPatches(thread.id, [{ file: waiting.file!, hash: waiting.hash! }]);
  await until(() => !h.runner.get(thread.id).patches?.some((p) => p.id === CLAUDE_PATCH_ID), 'Patches to drop it');
  h.runner.send(thread.id, 'again');
  await until(() => h.adapter.last !== s, 'a fresh CLI');
  assert.equal(h.adapter.last.opts.untrustedProjectSettings, undefined);
});

test("a message sent while the turn's look at the folder is under way waits for that turn, never reaching the CLI first", async (t) => {
  let hold: Promise<void> | undefined;
  let release = () => {};
  const looks: string[] = [];
  const trust = {
    ...TRUST_ALL,
    lookClaude: async (cwd: string, opts: { grants?: boolean } = {}) => {
      looks.push(cwd);
      if (hold) await hold;
      return { cwd, grants: opts.grants === true, found: undefined };
    },
  };
  const off = new TrustOffThread();
  t.after(() => off.close());
  const h = makeHarness(tmpDir(), {}, { patchTrust: trust, offThread: off });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const s = h.adapter.last;
  s.init();
  s.result('completed');
  await tick();
  hold = new Promise((r) => (release = () => r()));
  const before = looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => looks.length > before, 'the look to start');
  h.runner.send(thread.id, 'and this');
  await tick();
  // Not steered into the CLI ahead of "again".
  assert.deepEqual(s.sent.slice(1).map((m) => m.text), []);
  release();
  await until(() => s.sent.length >= 2, '"again" to reach the CLI');
  assert.match(s.sent[1].text, /again/);
  assert.ok(!s.sent[1].text.includes('and this'));
});

// A trust store whose looks can be held, failed and counted, with the
// checks it makes after them.
function heldTrust() {
  const o = {
    hold: undefined as Promise<void> | undefined,
    fail: undefined as Error | undefined,
    looks: [] as { at: number }[],
    checks: [] as { look: boolean }[],
    trust: undefined as unknown as typeof TRUST_ALL,
  };
  let n = 0;
  o.trust = {
    ...TRUST_ALL,
    lookClaude: async (cwd: string, opts: { grants?: boolean } = {}) => {
      o.looks.push({ at: ++n });
      if (o.hold) await o.hold;
      if (o.fail) throw o.fail;
      return { cwd, grants: opts.grants === true, found: undefined };
    },
    checkClaude: (_cwd: string, _opts?: unknown, look?: unknown) => {
      o.checks.push({ look: look !== undefined });
      return { trusted: true as const };
    },
  };
  return o;
}

async function warmThread(t: { after: (f: () => void) => void }, trust: typeof TRUST_ALL) {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const h = makeHarness(tmpDir(), {}, { patchTrust: trust, offThread: off });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const s = h.adapter.last;
  s.init();
  s.result('completed');
  await until(() => !h.runner.threads.get(thread.id)!.rt.turn, 'the turn to end');
  return { h, s, thread };
}

test('a CLI started after the old one closes gets a look taken after it closed, not before', async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  s.slowExit = true;
  h.runner.threads.get(thread.id)!.rt.releaseWhenIdle = true;
  h.runner.send(thread.id, 'again');
  await until(() => s.ended, 'the old CLI asked to end');
  const before = o.looks.length;
  await tick();
  assert.equal(h.adapter.sessions.length, 1, 'waits for the old CLI');
  s.exit();
  await until(() => h.adapter.sessions.length === 2, 'the new CLI');
  assert.ok(o.looks.length > before, 'looked again once the old CLI had gone');
  // Its check used that look, not one from before the wait.
  assert.equal(o.checks.at(-1)?.look, true);
});

test('Stop while the look runs ends the turn without sending the message', async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  const before = o.looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => o.looks.length > before, 'the look');
  h.runner.interrupt(thread.id, { byMike: true });
  release();
  await until(() => !h.runner.threads.get(thread.id)!.rt.turn, 'the turn to end');
  assert.deepEqual(s.sent.slice(1), []);
  assert.equal(h.adapter.sessions.length, 1);
});

test("a look that fails fails the turn, rather than looking again on the runner's main thread", async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  o.fail = new Error('Looking at /x took over 120 s.');
  const checks = o.checks.length;
  h.runner.send(thread.id, 'again');
  await until(() => !h.runner.threads.get(thread.id)!.rt.turn, 'the turn to end');
  assert.equal(o.checks.length, checks, 'no check without a look');
  assert.deepEqual(s.sent.slice(1), []);
  assert.ok(h.events(thread.id).some((e) => JSON.stringify(e).includes("Couldn't read this folder's Claude Code settings")));
});

test("the CLI's own turn ending while a message waits on the look leaves that message to be sent, not dropped", async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  const before = o.looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => o.looks.length > before, 'the look');
  // A background task woke the CLI, and its own turn ends now.
  s.result('completed', undefined, undefined, { own: true, queuedTurns: 0 });
  await tick();
  assert.ok(h.runner.threads.get(thread.id)!.rt.turn, 'the turn waits for its message');
  assert.ok(!h.events(thread.id).some((e) => JSON.stringify(e).includes('was dropped by the CLI')));
  release();
  await until(() => s.sent.length >= 2, '"again" to reach the CLI');
  assert.match(s.sent[1].text, /again/);
});
