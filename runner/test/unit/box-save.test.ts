// A box's save and restore (src/box-save.ts, docs/protocol.md "Box mode"):
// the `save` command packs the thread (its folder, its transcript, its git
// work with what's uncommitted), seals it with the thread's key, uploads it
// and names it in boxSaved; a new box restores it on a fresh clone and the
// thread carries on in the same session. A fake backend, real git in temp
// repos, the runner on fake CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir, type Harness } from '../helpers/fakes.ts';
import { localClone, originRepo, sh } from '../helpers/box-git.ts';
import { nullLogger } from '../../src/log.ts';
import { paths } from '../../src/config.ts';
import { projectDirName } from '../../src/transcripts.ts';
import { openSave, restoreSave, saveThread, sealSave, SAVE_MAX_BYTES, type SaveLimits } from '../../src/box-save.ts';
import { prepareBoxFolder, writeBoxSecrets, type BoxSecrets } from '../../src/box-mode.ts';

const THREAD = 'b0c0ffee-1111-4222-8333-444455556666';
const KEY = crypto.randomBytes(32);
const BOX_KEY = `tbb_${'b'.repeat(64)}`;

async function until(check: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a save opens only with its thread's key, as that thread's, untouched", () => {
  const plain = Buffer.from('the thread');
  const sealed = sealSave(KEY, THREAD, plain);
  assert.deepEqual(openSave(KEY, THREAD, sealed), plain);
  assert.throws(() => openSave(KEY, 'another-thread', sealed), /doesn't open/);
  assert.throws(() => openSave(crypto.randomBytes(32), THREAD, sealed), /doesn't open/);
  const bent = Buffer.from(sealed);
  bent[20]! ^= 1;
  assert.throws(() => openSave(KEY, THREAD, bent), /doesn't open/);
  assert.throws(() => openSave(KEY, THREAD, Buffer.alloc(10)), /too short/);
  // Two seals of the same bytes differ (a fresh IV each time).
  assert.notDeepEqual(sealSave(KEY, THREAD, plain), sealed);
});

function secretsFor(origin: string, over: Partial<BoxSecrets> = {}): BoxSecrets {
  return { version: 1, bootHash: 'h', syncUrl: 'https://dep.convex.cloud', boxKey: BOX_KEY, runnerId: 'box0thread01', threadId: THREAD, threadKey: KEY.toString('base64'), repo: { origin, subfolder: 'runner', baseBranch: 'main' }, save: null, ...over };
}

// A box: its data dir, its claude-main folder, its clone, and a runner on it.
async function boxOn(origin: string, save: BoxSecrets['save'], stored?: Map<string, Buffer>, opts: { holdForSetup?: boolean } = {}) {
  const home = tmpDir('tb-box-home-');
  const claudeDir = path.join(tmpDir('tb-box-claude-'), '.claude');
  const workRoot = tmpDir('tb-box-work-');
  const s = secretsFor(origin, { save });
  writeBoxSecrets(home, s);
  const folder = await prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir, workRoot, log: nullLogger, clone: localClone, download: async (url) => stored!.get(url)! });
  const h = makeHarness(home, { defaults: { cwd: folder.cwd } as never }, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000, boxThread: THREAD, boxSetupPending: opts.holdForSetup ?? false });
  return { home, claudeDir, folder, h };
}

// The backend's side of a save: an upload URL, the upload, boxSaved.
function fakeBackend() {
  const stored = new Map<string, Buffer>();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    stored,
    calls,
    post: async (_kind: 'mutation', fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return fn === 'sync:iconUploadUrl' ? 'https://dep.convex.site/runner/upload?ticket=1' : null;
    },
    upload: async (url: string, bytes: Uint8Array, mediaType: string) => {
      assert.equal(url, 'https://dep.convex.site/runner/upload?ticket=1');
      assert.equal(mediaType, 'application/octet-stream');
      const id = `storage${stored.size + 1}`;
      stored.set(`https://dep.convex.cloud/api/storage/${id}`, Buffer.from(bytes));
      return id;
    },
  };
}

function save(h: Harness, b: { home: string; claudeDir: string }, backend: Pick<ReturnType<typeof fakeBackend>, 'post' | 'upload'>, limits?: SaveLimits) {
  return saveThread({ home: b.home, claudeDir: b.claudeDir, threadId: THREAD, threadKey: KEY, boxKey: BOX_KEY, quiesce: (id) => h.runner.quiesceForSave(id), resume: (id) => h.runner.releaseTurns(id, 'save'), post: backend.post, upload: backend.upload, ...(limits ? { limits } : {}) });
}

