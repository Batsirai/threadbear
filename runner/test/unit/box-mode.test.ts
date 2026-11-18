// Box mode (src/box-mode.ts, docs/protocol.md "Box mode"): a runner in a
// virtual runner's machine for one thread. Its boot exchange, the secrets
// it keeps, the environment it gives what it starts, the folder it clones,
// its one thread, the machine it names in heartbeats, and what it does when
// a newer box has the thread. A fake backend, real git in temp repos, and
// for the last test the real runner entry point (no CLI is ever spawned).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localClone, originRepo, sh } from '../helpers/box-git.ts';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';
import { readYearToken } from '../../src/year-token.ts';
import { ConvexSync, readSyncKey } from '../../src/sync.ts';
import { paths } from '../../src/config.ts';
import { BOOT_ENV, BoxBootRefused, MACHINE_ID_ENV, bootBox, boxFile, enterBoxEnv, exchangeBoot, prepareBoxFolder, readBoxBoot, readBoxSecrets, repoFolderName, writeBoxSecrets, type ActionPost, type BoxSecrets, type Cloner } from '../../src/box-mode.ts';

const BOOT = `tbt_${'a'.repeat(64)}`;
const BOX_KEY = `tbb_${'b'.repeat(64)}`;
const CLAUDE_TOKEN = `sk-ant-oat01-${'Q'.repeat(60)}`;
const THREAD = 'b0c0ffee-1111-4222-8333-444455556666';
const THREAD_KEY = Buffer.alloc(32, 9).toString('base64');
const URL = 'https://dep.convex.cloud';

function exchanged(over: Record<string, unknown> = {}) {
  return { boxKey: BOX_KEY, runnerId: 'box0thread01', threadId: THREAD, claudeToken: CLAUDE_TOKEN, threadKey: THREAD_KEY, repo: { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'main' }, save: null, login: 'me@example.com', ...over };
}