// The thread's first turn on the fake CLI, ended.
async function firstTurn(h: Harness, cwd: string) {
  h.runner.create({ text: 'Go', accountId: 'claude-main', cwd, id: THREAD });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  h.adapter.last.init();
  h.adapter.last.result();
  return h.runner.get(THREAD);
}

function transcriptFor(claudeDir: string, cwd: string, sid: string): string {
  return path.join(claudeDir, 'projects', projectDirName(fs.realpathSync(cwd)), `${sid}.jsonl`);
}

test('a save round trip: what a new box restores is the thread as it was, its commits, its uncommitted work and its session', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  const t = await firstTurn(a.h, a.folder.cwd);
  assert.equal(t.cwd, a.folder.cwd);
  const sid = a.h.runner.threads.get(THREAD)!.rec.nativeSessionId!;
  // The agent's work: a commit, an edit, a new file; and the session's transcript.
  const top = a.folder.checkout;
  sh(top, 'echo b > runner/b.txt && git add -A && git commit -qm "the agent\'s commit"');
  fs.writeFileSync(path.join(top, 'README.md'), 'one, edited\n');
  fs.writeFileSync(path.join(top, 'runner', 'new.txt'), 'untracked\n');
  const transcript = transcriptFor(a.claudeDir, a.folder.cwd, sid);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user","message":"Go"}\n');
  fs.mkdirSync(path.join(path.dirname(transcript), sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(transcript), sid, 'subagents', 'agent-1.jsonl'), '{"sub":1}\n');

  const backend = fakeBackend();
  const done = await save(a.h, a, backend);
  assert.deepEqual(backend.calls.map((c) => c.fn), ['sync:iconUploadUrl', 'boxes:boxSaved']);
  const [url, sealed] = [...backend.stored][0]!;
  assert.deepEqual(backend.calls[1]!.args, { key: BOX_KEY, storageId: 'storage1', bytes: sealed.length });
  assert.equal(done.bytes, sealed.length);
  // Sealed: none of the thread's words in the clear.
  assert.ok(!sealed.includes(Buffer.from('untracked')));
  assert.ok(!sealed.includes(Buffer.from(THREAD)));
  // The box's own copy is untouched by saving, and its CLI still there.
  assert.equal(sh(top, "git status --porcelain | sed 's/^/|/'"), '| M README.md\n|?? runner/new.txt');

  // A new box for the thread, from the save.
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(b.folder.restored, true);
  const btop = b.folder.checkout;
  assert.notEqual(btop, top);
  assert.equal(b.folder.cwd, path.join(btop, 'runner'));
  assert.equal(sh(btop, 'git log -1 --format=%s'), "the agent's commit");
  assert.equal(fs.readFileSync(path.join(btop, 'runner', 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.readFileSync(path.join(btop, 'README.md'), 'utf8'), 'one, edited\n');
  assert.equal(fs.readFileSync(path.join(btop, 'runner', 'new.txt'), 'utf8'), 'untracked\n');
  // Uncommitted and untracked again, not committed.
  assert.equal(sh(btop, "git status --porcelain | sed 's/^/|/'"), '| M README.md\n|?? runner/new.txt');
  // The transcript, where Claude Code looks for the folder it now runs in.
  assert.equal(fs.readFileSync(transcriptFor(b.claudeDir, b.folder.cwd, sid), 'utf8'), '{"type":"user","message":"Go"}\n');
  assert.ok(fs.existsSync(path.join(path.dirname(transcriptFor(b.claudeDir, b.folder.cwd, sid)), sid, 'subagents', 'agent-1.jsonl')));
  // The thread itself, loaded by the new box's runner, in the new folder.
  const restored = b.h.runner.get(THREAD);
  assert.equal(restored.cwd, b.folder.cwd);
  assert.equal(restored.title, t.title);
  assert.ok(b.h.runner.events(THREAD, {}).events.some((e) => e.type === 'user.message'));
  // Its next turn resumes the same session.
  b.h.runner.send(THREAD, 'And again', []);
  await until(() => b.h.adapter.sessions.length === 1, 'the CLI to start');
  assert.equal(b.h.adapter.last.opts.sessionId, sid);
  assert.equal(b.h.adapter.last.opts.resume, true);
  assert.equal(b.h.adapter.last.opts.cwd, b.folder.cwd);
  // And it's the box's one thread: another can't be made.
  assert.throws(() => b.h.runner.create({ text: 'x', cwd: b.folder.cwd, accountId: 'claude-main', id: THREAD }), /box for one thread/);
});

const WORKTREE_PATCH = 'export default { worktree: { setup: "mkdir -p node_modules && echo $PWD > node_modules/ran" } };\n';

test("a thread in a worktree comes back in its worktree, on its branch, and the worktree's setup runs again", async () => {
  const origin = originRepo({ patch: WORKTREE_PATCH });
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const w = a.h.runner.get(THREAD).worktree!;
  assert.ok(w, 'a worktree, as a new thread in that repo gets');
  await until(() => fs.existsSync(path.join(w.path, 'node_modules', 'ran')), 'its setup');
  sh(w.path, 'echo wip > runner/wip.txt && echo committed > runner/c.txt && git add runner/c.txt && git commit -qm "on the branch"');
  const backend = fakeBackend();
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  // Installed packages stay behind (they're made again).
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  const rec = b.h.runner.threads.get(THREAD)!.rec;
  const bw = rec.worktree!;
  assert.equal(bw.mainCheckout, b.folder.checkout);
  assert.equal(path.dirname(bw.path), `${b.folder.checkout}-threads`);
  assert.equal(path.basename(bw.path), path.basename(w.path));
  assert.equal(bw.branch, w.branch);
  assert.equal(rec.cwd, path.join(bw.path, 'runner'));
  assert.equal(sh(bw.path, 'git rev-parse --abbrev-ref HEAD'), w.branch);
  assert.equal(sh(bw.path, 'git log -1 --format=%s'), 'on the branch');
  assert.equal(fs.readFileSync(path.join(bw.path, 'runner', 'wip.txt'), 'utf8'), 'wip\n');
  assert.equal(sh(bw.path, 'git status --porcelain'), '?? runner/wip.txt');
  assert.ok(!fs.existsSync(path.join(bw.path, 'node_modules')));
  await b.h.runner.setUpRestored(THREAD);
  assert.equal(fs.readFileSync(path.join(bw.path, 'node_modules', 'ran'), 'utf8').trim(), fs.realpathSync(bw.path));
});

test('a save bigger than one upload fails the command saying so, and nothing is uploaded', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  // Incompressible, so the gzip can't take it under.
  fs.writeFileSync(path.join(a.folder.checkout, 'runner', 'big.bin'), crypto.randomBytes(SAVE_MAX_BYTES + 1024));
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend), /more than one upload takes \(10\.0 MB\), and saves in parts aren't built yet/);
  assert.deepEqual(backend.calls, []);
  assert.equal(backend.stored.size, 0);
});