test('the boot comes from the environment: the token, the backend, and the machine by the variable the service names', () => {
  assert.equal(readBoxBoot({}), undefined);
  assert.equal(readBoxBoot({ THREADBEAR_SYNC_URL: URL }), undefined);
  assert.throws(() => readBoxBoot({ [BOOT_ENV]: BOOT }), BoxBootRefused);
  // The provider's variable, as THREADBEAR_MACHINE_ID_ENV names it.
  assert.deepEqual(readBoxBoot({ [BOOT_ENV]: BOOT, THREADBEAR_SYNC_URL: URL, [MACHINE_ID_ENV]: 'BOX_ID', BOX_ID: 'm-42', FLY_MACHINE_ID: 'other' }), { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' });
  // Not named: Fly's.
  assert.deepEqual(readBoxBoot({ [BOOT_ENV]: BOOT, THREADBEAR_SYNC_URL: URL, FLY_MACHINE_ID: '148e2d4b0e7d98' }), { bootToken: BOOT, syncUrl: URL, machineId: '148e2d4b0e7d98' });
  // An id the backend wouldn't take is left out, not sent.
  assert.deepEqual(readBoxBoot({ [BOOT_ENV]: BOOT, THREADBEAR_SYNC_URL: URL, FLY_MACHINE_ID: 'no spaces;' }), { bootToken: BOOT, syncUrl: URL });
});

test('box mode takes the boot token out of what the runner starts, and turns off what a box has no use for', () => {
  const env: NodeJS.ProcessEnv = { [BOOT_ENV]: BOOT, THREADBARE_BOX_BOOT: BOOT, THREADBEAR_SYNC_URL: URL, THREADBEAR_SYNC: 'off', PATH: '/bin' };
  enterBoxEnv(env);
  assert.equal(env[BOOT_ENV], undefined);
  assert.equal(env.THREADBARE_BOX_BOOT, undefined);
  assert.equal(env.IS_SANDBOX, '1');
  // No following main (self-update), no CLI updates, no Sentry, no Mac screen; the sync stays.
  assert.equal(env.THREADBEAR_FOLLOW_MAIN, '0');
  assert.equal(env.THREADBEAR_CLI_UPDATES, 'off');
  assert.equal(env.THREADBEAR_SENTRY, 'off');
  assert.equal(env.THREADBEAR_MAC_SCREEN, 'off');
  assert.equal(env.THREADBEAR_SYNC, undefined);
  assert.equal(env.THREADBEAR_SYNC_URL, URL);
  assert.ok(!JSON.stringify(env).includes(BOOT));
});

test('the exchange names the machine, and its secrets land 0600: box.json, the box key, and the login token where claude-main reads it', async () => {
  const home = tmpDir('tb-box-home-');
  fs.mkdirSync(paths.secrets(home), { recursive: true, mode: 0o700 });
  const claudeDir = path.join(tmpDir('tb-box-claude-'), '.claude');
  const calls: { kind: string; fn: string; args: Record<string, unknown> }[] = [];
  const post: ActionPost = async (kind, fn, args) => {
    calls.push({ kind, fn, args });
    return exchanged();
  };
  const { secrets: s, fresh } = await bootBox({ boot: { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' }, home, claudeDir, post, log: nullLogger });
  assert.equal(fresh, true);
  // Only the hash of a key: a backend from before boxKeyHash hands back a key of its own (this one does).
  assert.match(String(calls[0]!.args.boxKeyHash), /^[0-9a-f]{64}$/);
  assert.deepEqual(calls, [{ kind: 'action', fn: 'boxes:exchange', args: { bootToken: BOOT, machineId: 'm-42', boxKeyHash: calls[0]!.args.boxKeyHash } }]);
  assert.equal(s.boxKey, BOX_KEY);
  assert.equal(s.runnerId, 'box0thread01');
  assert.equal(s.threadId, THREAD);
  assert.equal(s.threadKey, THREAD_KEY);
  assert.equal(s.login, 'me@example.com');
  assert.equal(s.machineId, 'm-42');
  assert.deepEqual(s.repo, { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'main' });
  // Never the boot token itself, only its hash.
  assert.ok(!fs.readFileSync(boxFile(home), 'utf8').includes(BOOT));
  assert.deepEqual(readBoxSecrets(home), s);
  const mode = (f: string) => fs.statSync(f).mode & 0o777;
  assert.equal(mode(boxFile(home)), 0o600);
  assert.equal(mode(path.join(paths.secrets(home), 'convex-key')), 0o600);
  assert.equal(readSyncKey(home), BOX_KEY);
  const tokenFile = path.join(claudeDir, 'threadbear-token.json');
  assert.equal(mode(tokenFile), 0o600);
  // As a year-long token: the runner hands it to claude-main's CLI and nowhere else.
  assert.equal(readYearToken(claudeDir)?.token, CLAUDE_TOKEN);
  // The Claude token is nowhere in the data dir.
  for (const f of fs.readdirSync(paths.secrets(home))) assert.ok(!fs.readFileSync(path.join(paths.secrets(home), f), 'utf8').includes(CLAUDE_TOKEN));

  // Started again on the same machine (same boot token): no second exchange, as it works once.
  const again = await bootBox({ boot: { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' }, home, claudeDir, post, log: nullLogger });
  assert.equal(calls.length, 1);
  assert.equal(again.secrets.boxKey, BOX_KEY);
  assert.equal(again.fresh, false);
  // A new boot token (a new attempt) trades again.
  await bootBox({ boot: { bootToken: `tbt_${'c'.repeat(64)}`, syncUrl: URL }, home, claudeDir, post, log: nullLogger });
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[1]!.args).sort(), ['bootToken', 'boxKeyHash']);
});

test('a refused boot token stops the box at once; an outage or a deployment not ready yet is tried again, until the token would be dead', async () => {
  const boot = { bootToken: BOOT, syncUrl: URL };
  const err = (kind: string) => Object.assign(new Error(kind), { data: { kind, message: kind } });
  let n = 0;
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, sleep: async () => {}, post: async () => { n++; throw err('auth'); } }), BoxBootRefused);
  assert.equal(n, 1);
  // A network failure, then no cloud token yet, then it works.
  const answers: (() => unknown)[] = [() => { throw new Error('fetch failed'); }, () => { throw err('noCloudToken'); }, () => exchanged()];
  const slept: number[] = [];
  const got = await exchangeBoot({ boot, log: nullLogger, sleep: async (ms) => void slept.push(ms), post: async () => answers.shift()!() });
  assert.equal(got.boxKey, BOX_KEY);
  assert.deepEqual(slept, [2000, 4000]);
  // Past the boot token's 10 minutes: given up.
  let t = 0;
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, now: () => t, sleep: async (ms) => void (t += ms), post: async () => { throw err('config'); } }), /in time/);
  assert.ok(t <= 10 * 60_000);
  // An answer it can't use is refused, not written anywhere.
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ claudeToken: 'not a token' }) }), /Claude token/);
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ threadId: '../etc' }) }), /thread id/);
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ repo: { origin: 'x', subfolder: '../up', baseBranch: 'main' } }) }), /subfolder/);
  await assert.rejects(exchangeBoot({ boot, log: nullLogger, post: async () => exchanged({ repo: { origin: 'x', subfolder: '', baseBranch: '--upload-pack=x' } }) }), /base branch/);
});