test("a save the backend refuses fails the command, and one for a thread that isn't here says so", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await assert.rejects(save(a.h, a, fakeBackend()), /nothing to save/);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  const refused = { ...backend, post: async (_k: 'mutation', fn: string, args: Record<string, unknown>) => {
    if (fn === 'boxes:boxSaved') throw Object.assign(new Error("The box is asleep, so it can't save now."), { data: { kind: 'conflict' } });
    return backend.post(_k, fn, args);
  } };
  await assert.rejects(save(a.h, a, refused), /can't save now/);
  // A save that won't open (another thread's) is refused on restore, and the box doesn't start.
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  const wrong = secretsFor(origin, { threadKey: crypto.randomBytes(32).toString('base64'), save: { url, at: 1, bytes: sealed.length } });
  const home = tmpDir();
  writeBoxSecrets(home, wrong);
  await assert.rejects(prepareBoxFolder({ secrets: wrong, fresh: true, home, claudeDir: tmpDir(), workRoot: tmpDir(), log: nullLogger, clone: localClone, download: async () => sealed }), /doesn't open/);
  assert.equal(fs.existsSync(paths.thread(home, THREAD)), false);
});

test('a save stops the thread first: its turn interrupted, its CLI and background jobs stopped, and no turn starts after it until the box is woken', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  // A turn running when the save comes (one past its day's hours, or archived).
  a.h.runner.send(THREAD, 'Keep going', []);
  await until(() => a.h.adapter.sessions.length === 1 && Boolean(a.h.runner.threads.get(THREAD)!.rt.turn), 'the second turn');
  const s = a.h.adapter.last;
  const backend = fakeBackend();
  let saving = true;
  const done = save(a.h, a, backend).finally(() => (saving = false));
  await until(() => s.interrupts === 1, 'the interrupt');
  // Nothing goes up while the turn is still going.
  await tick(10);
  assert.equal(saving, true);
  assert.equal(backend.calls.length, 0);
  s.result('interrupted');
  await done;
  assert.equal(s.ended, true, 'the CLI is stopped before the copy is taken');
  assert.deepEqual(backend.calls.map((c) => c.fn), ['sync:iconUploadUrl', 'boxes:boxSaved']);
  // Frozen: a message waits rather than changing the folder behind the acknowledged save.
  a.h.runner.send(THREAD, 'after the save', []);
  await tick(10);
  assert.equal(a.h.adapter.sessions.length, 1);
  assert.equal(a.h.runner.threads.get(THREAD)!.rec.queue.length, 1);
  // Woken (resumed, or sent something): it goes.
  a.h.runner.releaseTurns(THREAD, 'save');
  await until(() => a.h.adapter.sessions.length === 2, 'the queued turn');
});