test('the box makes its own key and sends only its hash; an answer lost on the way is asked for again with the same hash', async () => {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const post: ActionPost = async (_kind, _fn, args) => {
    sent.push(args);
    // The first answer is lost after the backend took the token.
    if (n++ === 0) throw new Error('fetch failed: socket hang up');
    // A replay: no key in it, as the box has its own.
    const { boxKey: _, ...rest } = exchanged();
    return rest;
  };
  const got = await exchangeBoot({ boot: { bootToken: BOOT, syncUrl: URL, machineId: 'm-42' }, post, log: nullLogger, sleep: async () => {} });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], 'the same token, machine and key hash both times');
  assert.match(got.boxKey, /^tbb_[0-9a-f]{64}$/);
  assert.equal(crypto.createHash('sha256').update(got.boxKey).digest('hex'), sent[0]!.boxKeyHash);
  assert.ok(!JSON.stringify(sent).includes(got.boxKey), 'the key itself never went');
});

function secretsFor(origin: string, over: Partial<BoxSecrets> = {}): BoxSecrets {
  return { version: 1, bootHash: 'h', syncUrl: URL, boxKey: BOX_KEY, runnerId: 'box0thread01', threadId: THREAD, threadKey: THREAD_KEY, repo: { origin, subfolder: 'runner', baseBranch: 'main' }, save: null, ...over };
}

test('with no save, the box clones its repo on the base branch and the thread starts in the subfolder; once', async () => {
  const origin = originRepo();
  assert.equal(repoFolderName(origin), 'proj');
  assert.equal(repoFolderName('git@github.com:mikecann/threadbear.git'), 'threadbear');
  const home = tmpDir('tb-box-home-');
  const workRoot = tmpDir('tb-box-work-');
  let clones = 0;
  const clone: Cloner = async (u, to) => (clones++, localClone(u, to));
  const s = secretsFor(origin, { repo: { origin, subfolder: 'runner', baseBranch: 'dev' } });
  writeBoxSecrets(home, s);
  const got = await prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone });
  const checkout = fs.realpathSync(path.join(workRoot, 'proj'));
  assert.deepEqual(got, { checkout, cwd: path.join(checkout, 'runner'), restored: false });
  assert.equal(sh(checkout, 'git rev-parse --abbrev-ref HEAD'), 'dev');
  assert.ok(fs.existsSync(path.join(checkout, 'dev.txt')));
  // Kept, so a runner that starts again doesn't clone over the thread's work.
  assert.deepEqual(readBoxSecrets(home)?.prepared, got);
  fs.writeFileSync(path.join(checkout, 'runner', 'work.txt'), 'uncommitted');
  assert.deepEqual(await prepareBoxFolder({ secrets: readBoxSecrets(home)!, fresh: false, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone }), { ...got, again: true });
  assert.equal(clones, 1);
  assert.ok(fs.existsSync(path.join(checkout, 'runner', 'work.txt')));
  // A subfolder the repo doesn't have says so.
  const missing = secretsFor(origin, { repo: { origin, subfolder: 'nope', baseBranch: 'main' } });
  await assert.rejects(prepareBoxFolder({ secrets: missing, fresh: true, home: tmpDir(), claudeDir: tmpDir(), workRoot: tmpDir(), log: nullLogger, clone: localClone }), /nope isn't a folder/);
});