test('a save that fails lets the thread carry on', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  const refusing = { upload: backend.upload, post: async (k: 'mutation', fn: string, args: Record<string, unknown>) => {
    if (fn === 'boxes:boxSaved') throw new Error('network down');
    return backend.post(k, fn, args);
  } };
  await assert.rejects(save(a.h, a, refusing), /network down/);
  a.h.runner.send(THREAD, 'carry on', []);
  await until(() => a.h.adapter.sessions.length === 2, 'the next turn');
});

test('installed packages a restore would refuse are left out of the save, so every acknowledged save restores', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  // node_modules no longer ignored, and one installed under runner/: untracked, as unpackGit refuses.
  sh(top, 'git rm -q .gitignore && git commit -qm "no ignores"');
  fs.mkdirSync(path.join(top, 'runner', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(top, 'runner', 'kept.txt'), 'kept\n');
  const backend = fakeBackend();
  const done = await save(a.h, a, backend);
  assert.deepEqual(done.leftOut, ['runner/node_modules/pkg/index.js']);
  const [url, sealed] = [...backend.stored][0]!;
  a.h.runner.releaseTurns(THREAD, 'save');
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(fs.readFileSync(path.join(b.folder.checkout, 'runner', 'kept.txt'), 'utf8'), 'kept\n');
  assert.equal(fs.existsSync(path.join(b.folder.checkout, 'runner', 'node_modules')), false);
  // The box's own copy still has them.
  assert.ok(fs.existsSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js')));
});

test("a save past what a restore takes (files, or size unpacked) fails before it's uploaded, and a restore holds to its own limit", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend, { maxEntries: 3 }), /files, more than a restore takes \(3\)/);
  await assert.rejects(save(a.h, a, backend, { maxUnpacked: 1000 }), /before it's compressed, more than a restore takes/);
  assert.deepEqual(backend.calls, []);
  // One within the writer's limits, read by a box allowing less: refused, nothing written.
  await save(a.h, a, backend);
  const sealed = [...backend.stored.values()][0]!;
  const home = tmpDir();
  await assert.rejects(restoreSave({ home, claudeDir: tmpDir(), threadId: THREAD, checkout: a.folder.checkout, packed: openSave(KEY, THREAD, sealed), limits: { maxUnpacked: 1000 } }), /not a gzip, or too big/);
  assert.equal(fs.existsSync(paths.thread(home, THREAD)), false);
});

const FAILING_PATCH = 'export default { worktree: { setup: "test -f runner/ok.txt || exit 3; mkdir -p node_modules" } };\n';

test("a restored thread's turns wait for its worktree's setup; one that fails says so, and the turn goes ahead", async () => {
  for (const passes of [true, false]) {
    const origin = originRepo({ patch: passes ? WORKTREE_PATCH : FAILING_PATCH });
    const a = await boxOn(origin, null);
    a.h.runner.create({ text: 'Go', accountId: 'claude-main', cwd: a.folder.cwd, id: THREAD });
    await until(() => a.h.adapter.sessions.length === 1, 'the CLI to start');
    a.h.adapter.last.init();
    a.h.adapter.last.result();
    const backend = fakeBackend();
    await save(a.h, a, backend);
    const [url, sealed] = [...backend.stored][0]!;
    const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored, { holdForSetup: true });
    // Held: recovery, a carry-on or a message can't start a turn before the setup.
    b.h.runner.carryOnStopped();
    b.h.runner.send(THREAD, 'next', []);
    await tick(10);
    assert.equal(b.h.adapter.sessions.length, 0);
    await b.h.runner.setUpRestored(THREAD);
    await until(() => b.h.adapter.sessions.length === 1, 'the turn after the setup');
    const notes = b.h.events(THREAD).filter((e) => e.type === 'system.note').map((e) => String(e.text));
    if (passes) assert.ok(!notes.some((n) => /setup failed/.test(n)));
    else assert.ok(notes.some((n) => /setup failed after this thread was restored/.test(n)), notes.join('\n'));
  }
});