test("an established box whose folder has gone stops, deleting nothing and never restoring its exchange's save over the work", async () => {
  const origin = originRepo();
  const home = tmpDir('tb-box-home-');
  const workRoot = tmpDir('tb-box-work-');
  const s = secretsFor(origin);
  writeBoxSecrets(home, s);
  const got = await prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone: localClone });
  // The thread's work, then its subfolder gone (an agent's rm -rf), and a stale save the exchange once gave.
  fs.mkdirSync(paths.thread(home, THREAD), { recursive: true });
  fs.writeFileSync(path.join(paths.thread(home, THREAD), 'thread.json'), '{"id":"keep"}');
  fs.writeFileSync(path.join(got.checkout, 'README.md'), 'newer work\n');
  fs.rmSync(got.cwd, { recursive: true });
  const kept = { ...readBoxSecrets(home)!, save: { url: 'https://dep.convex.cloud/api/storage/old', at: 1, bytes: 10 } };
  let downloads = 0;
  let clones = 0;
  await assert.rejects(
    prepareBoxFolder({ secrets: kept, fresh: false, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone: async (u, t) => (clones++, localClone(u, t)), download: async () => (downloads++, Buffer.alloc(0)) }),
    /has gone/,
  );
  assert.equal(downloads, 0);
  assert.equal(clones, 0);
  assert.equal(fs.readFileSync(path.join(got.checkout, 'README.md'), 'utf8'), 'newer work\n');
  assert.equal(fs.readFileSync(path.join(paths.thread(home, THREAD), 'thread.json'), 'utf8'), '{"id":"keep"}');
});

test('only the start that traded the token makes the folder, and only into an empty place', async () => {
  const origin = originRepo();
  // A first start that died before its folder was made: the next start (no fresh exchange) won't make it.
  const home = tmpDir('tb-box-home-');
  const workRoot = tmpDir('tb-box-work-');
  const s = secretsFor(origin);
  writeBoxSecrets(home, s);
  fs.mkdirSync(path.join(workRoot, 'proj'));
  fs.writeFileSync(path.join(workRoot, 'proj', 'half.txt'), 'half made');
  let clones = 0;
  const clone: Cloner = async (u, t) => (clones++, localClone(u, t));
  await assert.rejects(prepareBoxFolder({ secrets: s, fresh: false, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone }), /first start didn't finish/);
  // Nor does a fresh exchange over something that's there.
  await assert.rejects(prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir: tmpDir(), workRoot, log: nullLogger, clone }), /isn't empty/);
  assert.equal(clones, 0);
  assert.equal(fs.readFileSync(path.join(workRoot, 'proj', 'half.txt'), 'utf8'), 'half made');
});

test("a box loads only its own thread from disk: other records are left alone, not recovered, carried on or taken in", async () => {
  const home = tmpDir('tb-box-home-');
  const first = makeHarness(home);
  const cwd = first.cfg.defaults.cwd;
  const mine = first.runner.create({ text: 'mine', cwd, accountId: 'claude-main' }).thread.id;
  const other = first.runner.create({ text: 'other', cwd, accountId: 'claude-main' }).thread.id;
  // The other one mid-turn, as a crash would leave it, and a broken record too.
  first.runner.flush();
  fs.mkdirSync(paths.thread(home, 'broken-thread'), { recursive: true });
  fs.writeFileSync(path.join(paths.thread(home, 'broken-thread'), 'events.jsonl'), '');
  const box = makeHarness(home, {}, { boxThread: mine });
  assert.deepEqual([...box.runner.threads.keys()], [mine]);
  assert.throws(() => box.runner.get(other));
  box.runner.carryOnStopped();
  assert.equal(box.adapter.sessions.filter((x) => x.opts.sessionId === first.runner.threads.get(other)!.rec.nativeSessionId).length, 0);
  // A handover or move can't bring another in either.
  assert.equal(box.runner.adopt(other), undefined);
  assert.equal(box.runner.threads.has(other), false);
});

test('a box runs one thread: its create under the id the backend gave, and nothing else', () => {
  const h = makeHarness();
  h.runner.boxThread = THREAD;
  const cwd = h.cfg.defaults.cwd;
  assert.throws(() => h.runner.create({ text: 'another', cwd, accountId: 'claude-main' }), /box for one thread/);
  assert.throws(() => h.runner.create({ text: 'another', cwd, accountId: 'claude-main', id: 'some-other-thread' }), /box for one thread/);
  const made = h.runner.create({ text: 'hi', cwd, accountId: 'claude-main', id: THREAD });
  assert.equal(made.thread.id, THREAD);
  // Once.
  assert.throws(() => h.runner.create({ text: 'again', cwd, accountId: 'claude-main', id: THREAD }), /box for one thread/);
  // A runner that isn't a box never takes an id from outside.
  const other = makeHarness();
  assert.throws(() => other.runner.create({ text: 'x', cwd: other.cfg.defaults.cwd, accountId: 'claude-main', id: THREAD }), /Only a box/);
});

test("a box's heartbeat names its machine; a key the backend turns down means it's been superseded: said once, and nothing more is sent", async () => {
  const h = makeHarness();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let refuse = false;
  let superseded = 0;
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
    key: BOX_KEY,
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: async (_kind, fn, args) => {
      calls.push({ fn, args });
      if (refuse) throw Object.assign(new Error('bad runner key'), { data: { kind: 'auth', message: 'bad runner key' } });
      return fn === 'sync:heartbeat' ? { apiVersion: 89 } : null;
    },
    box: { machineId: 'm-42', superseded: () => void superseded++ },
  });
  sync.start();
  await tick();
  const hb = calls.find((c) => c.fn === 'sync:heartbeat')!;
  assert.equal((hb.args.runner as { machineId?: string }).machineId, 'm-42');
  assert.equal(hb.args.key, BOX_KEY);
  refuse = true;
  h.clock.advance(60_000);
  await tick();
  assert.equal(superseded, 1);
  const after = calls.length;
  // No heartbeat a minute later, nor anything else.
  h.clock.advance(5 * 60_000);
  await tick();
  sync.reconnectNow('clock jumped');
  await tick();
  assert.equal(calls.length, after);
  assert.equal(superseded, 1);
  await sync.stop();
});

test("a runner that isn't a box sends no machine, and a turned-down key isn't taken as superseded", async () => {
  const h = makeHarness();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const sync = new ConvexSync({
    config: { enabled: true, url: URL, name: 'Mac', runnerId: 'r1' },
    key: 'k',
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-11-19T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: async (_kind, fn, args) => {
      calls.push({ fn, args });
      throw Object.assign(new Error('bad runner key'), { data: { kind: 'auth', message: 'bad runner key' } });
    },
  });
  sync.start();
  await tick();
  assert.equal((calls.find((c) => c.fn === 'sync:heartbeat')!.args.runner as { machineId?: string }).machineId, undefined);
  h.clock.advance(60_000);
  await tick();
  // It goes on heartbeating, as an old key may come back (KEY_REJECTED).
  assert.equal(calls.filter((c) => c.fn === 'sync:heartbeat').length, 2);
  await sync.stop();
});

test("the backend's save command goes to the box's save and finishes; a runner that isn't a box refuses it", async () => {
  for (const isBox of [true, false]) {
    const h = makeHarness();
    const t = h.runner.create({ text: 'hi', cwd: h.cfg.defaults.cwd, accountId: 'claude-main' }).thread;
    const finished: Record<string, unknown>[] = [];
    let push!: (v: unknown) => void;
    const saved: string[] = [];
    let awake = 0;
    const sync = new ConvexSync({
      config: { enabled: true, url: URL, name: 'box', runnerId: 'box0thread01' },
      key: BOX_KEY,
      runner: h.runner,
      version: '0.1.0+test',
      startedAt: '2026-11-19T00:00:00.000Z',
      clock: h.clock,
      log: nullLogger,
      post: async (_kind, fn, args) => {
        if (fn === 'sync:heartbeat') return { apiVersion: 89 };
        if (fn === 'sync:takeCommand') return true;
        if (fn === 'sync:finishCommand') finished.push(args);
        return null;
      },
      subscriber: {
        subscribe: (fn, _args, onUpdate) => {
          if (fn === 'sync:pendingCommands') push = onUpdate;
          return () => {};
        },
        close: () => {},
      },
      commands: {
        send: () => undefined,
        respondApproval: () => undefined,
        answerSecret: () => undefined,
        update: () => undefined,
        markSeen: () => undefined,
        create: () => ({ thread: t }),
        share: () => undefined,
        quickAsk: () => ({ thread: t }),
        ...(isBox ? { save: async (id: string) => (saved.push(id), { bytes: 123 }) } : {}),
      },
      ...(isBox ? { box: { superseded: () => {}, awake: () => void awake++ } } : {}),
    });
    sync.start();
    await tick();
    push([{ commandId: 'c1', kind: 'save', threadId: t.id, args: {}, createdAt: 1 }]);
    await tick(10);
    assert.equal(finished.filter((f) => f.commandId === 'c1').length, 1);
    if (isBox) {
      // A save doesn't wake a box frozen by its save; anything else taken does (Runner.releaseTurns).
      assert.equal(awake, 0);
      push([{ commandId: 'c2', kind: 'send', threadId: t.id, args: { text: 'hi' }, createdAt: 2 }]);
      await tick(10);
      assert.equal(awake, 1);
      assert.deepEqual(saved, [t.id]);
      const c1 = finished.find((f) => f.commandId === 'c1')!;
      assert.equal(c1.ok, true);
      assert.equal(c1.result, JSON.stringify({ bytes: 123 }));
    } else {
      assert.equal(finished[0]!.ok, false);
      assert.match(String(finished[0]!.note), /isn't a box/);
    }
    await sync.stop();
  }
});

// ---------------------------------------------------------------- the real runner

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

test('the real runner in box mode: its kept key, its machine in the heartbeat, and it exits once superseded', async () => {
  const home = tmpDir('tb-box-run-');
  const claudeDir = path.join(home, 'claude-main');
  const cwd = tmpDir('tb-box-cwd-');
  const machineId = '148e2d4b0e7d98';
  // A runner that had already booted on this machine and restarted: its
  // secrets are there under this boot token, so it doesn't exchange again.
  fs.mkdirSync(paths.secrets(home), { recursive: true, mode: 0o700 });
  const s: BoxSecrets = { ...secretsFor('https://github.com/x/y.git'), bootHash: crypto.createHash('sha256').update(BOOT).digest('hex'), machineId, prepared: { checkout: cwd, cwd, restored: false } };
  writeBoxSecrets(home, s);
  fs.writeFileSync(path.join(paths.secrets(home), 'convex-key'), BOX_KEY, { mode: 0o600 });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'threadbear-token.json'), JSON.stringify({ token: CLAUDE_TOKEN }), { mode: 0o600 });

  // A backend that has given the thread to a newer box: every call refused as a bad key.
  const seen: { path: string; args: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const b = JSON.parse(body) as { path: string; args: Record<string, unknown> };
        seen.push(b);
      } catch {
        // not a call
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', errorMessage: 'bad runner key', errorData: { kind: 'auth', message: 'bad runner key' } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  let out = '';
  const proc = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(home, 'runner.log'),
      THREADBEAR_LOG_STDERR: '1',
      THREADBEAR_CLAUDE_PATH: '/nonexistent/claude',
      THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: claudeDir,
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
      THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex-main'),
      THREADBEAR_TOKEN_STATS_LIMITS: path.join(home, 'no-limits.json'),
      THREADBEAR_SYNC_URL: `http://127.0.0.1:${port}`,
      [BOOT_ENV]: BOOT,
      FLY_MACHINE_ID: machineId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(-1);
    }, 60_000);
    proc.once('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  server.close();
  assert.equal(code, 0, out.slice(-3000));
  assert.match(out, /a newer box has the thread/);
  // No second exchange: the boot token was used up by the first start.
  assert.equal(seen.filter((c) => c.path === 'boxes:exchange').length, 0);
  const hb = seen.find((c) => c.path === 'sync:heartbeat');
  assert.ok(hb, 'it heartbeat');
  assert.equal(hb.args.key, BOX_KEY);
  assert.equal((hb.args.runner as { runnerId: string; machineId?: string }).runnerId, 'box0thread01');
  assert.equal((hb.args.runner as { machineId?: string }).machineId, machineId);
  // A superseded box says no bye: its key is refused.
  assert.equal(seen.filter((c) => c.path === 'sync:bye').length, 0);
});
