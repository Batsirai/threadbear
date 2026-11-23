// A thread's own key on the RPC, and what it can't do with it
// (docs/protocol/connection.md, "A thread's own key"). The tests go through a real
// server and the real tb, as an agent's shell would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATIENCE_MS, patiently } from '../helpers/patience.ts';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { makeHarness } from '../helpers/fakes.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { readToken } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { threadKey } from '../../src/rpc-auth.ts';
import { GATED_READS, CallerGate } from '../../src/rpc-gate.ts';
import { Scheduler, scheduleMethods } from '../../src/schedules.ts';
import type { PermissionMode } from '../../src/protocol.ts';
import type { PeerCaller } from '../../src/peer.ts';

const TB = path.join(import.meta.dirname, '..', '..', 'bin', 'tb');

type Opts = Partial<ConstructorParameters<typeof RpcServer>[0]>;

async function serve(extra: Opts = {}) {
  const h = makeHarness();
  const token = readToken(h.home);
  const scheduler = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC' });
  const gate = new CallerGate({ runner: h.runner, schedules: scheduler });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate, methods: { ...scheduleMethods(scheduler), 'runner.restart': () => ({}), 'runner.reinstall': () => ({ reinstall: null }), 'instructions.set': () => ({}), 'settings.update': () => ({}), 'pools.save': () => ({}), 'devices.pair': () => ({}) }, ...extra });
  const { port } = await server.listen();
  return { h, server, token, port, url: `ws://127.0.0.1:${port}/rpc`, scheduler };
}

const thread = (h: ReturnType<typeof makeHarness>, mode: PermissionMode, title: string = mode) =>
  h.runner.create({ text: title, accountId: 'claude-3', permissionMode: mode }).thread;

// A connection as that thread: with its key, the way tb connects.
const as = (url: string, token: string, id: string) => RunnerClient.connect(url, threadKey(token, id), { threadId: id });

function tb(h: { home: string }, url: string, id: string | undefined, key: string | undefined, args: string[], env: Record<string, string> = {}) {
  let out = '';
  const p = spawn(process.execPath, [TB, ...args], {
    env: {
      ...process.env,
      THREADBEAR_HOME: h.home,
      THREADBEAR_RUNNER_HOME: h.home,
      THREADBEAR_URL: url,
      THREADBEAR_THREAD_ID: id ?? '',
      THREADBEAR_THREAD_KEY: key ?? '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const code = new Promise<number | null>((r) => p.once('exit', (c) => r(c)));
  return code.then((c) => ({ code: c, out }));
}

const refused = (e: { code?: number }) => e.code === -32060;
// What a lookup that found the client says: under that thread's CLI, or under none.
const peerOf = (threadId: string | undefined): PeerCaller => (threadId ? { kind: 'thread', threadId } : { kind: 'owner' });
// A lookup's answer as a word: the thread, or 'owner' for under none.
const who = (c: PeerCaller) => (c.kind === 'thread' ? c.threadId : 'owner');
const MODES: PermissionMode[] = ['ask', 'auto'];

test('a key only works for its own thread, and is not the token', async () => {
  const { h, server, token, url } = await serve();
  const a = thread(h, 'auto', 'a');
  const b = thread(h, 'full', 'b');
  try {
    assert.notEqual(threadKey(token, a.id), token);
    assert.match(threadKey(token, a.id), /^[0-9a-f]{64}$/);
    // Thread a's key doesn't prove thread b.
    await assert.rejects(RunnerClient.connect(url, threadKey(token, a.id), { threadId: b.id }));
    // Nor is a key the token: without the id it's just a wrong token.
    await assert.rejects(RunnerClient.connect(url, threadKey(token, a.id)));
    // And the token can't pretend to be a thread's key.
    await assert.rejects(RunnerClient.connect(url, token, { threadId: a.id }));
    const c = await as(url, token, a.id);
    assert.equal((await c.call<{ threadId: string; limited: boolean; mode: string }>('auth.whoami')).threadId, a.id);
    c.close();
    const owner = await RunnerClient.connect(url, token);
    assert.deepEqual(await owner.call('auth.whoami'), {});
    owner.close();
  } finally {
    await server.close();
  }
});

for (const mode of MODES) {
  test(`${mode}: tb new --full is refused, and a thread it may start goes no higher than the caller`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    try {
      const key = threadKey(token, me.id);
      const r = await tb(h, url, me.id, key, ['new', '--full', '--account', 'claude-3', 'do anything']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /create_thread/, 'says which tool can ask');
      assert.equal(h.runner.list(['inbox']).length, 1, 'no thread started');
      // No flag at all: the runner's default may be Full, so it takes the caller's.
      const fine = await tb(h, url, me.id, key, ['new', '--account', 'claude-3', 'harmless']);
      assert.equal(fine.code, 0, fine.out);
      const made = h.runner.list(['inbox']).find((t) => t.id === fine.out.trim());
      assert.equal(made?.permissionMode, mode);
    } finally {
      await server.close();
    }
  });

  test(`${mode}: tb send to a higher thread is refused, to one no higher goes through`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    const low = thread(h, 'ask', 'low one');
    try {
      const key = threadKey(token, me.id);
      const r = await tb(h, url, me.id, key, ['send', full.id, 'run this']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /send_message/);
      assert.equal(h.adapter.sessions.length, 3, 'nothing sent on');
      const ok = await tb(h, url, me.id, key, ['send', low.id, 'hello']);
      assert.equal(ok.code, 0, ok.out);
    } finally {
      await server.close();
    }
  });

  test(`${mode}: tb approve on its own card (or any card) is refused`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    try {
      const c = await as(url, token, me.id);
      await assert.rejects(c.call('approvals.respond', { threadId: me.id, approvalId: 'x', decision: 'allow' }), refused);
      await assert.rejects(c.call('plans.approve', { threadId: me.id, itemId: 'x' }), refused);
      await assert.rejects(c.call('secrets.answer', { threadId: me.id, approvalId: 'x', decline: true }), refused);
      c.close();
    } finally {
      await server.close();
    }
  });

  test(`${mode}: tb schedule --full is refused, a check too, and a plain one takes the caller's mode`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    try {
      const key = threadKey(token, me.id);
      const r = await tb(h, url, me.id, key, ['schedule', 'do it', '--at', '30m', '--full', '--cwd', h.home]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /schedule_message/);
      const c = await as(url, token, me.id);
      await assert.rejects(c.call('schedules.create', { text: 'x', at: new Date(Date.now() + 60_000).toISOString(), threadId: me.id, check: 'true' }), refused);
      const ok = await c.call<{ schedule: { permissionMode?: string; createdBy?: string } }>('schedules.create', { text: 'x', at: new Date(Date.now() + 60_000).toISOString(), cwd: h.home, accountId: 'claude-3' });
      assert.equal(ok.schedule.permissionMode, mode);
      assert.equal(ok.schedule.createdBy, me.id);
      c.close();
    } finally {
      await server.close();
    }
  });

  test(`${mode}: a raw RPC call with the key can't get round it`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'higher');
    try {
      const c = await as(url, token, me.id);
      const denied: [string, Record<string, unknown>][] = [
        ['threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }],
        ['threads.send', { threadId: full.id, text: 'x' }],
        ['threads.update', { threadId: me.id, permissionMode: 'full' }],
        ['threads.update', { threadId: full.id, cwd: h.home }],
        ['threads.update', { threadId: me.id, archived: true }],
        ['threads.delete', { threadId: full.id }],
        ['threads.edit', { threadId: me.id, seq: 1, text: 'x' }],
        ['threads.share', { threadId: me.id, access: 'link' }],
        ['buttons.press', { threadId: me.id, buttonId: 'x' }],
        ['patches.trust', { threadId: me.id, files: [{ file: 'a', hash: 'b' }] }],
        ['actions.run', { threadId: me.id, actionId: 'x' }],
        ['instructions.set', { text: 'x' }],
        ['settings.update', { }],
        ['runner.restart', {}],
        ['pools.save', { pools: [] }],
        ['devices.pair', {}],
        ['clis.update', { provider: 'claude' }],
        ['accounts.useReset', { accountId: 'codex-main' }],
        ['accounts.findWork', { accountId: 'codex-main' }],
        ['accounts.recheck', {}],
        ['accounts.yearToken', { accountId: 'claude-main' }],
        ['accounts.yearToken', { accountId: 'claude-main', runnerId: 'cb921b2447ea', code: 'abcdefgh#ijklmnop' }],
        ['panels.convexKey', { threadId: me.id, panelId: 'x' }],
        ['no.such.method', {}],
      ];
      for (const [method, params] of denied) {
        await assert.rejects(c.call(method, params), refused, method);
      }
      // Reads still work.
      const listed = await c.call<{ threads: { id: string }[] }>('threads.list', {});
      assert.ok(listed.threads.some((t) => t.id === full.id));
      assert.ok(await c.call('threads.events', { threadId: full.id, limit: 1 }));
      // Lowering is free.
      const lowered = await c.call<{ thread: { permissionMode: string } }>('threads.update', { threadId: me.id, permissionMode: 'ask' });
      assert.equal(lowered.thread.permissionMode, 'ask');
      c.close();
    } finally {
      await server.close();
    }
  });
}

test('every read the gate lets through is a real read, not a change', () => {
  for (const m of GATED_READS) assert.doesNotMatch(m.split('.').pop()!, /^(create|update|delete|set|save|respond|press|trust|run|pair|revoke|restart|answer|edit|share|move|merge|send)/i, m);
});

test('a thread on Full access still has the lot, through its key', async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'full');
  try {
    const key = threadKey(token, me.id);
    const r = await tb(h, url, me.id, key, ['new', '--full', '--account', 'claude-3', 'go']);
    assert.equal(r.code, 0, r.out);
    const made = h.runner.list(['inbox']).find((t) => t.id === r.out.trim());
    assert.equal(made?.permissionMode, 'full');
    const c = await as(url, token, me.id);
    assert.equal((await c.call<{ limited: boolean }>('auth.whoami')).limited, false);
    // Except reinstalling the runner, which stops every thread: the user's,
    // from the Updates panel, on any mode.
    await assert.rejects(c.call('runner.reinstall'), (e: { code?: number; message?: string }) => refused(e) && /Updates panel/.test(e.message ?? ''));
    c.close();
  } finally {
    await server.close();
  }
});

test('a thread lowered to Ask loses it at once: the mode is read at each call', async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'full');
  try {
    const c = await as(url, token, me.id);
    await c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' });
    h.runner.update({ threadId: me.id, permissionMode: 'ask' });
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }), refused);
    c.close();
  } finally {
    await server.close();
  }
});

// Codex's review, 19 Nov: a Full access thread could ask another runner for
// a token page, approve it with an account of its own and send the code.
test("a Full access thread can't make a year-long token, here or on another runner", async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'full');
  try {
    const c = await as(url, token, me.id);
    for (const params of [{ accountId: 'claude-main' }, { accountId: 'claude-main', runnerId: 'cb921b2447ea', code: 'abcdefgh#ijklmnop' }]) {
      await assert.rejects(c.call('accounts.yearToken', params), /user's to do/);
    }
    c.close();
  } finally {
    await server.close();
  }
});

test('tb outside a thread uses the token and can do everything', async () => {
  const { h, server, url } = await serve();
  try {
    const r = await tb(h, url, undefined, undefined, ['new', '--full', '--account', 'claude-3', 'mine']);
    assert.equal(r.code, 0, r.out);
    assert.equal(h.runner.list(['inbox']).find((t) => t.id === r.out.trim())?.permissionMode, 'full');
  } finally {
    await server.close();
  }
});

test("the owner token from a thread's own process tree gets that thread's limits", async () => {
  // Stands in for the lsof/ps lookup: this connection comes from thread `me`'s CLI.
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  try {
    from = me.id;
    const c = await RunnerClient.connect(url, token);
    const who = await c.call<{ threadId: string; limited: boolean }>('auth.whoami');
    assert.equal(who.threadId, me.id);
    assert.equal(who.limited, true);
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }), refused);
    c.close();
    // tb with the key wiped, the way an agent would get round tb's own check.
    const r = await tb(h, url, '', '', ['new', '--full', '--account', 'claude-3', 'sneaky']);
    assert.equal(r.code, 1, r.out);
    assert.equal(h.runner.list(['inbox']).length, 1);
    // The same token not under any CLI is the owner again.
    from = undefined;
    const owner = await RunnerClient.connect(url, token);
    assert.deepEqual(await owner.call('auth.whoami'), {});
    owner.close();
  } finally {
    await server.close();
  }
});

test("another thread's key lifted from its environment is refused", async () => {
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
  const thief = thread(h, 'ask');
  const victim = thread(h, 'full');
  try {
    from = thief.id;
    const c = await as(url, token, victim.id);
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }));
    assert.equal(h.runner.list(['inbox']).length, 2, 'nothing made');
    c.close();
  } finally {
    await server.close();
  }
});

// Daybreak finding 137: the process lookup used to go by the client's port
// alone, and its answer replaced the thread the key had proved. A
// restricted thread that got the lookup to name a Full thread's process was
// Full. Now the lookup can only agree with a key; naming another thread
// closes the connection before any request runs.
for (const mode of MODES) {
  test(`${mode}: a thread's key whose process lookup names a Full thread can't act as it`, async () => {
    let from: string | undefined;
    const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    try {
      from = full.id;
      const c = await as(url, token, me.id);
      await assert.rejects(c.call('threads.update', { threadId: me.id, permissionMode: 'full' }));
      assert.equal(h.runner.get(me.id).permissionMode, mode, 'still restricted');
      c.close();
      // The lookup agreeing, or not finding a thread, leaves the key's thread.
      for (const f of [me.id, undefined]) {
        from = f;
        const ok = await as(url, token, me.id);
        assert.equal((await ok.call<{ threadId: string }>('auth.whoami')).threadId, me.id);
        await assert.rejects(ok.call('threads.update', { threadId: me.id, permissionMode: 'full' }), refused);
        ok.close();
      }
    } finally {
      await server.close();
    }
  });
}

test("a lookup that can't say which thread holds the socket closes it, the owner token's too", async () => {
  const { AmbiguousPeer } = await import('../../src/peer.ts');
  const { h, server, token, url } = await serve({ callerOf: async () => { throw new AmbiguousPeer('two threads'); } });
  const me = thread(h, 'auto');
  try {
    const owner = await RunnerClient.connect(url, token);
    await assert.rejects(owner.call('threads.update', { threadId: me.id, permissionMode: 'full' }));
    owner.close();
    const c = await as(url, token, me.id);
    await assert.rejects(c.call('auth.whoami'));
    c.close();
    assert.equal(h.runner.get(me.id).permissionMode, 'auto');
  } finally {
    await server.close();
  }
});

// Daybreak finding 175: on a Mac or Linux a lookup that failed, ran out of
// time or found nobody let the owner token decide, and an undefined caller
// passed the gate as the owner. A thread that wiped its key and read the
// token through tb was then the owner whenever lsof or ps faltered.
test("the owner token's connection closes when its process lookup can't say who it is, before any request runs", async () => {
  const { threadOfSocket, UnresolvedPeer } = await import('../../src/peer.ts');
  const table = async () => [{ pid: 500, ppid: 1 }];
  const enoent = Object.assign(new Error('spawn /usr/sbin/lsof ENOENT'), { code: 'ENOENT' });
  const exit2 = Object.assign(new Error('Command failed: lsof'), { code: 2 });
  const faults: [string, Partial<Parameters<typeof threadOfSocket>[1]>][] = [
    ['lsof missing', { lsof: async () => { throw enoent; } }],
    ['lsof failing', { lsof: async () => { throw exit2; } }],
    ['lsof too slow', { lsof: () => new Promise(() => {}) }],
    ['nobody holds it', { lsof: async () => [] }],
    ['ps failing', { lsof: async () => [500], table: async () => { throw new Error('ps: exit 1'); } }],
    ['ps too slow', { lsof: async () => [500], table: () => new Promise(() => {}) }],
    ['holder not in the table', { lsof: async () => [501] }],
  ];
  for (const platform of ['darwin', 'linux'] as const) {
    for (const [what, fault] of faults) {
      const deps = { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, table, lookupMs: 50, platform, ...fault };
      const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
      await assert.rejects(threadOfSocket(sock, deps), (e) => e instanceof UnresolvedPeer, `${platform}, ${what}`);
    }
  }
  // Through a real server: every request waits for the lookup, which closes it.
  for (const [what, fault] of faults) {
    const { h, server, token, url } = await serve({ callerOf: (sock) => threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, table, lookupMs: 50, ...fault }) });
    const me = thread(h, 'auto');
    try {
      const c = await RunnerClient.connect(url, token);
      const calls = [
        c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }),
        c.call('threads.update', { threadId: me.id, permissionMode: 'full' }),
        c.call('patches.trust', { threadId: me.id }),
        c.call('actions.run', { threadId: me.id, actionId: 'x' }),
        c.call('accounts.yearToken', { accountId: 'claude-3' }),
        c.call('github.prAct', { url: 'https://github.com/a/b/pull/1', action: 'merge' }),
        c.call('auth.whoami'),
      ];
      for (const call of calls) await assert.rejects(call, what);
      c.close();
      assert.equal(h.runner.list(['inbox']).length, 1, `${what}: nothing made`);
      assert.equal(h.runner.get(me.id).permissionMode, 'auto', `${what}: not raised`);
      // A key-wiped tb new --full, as an agent would try it.
      const r = await tb(h, url, '', '', ['new', '--full', '--account', 'claude-3', 'sneaky']);
      assert.notEqual(r.code, 0, r.out);
      assert.equal(h.runner.list(['inbox']).length, 1, `${what}: tb made nothing`);
    } finally {
      await server.close();
    }
  }
});

test('a thread key whose lookup fails closes too, and a lookup that finds the client still works both ways', async () => {
  let fail = true;
  let from: string | undefined;
  const { UnresolvedPeer } = await import('../../src/peer.ts');
  const { h, server, token, url } = await serve({ callerOf: async () => { if (fail) throw new UnresolvedPeer('lsof timed out'); return peerOf(from); } });
  const me = thread(h, 'auto');
  try {
    const keyed = await as(url, token, me.id);
    await assert.rejects(keyed.call('auth.whoami'));
    keyed.close();
    fail = false;
    // Found under no thread: the owner, as a terminal or the app is.
    const owner = await RunnerClient.connect(url, token);
    assert.deepEqual(await owner.call('auth.whoami'), {});
    owner.close();
    // Found under a limited thread: that thread.
    from = me.id;
    const lowered = await RunnerClient.connect(url, token);
    assert.equal((await lowered.call<{ threadId: string; limited: boolean }>('auth.whoami')).limited, true);
    lowered.close();
  } finally {
    await server.close();
  }
});

test('on Linux the lookup reads /proc: the socket on exactly this connection, and the processes holding it', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks for the stand-in /proc');
  const { procPids, threadOfSocket } = await import('../../src/peer.ts');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-proc-'));
  try {
    const le = os.endianness() === 'LE';
    // 127.0.0.1 as the kernel prints it on this machine.
    const lo = le ? '0100007F' : '7F000001';
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    const row = (n: number, l: string, r: string, st: string, inode: number) => `   ${n}: ${l} ${r} ${st} 00000000:00000000 00:00000000 00000000   501        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`;
    fs.mkdirSync(path.join(root, 'net'));
    fs.writeFileSync(path.join(root, 'net', 'tcp'), head +
      row(0, `${lo}:225D`, `00000000:0000`, '0A', 100) + // the runner listening on 8797
      row(1, `${lo}:04D2`, `${lo}:225D`, '01', 200) + // the client's end: 1234 -> 8797
      row(2, `${lo}:225D`, `${lo}:04D2`, '01', 201) + // the runner's end
      row(3, `${lo}:04D2`, `${lo}:1538`, '01', 300)); // a socket that shares the port number, to 5432
    const proc = (pid: number, inodes: number[]) => {
      fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true });
      inodes.forEach((i, n) => fs.symlinkSync(`socket:[${i}]`, path.join(root, String(pid), 'fd', String(n + 3))));
    };
    proc(4242, [200]);
    proc(4243, [300]);
    proc(4244, [201]);
    fs.mkdirSync(path.join(root, 'self'));
    const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
    assert.deepEqual(await procPids(sock, root), [4242]);
    assert.deepEqual(await procPids({ ...sock, remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:127.0.0.1' }, root), [4242], 'dual-stack names');
    assert.deepEqual(await procPids({ ...sock, remotePort: 9999 }, root), []);
    const deps = { registry: { threadOfPid: (p: number) => (p === 4242 ? 'th1' : undefined) }, known: () => true, log: nullLogger, platform: 'linux' as const, procRoot: root, table: async () => [{ pid: 4242, ppid: 1 }, { pid: 4243, ppid: 1 }] };
    assert.deepEqual(await threadOfSocket(sock, deps), { kind: 'thread', threadId: 'th1' });
    // No /proc/net/tcp to read: no answer, not the owner.
    fs.rmSync(path.join(root, 'net'), { recursive: true });
    await assert.rejects(threadOfSocket(sock, deps), /could not tell/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Daybreak finding 138: deleting a schedule went straight through the gate.
for (const mode of MODES) {
  test(`${mode}: schedules.delete with a thread's key can't delete a Full schedule or one with a check`, async () => {
    const { h, server, token, url, scheduler } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    const fullSc = await scheduler.create({ text: 'Tidy', cron: '0 9 * * *', title: 'Full one', cwd: h.home, accountId: 'claude-3', permissionMode: 'full' });
    const toFull = await scheduler.create({ text: 'Ping', cron: '0 9 * * *', title: 'To full', threadId: full.id });
    const checked = await scheduler.create({ text: 'Watch', cron: '0 * * * *', title: 'Checked', cwd: h.home, accountId: 'claude-3', permissionMode: mode, check: 'true' });
    const mine = await scheduler.create({ text: 'Later', cron: '0 9 * * *', title: 'Mine', threadId: me.id, createdBy: me.id });
    const c = await as(url, token, me.id);
    try {
      for (const sc of [fullSc, toFull, checked]) {
        await assert.rejects(c.call('schedules.delete', { scheduleId: sc.id }), (e: { code?: number; message?: string }) => refused(e) && /delete_schedule/.test(e.message ?? ''));
        assert.ok(scheduler.find(sc.id), `${sc.title} still there`);
      }
      // By a prefix too: what's compared is what's deleted.
      await assert.rejects(c.call('schedules.delete', { scheduleId: fullSc.id.slice(0, 8) }), refused);
      // Unknown here: refused, not passed on.
      await assert.rejects(c.call('schedules.delete', { scheduleId: 'nope-not-a-schedule' }), refused);
      // Nor by first lowering it or taking its check off (verify-fix of 138).
      await assert.rejects(c.call('schedules.update', { scheduleId: fullSc.id, permissionMode: mode }), refused);
      assert.equal(scheduler.find(fullSc.id).permissionMode, 'full');
      for (const off of [null, '']) {
        await assert.rejects(c.call('schedules.update', { scheduleId: checked.id, check: off }), refused);
        assert.equal(scheduler.find(checked.id).check, 'true');
      }
      await assert.rejects(c.call('schedules.delete', { scheduleId: checked.id }), refused);
      // Nor by moving it to a login, pool, model, effort or zone it doesn't
      // run on: a login another runner lacks stops it quietly (OpenCode's
      // review of the 138 fix).
      for (const sc of [fullSc, checked]) {
        for (const change of [{ model: 'haiku' }, { provider: 'codex' }, { effort: 'low' }, { timezone: 'Pacific/Kiritimati' }, { poolId: 'nope' }, { accountId: 'nonexistent-login' }]) {
          await assert.rejects(c.call('schedules.update', { scheduleId: sc.id, ...change }), refused, `${sc.title}: ${JSON.stringify(change)}`);
        }
        assert.equal(scheduler.find(sc.id).accountId, 'claude-3');
      }
      // Nor by lowering the Full thread a schedule sends to, so it no
      // longer looks above this one (OpenCode's review of the 138 fix).
      await assert.rejects(c.call('threads.update', { threadId: full.id, permissionMode: mode }), refused);
      assert.equal(h.runner.get(full.id).permissionMode, 'full');
      await assert.rejects(c.call('schedules.delete', { scheduleId: toFull.id }), refused);
      // Pausing one is still free.
      await c.call('schedules.update', { scheduleId: fullSc.id, paused: true });
      // One no higher than this thread, with no check, it may delete.
      await c.call('schedules.delete', { scheduleId: mine.id });
      assert.throws(() => scheduler.find(mine.id));
      // The owner still can.
      const owner = await RunnerClient.connect(url, token);
      await owner.call('schedules.delete', { scheduleId: fullSc.id });
      assert.throws(() => scheduler.find(fullSc.id));
      owner.close();
    } finally {
      c.close();
      await server.close();
    }
  });
}

test('a request frame sent before the process lookup finishes waits for it', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => { await held; return peerOf(from); } });
  const me = thread(h, 'auto');
  from = me.id;
  try {
    const c = await RunnerClient.connect(url, token);
    const pending = c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' });
    release();
    await assert.rejects(pending, refused);
    c.close();
  } finally {
    await server.close();
  }
});

// A connection closed straight after auth: its close code, whether or not the
// proof got there first.
const turnedAway = (p: Promise<RunnerClient>) =>
  p.then((c) => closedWithin(c), (e: Error) => Number(/\((\d+)\)/.exec(e.message)?.[1] ?? NaN));

// Until the server has seen every client close.
const patientlyClosed = (server: RpcServer) => patiently(() => (server as unknown as { conns: Set<unknown> }).conns.size === 0);

// The close code, or 'open' if it's still open after a few seconds.
const closedWithin = (c: RunnerClient, ms = 3000) =>
  Promise.race([c.waitClosed().then((i) => i.code), new Promise<string>((r) => setTimeout(() => r('open'), ms).unref())]);

// Daybreak finding 158: a thread's key used to raise the frame limit to 64 MiB
// before the process lookup had finished, and up to 256 whole frames could
// wait for it: about 16 GiB parked in the runner per connection.
test('while the process lookup runs, frames stay small and the queue has a byte budget', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => { await held; return peerOf(from); } });
  const me = thread(h, 'auto');
  from = me.id;
  try {
    // One frame over the pre-auth limit closes it with 1009.
    const big = await as(url, token, me.id);
    void big.call('threads.list', { pad: 'x'.repeat(100 * 1024) }).catch(() => {});
    assert.equal(await closedWithin(big), 1009);
    // Frames under it, but more than the budget in all, close it with 4408.
    const many = await as(url, token, me.id);
    for (let i = 0; i < 40; i++) void many.call('threads.list', { pad: 'x'.repeat(60 * 1024) }).catch(() => {});
    assert.equal(await closedWithin(many), 4408);
    // Once the lookup is done, a big frame is answered.
    const ok = await as(url, token, me.id);
    const first = ok.call('auth.whoami');
    release();
    await first;
    await ok.call('auth.whoami', { pad: 'y'.repeat(2 * 1024 * 1024) });
    assert.equal(ok.closeInfo, undefined);
    ok.close();
  } finally {
    release();
    await server.close();
  }
});

test('lookups still running are capped per thread key, even after their clients have gone, and never keep the owner out', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let from: string | undefined;
  const { h, server, token, url } = await serve({ maxPendingAuth: 2, callerOf: async () => { await held; return peerOf(from); } });
  const me = thread(h, 'auto');
  const other = thread(h, 'auto', 'other');
  const open: RunnerClient[] = [];
  try {
    for (let i = 0; i < 4; i++) open.push(await as(url, token, me.id));
    // A fifth from the same thread is closed at once.
    assert.equal(await turnedAway(as(url, token, me.id)), 4429);
    // Leaving doesn't free one while its lookup still runs.
    for (const c of open.splice(0)) c.close();
    await patientlyClosed(server);
    assert.equal(await turnedAway(as(url, token, me.id)), 4429, 'lookups still running count after their clients have gone');
    // Another thread, and the owner, still get in.
    const theirs = await as(url, token, other.id);
    open.push(theirs);
    const owner = await RunnerClient.connect(url, token);
    open.push(owner);
    // The owner's own lookups take the waiting slots, a bearer client's too.
    const owner2 = await RunnerClient.connect(url, token);
    open.push(owner2);
    const bearer = await RunnerClient.connect(url, token, { legacyHeader: true }).catch(() => undefined);
    bearer?.close();
    assert.equal(bearer, undefined, 'a bearer client waits its turn behind two owner lookups');
    release();
    await Promise.all(open.map((c) => c.call('auth.whoami')));
    await patiently(() => (server as unknown as { ownerLookups: number; threadLookups: Map<string, number> }).threadLookups.size === 0);
    const after = await as(url, token, me.id);
    open.push(after);
    await after.call('auth.whoami');
  } finally {
    release();
    for (const c of open) c.close();
    await server.close();
  }
});

test('reading the runner token file: Claude tools are denied it outside Full access', async () => {
  const { denySecrets } = await import('../../src/secrets-guard.ts');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-keys-')));
  fs.mkdirSync(path.join(home, 'secrets'));
  fs.writeFileSync(path.join(home, 'secrets', 'runner-token'), 'x');
  fs.symlinkSync(path.join(home, 'secrets'), path.join(home, 'alias'));
  const deny = (tool: string, input: Record<string, unknown>) => denySecrets(tool, input, home);
  try {
    assert.ok(deny('Read', { file_path: path.join(home, 'secrets', 'runner-token') }));
    assert.ok(deny('Read', { file_path: path.join(home, 'alias', 'runner-token') }), 'through a link');
    assert.ok(deny('Grep', { path: path.join(home, 'secrets'), pattern: 'x' }));
    assert.ok(deny('Glob', { path: home, pattern: 'secrets/*' }));
    assert.ok(deny('Edit', { file_path: path.join(home, 'secrets', 'runner-token') }));
    assert.ok(deny('Bash', { command: `cat ${path.join(home, 'secrets', 'runner-token')}` }));
    assert.ok(deny('Bash', { command: 'cat "$THREADBEAR_HOME/secrets/runner-token"' }));
    assert.ok(deny('Bash', { command: 'cat ~/Library/Application\\ Support/Threadbear/secrets/runner-token' }));
    assert.ok(deny('Bash', { command: 'cat runner-token' }));
    assert.equal(deny('Read', { file_path: path.join(home, 'threads', 'a.txt') }), undefined);
    assert.equal(deny('Bash', { command: 'ls secrets' }), undefined, "someone else's secrets folder isn't this");
    assert.equal(deny('Bash', { command: 'tb status' }), undefined);
    assert.ok(deny('Bash', { command: 'cat "$THREADBEAR_HOME"/secr*/*token*' }), 'a wildcard after the data dir');
    assert.ok(deny('Grep', { path: home, pattern: '^[a-z]{40}$' }), 'from the data dir, whatever the pattern');
    // From higher up, a Grep reads every file under it whatever its pattern
    // says (cross-lab review of #54, 11 Nov 2026); one beside it is fine.
    assert.ok(deny('Grep', { path: path.dirname(home), pattern: 'hello' }), 'from higher up, whatever the pattern');
    const beside = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-beside-')));
    try {
      assert.equal(deny('Grep', { path: beside, pattern: 'hello' }), undefined, 'a folder beside it');
    } finally {
      fs.rmSync(beside, { recursive: true, force: true });
    }
    assert.ok(denySecrets('Read', { file_path: 'runner-token' }, home, path.join(home, 'secrets')), 'a relative path, against the call\'s cwd');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the process lookup walks parents to a CLI, and only a real thread counts', async () => {
  const { threadOfSocket, AmbiguousPeer, UnresolvedPeer } = await import('../../src/peer.ts');
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const threadOfPort = (_port: number, deps: Parameters<typeof threadOfSocket>[1]) => threadOfSocket(sock, deps);
  const table = async () => [
    { pid: 500, ppid: 400 }, // tb
    { pid: 400, ppid: 300 }, // zsh
    { pid: 300, ppid: 1 }, // the CLI
    { pid: 700, ppid: 1 }, // tb in a terminal
  ];
  const registry = { threadOfPid: (p: number) => (p === 300 ? 'th1' : p === 700 ? 'models:acct' : undefined) };
  const look = async (pids: number[], known: (id: string) => boolean = (id) => id === 'th1') => who(await threadOfPort(1234, { registry, known, log: nullLogger, lsof: async () => pids, table }));
  assert.equal(await look([process.pid, 500]), 'th1', 'skips the runner itself');
  assert.equal(await look([500], () => false), 'owner', 'not a thread this runner has');
  assert.equal(await look([700]), 'owner', "a job's label isn't a thread");
  assert.equal(await look([process.pid]), 'owner', 'the runner itself');
  // Nobody holding a socket the runner has open is the lookup missing it (finding 175).
  await assert.rejects(look([]), (e) => e instanceof UnresolvedPeer);
  const orphan = { pid: 900, ppid: 1, pgid: 77 };
  const grouped = await threadOfPort(1234, { registry: { ...registry, threadOfGroup: (g: number) => (g === 77 ? 'th1' : undefined) }, known: (id) => id === 'th1', log: nullLogger, lsof: async () => [900], table: async () => [orphan] });
  assert.equal(who(grouped), 'th1', 'lost its parents, still in the tool command\'s group');
  await assert.rejects(threadOfPort(1234, { registry, known: () => true, log: nullLogger, lsof: async () => { throw new Error('no lsof'); }, table }), (e) => e instanceof UnresolvedPeer, 'a failed lookup is no answer, never the owner');
  // A socket held by processes under two threads (handed to a child): no guessing.
  const two = { threadOfPid: (p: number) => (p === 300 ? 'th1' : p === 800 ? 'th2' : undefined) };
  const both = async () => [...(await table()), { pid: 800, ppid: 1 }];
  await assert.rejects(threadOfSocket(sock, { registry: two, known: () => true, log: nullLogger, lsof: async () => [500, 800], table: both }), (e) => e instanceof AmbiguousPeer);
  // Two holders under the same thread (a fork) are that thread.
  assert.equal(who(await threadOfSocket(sock, { registry: two, known: () => true, log: nullLogger, lsof: async () => [500, 400], table: both })), 'th1');
});

test("lsof's answer counts only the process holding the client's end of exactly this connection", async () => {
  const { socketOwners } = await import('../../src/peer.ts');
  // A Full thread's process (100) talking to something on port 5432, a
  // restricted one's (200) on 127.0.0.2:5432 and the attacker's real
  // connection (300) from 127.0.0.1:5432; and the runner's own end (1).
  const out = [
    'p100', 'f10', 'n127.0.0.1:61000->127.0.0.1:5432',
    'p200', 'f11', 'n127.0.0.2:5432->127.0.0.1:8797',
    'p300', 'f12', 'n127.0.0.1:5432->127.0.0.1:8797', 'f13', 'n127.0.0.1:5432->127.0.0.1:8797',
    'p1', 'f14', 'n127.0.0.1:8797->127.0.0.1:5432',
    '',
  ].join('\n');
  assert.deepEqual(socketOwners(out, '127.0.0.1:5432->127.0.0.1:8797'), [300]);
  assert.deepEqual(socketOwners(out, '127.0.0.2:5432->127.0.0.1:8797'), [200]);
  assert.deepEqual(socketOwners(out, '127.0.0.1:9999->127.0.0.1:8797'), []);
});

test('the process lookup finds a real connection through lsof and ps', async () => {
  const { threadOfSocket } = await import('../../src/peer.ts');
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  const child = spawn(process.execPath, ['-e', `require('net').connect(${addr.port},'127.0.0.1');setTimeout(()=>{},600000)`], { stdio: 'ignore' });
  const peer = new Promise<import('node:net').Socket>((r) => server.once('connection', r));
  try {
    const s = await peer;
    const sock = { remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! };
    const registry = { threadOfPid: (p: number) => (p === child.pid ? 'th9' : undefined) };
    // The runner's 3 s limit is for live connections; on a loaded Mac lsof
    // alone took longer, so this real lookup gets the suite's patience.
    const lookupMs = PATIENCE_MS;
    assert.equal(who(await threadOfSocket(sock, { registry, known: () => true, log: nullLogger, lookupMs })), 'th9');
    // Under another process: its parent (this test) is the CLI.
    const up = { threadOfPid: (p: number) => (p === process.pid ? 'th8' : undefined) };
    assert.equal(who(await threadOfSocket(sock, { registry: up, known: () => true, log: nullLogger, lookupMs })), 'th8');
    // Under none: the owner, found, not assumed.
    assert.equal(who(await threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, lookupMs })), 'owner');
  } finally {
    child.kill();
    server.close();
  }
});

// Daybreak finding 137, for real: a Full thread's process talks to
// something on port P, and a restricted one connects to the runner from
// source port P. `lsof -iTCP:P` lists both; only the exact connection may count.
test('the process lookup names the process on this exact connection, not another sharing its port number', async (t) => {
  const { threadOfSocket } = await import('../../src/peer.ts');
  const net = await import('node:net');
  const listen = (srv: import('node:net').Server, host: string) => new Promise<void>((r, j) => { srv.once('error', j); srv.listen(0, host, () => r()); });
  // Something the Full thread's process talks to, on ::1 so its port can
  // also be bound on 127.0.0.1 (Linux could use 127.0.0.2; a Mac has only 127.0.0.1).
  const elsewhere = net.createServer();
  try {
    await listen(elsewhere, '::1');
  } catch {
    return t.skip('no IPv6 loopback here');
  }
  const P = (elsewhere.address() as { port: number }).port;
  const runner = net.createServer();
  await listen(runner, '127.0.0.1');
  const R = (runner.address() as { port: number }).port;
  const full = spawn(process.execPath, ['-e', `require('net').connect(${P},'::1');setTimeout(()=>{},600000)`], { stdio: 'ignore' });
  let restricted: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise((r) => elsewhere.once('connection', r));
    const accepted = new Promise<import('node:net').Socket>((r) => runner.once('connection', r));
    restricted = spawn(process.execPath, ['-e', `require('net').connect({port:${R},host:'127.0.0.1',localAddress:'127.0.0.1',localPort:${P}}).on('error',()=>process.exit(3));setTimeout(()=>{},600000)`], { stdio: 'ignore' });
    const s = await accepted;
    assert.equal(s.remotePort, P, 'the restricted client really shares the port number');
    const sock = { remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! };
    const registry = { threadOfPid: (p: number) => (p === full.pid ? 'full-thread' : p === restricted!.pid ? 'ask-thread' : undefined) };
    assert.equal(who(await threadOfSocket(sock, { registry, known: () => true, log: nullLogger, lookupMs: PATIENCE_MS })), 'ask-thread');
  } finally {
    full.kill();
    restricted?.kill();
    runner.close();
    elsewhere.close();
  }
});

test('the registry names a thread only for a live CLI, and sees a draining runner\'s', async () => {
  const { ProcessRegistry } = await import('../../src/proc.ts');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-reg-'));
  try {
    const r = new ProcessRegistry(dir, nullLogger);
    r.add(process.pid, 'test', 'th1');
    assert.equal(await r.threadOfPid(process.pid), 'th1');
    r.remove(process.pid);
    assert.equal(await r.threadOfPid(process.pid), undefined);
    // A draining runner's list is on disk beside this one's.
    const { processInfo } = await import('../../src/proc.ts');
    const lstart = processInfo(process.pid)!.lstart;
    fs.writeFileSync(path.join(dir, 'children-99.json'), JSON.stringify([{ pid: process.pid, command: 'x', startedAt: 'x', lstart, threadId: 'th2' }]));
    assert.equal(await r.threadOfPid(process.pid), 'th2');
    fs.writeFileSync(path.join(dir, 'children-99.json'), JSON.stringify([{ pid: process.pid, command: 'x', startedAt: 'x', lstart: 'some other start', threadId: 'th2' }]));
    assert.equal(await r.threadOfPid(process.pid), undefined, 'a recycled pid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tb goes by its key only for its own runner, never the token next to it', async () => {
  const { tbCredential } = await import('../../src/tb-connect.ts');
  const h = makeHarness();
  const token = readToken(h.home);
  const key = threadKey(token, 'th1');
  assert.deepEqual(tbCredential(h.home, { THREADBEAR_THREAD_KEY: key, THREADBEAR_THREAD_ID: 'th1', THREADBEAR_RUNNER_HOME: h.home }), { token: key, threadId: 'th1' });
  // tb pointed at a dev runner from a thread of the real one.
  assert.deepEqual(tbCredential(h.home, { THREADBEAR_THREAD_KEY: key, THREADBEAR_THREAD_ID: 'th1', THREADBEAR_RUNNER_HOME: '/elsewhere' }), { token });
  // Outside a thread, or a patch's action (no key).
  assert.deepEqual(tbCredential(h.home, {}), { token });
  assert.deepEqual(tbCredential(h.home, { THREADBEAR_THREAD_ID: 'th1', THREADBEAR_THREAD_KEY: '' }), { token });
});

test('tb runner refuses in a limited thread, whatever its environment says', async () => {
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  try {
    const key = threadKey(token, me.id);
    const r = await tb(h, url, me.id, key, ['runner']);
    assert.equal(r.code, 1, r.out);
    // (Run from a real thread's shell, that thread's key is found first.)
    assert.match(r.out, /Auto|Full access|isn't pointed/);
    from = me.id;
    const wiped = await tb(h, url, '', '', ['runner']);
    assert.equal(wiped.code, 1, wiped.out);
    from = undefined;
    assert.match((await tb(h, url, '', '', ['status'])).out, /Runner/);
  } finally {
    await server.close();
  }
});

test('Always allow on tb saves the exact command, never a prefix', async () => {
  const { alwaysAllow, isTbPrefixRule, mentionsTb } = await import('../../src/adapters/claude/adapter.ts');
  const prefix = { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'tb new:*' }], behavior: 'allow' as const, destination: 'session' as const };
  const a = alwaysAllow('Bash', [prefix], { command: 'tb new --ask hello' });
  assert.deepEqual(a.rules, ['Bash(tb new --ask hello)']);
  assert.equal(a.updates.length, 1);
  assert.deepEqual((a.updates[0] as { rules: unknown[] }).rules, [{ toolName: 'Bash', ruleContent: 'tb new --ask hello' }]);
  // A wildcard or newline can't be made exact: allowed this once.
  for (const command of ['tb new --ask x*', 'tb new --ask x\ntb new --full y']) {
    const r = alwaysAllow('Bash', [prefix], { command });
    assert.deepEqual(r, { updates: [], rules: [] });
  }
  // Other commands keep the CLI's suggestion.
  const other = { ...prefix, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] };
  assert.deepEqual(alwaysAllow('Bash', [other], { command: 'npm test' }).rules, ['Bash(npm test:*)']);
  // A Bash card with no suggestion never becomes all of Bash.
  assert.deepEqual(alwaysAllow('Bash', undefined, { command: 'rm x' }).rules, ['Bash(rm x)']);
  assert.deepEqual(alwaysAllow('Read', undefined).rules, ['Read']);
  for (const c of ['tb new x', '"tb" new', './bin/tb new', 'cd a && tb send b c', 'tb', '\\tb new', "t'b' new"]) assert.equal(mentionsTb(c), true, c);
  for (const c of ['grep tb x.txt -l', 'ntb new', 'tbx new']) assert.equal(mentionsTb(c) && !c.startsWith('grep'), false, c);
  assert.equal(isTbPrefixRule('Bash(tb new:*)'), true);
  assert.equal(isTbPrefixRule('Bash(tb new --ask x)'), false);
  assert.equal(isTbPrefixRule('Bash(*tb new*)'), true);
  assert.equal(isTbPrefixRule('Bash(npm test:*)'), false);
});

test("a thread's connection can't pass as the Mac app in hello", async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'auto');
  try {
    const c = await as(url, token, me.id);
    await c.call('hello', { client: 'threadbear-mac', browserPanel: true });
    assert.equal(server.appConnected(), false);
    c.close();
    const app = await RunnerClient.connect(url, token);
    await app.call('hello', { client: 'threadbear-mac' });
    assert.equal(server.appConnected(), true);
    app.close();
  } finally {
    await server.close();
  }
});

test('the GPUI app counts as the app being open', async () => {
  const { server, token, url } = await serve();
  try {
    const app = await RunnerClient.connect(url, token);
    await app.call('hello', { client: 'threadbear-desktop' });
    assert.equal(server.appConnected(), true);
    assert.equal(server.appConnected(true), false, 'an older GPUI app has no Browser pane');
    app.close();
    // One that says it has the Browser pane counts for BrowserBear's handoff.
    const browsing = await RunnerClient.connect(url, token);
    await browsing.call('hello', { client: 'threadbear-desktop', browserPanel: true });
    assert.equal(server.appConnected(true), true);
    browsing.close();
  } finally {
    await server.close();
  }
});

// Daybreak finding 174: tb runner's check read its parents' environments
// with whatever `ps` was on PATH, counted a failed read as "not a thread",
// and then took a runner it couldn't reach (THREADBEAR_URL at a dead port)
// as no objection. Now: three answers, fixed tools, the runner's own
// address, and a thread's key must be its runner's.
test("tb runner's check: can't tell is refused, a thread needs its own runner to say Full, a terminal is fine", async () => {
  const { ownerOnly, tbCaller } = await import('../../src/tb-connect.ts');
  let from: string | undefined;
  const { h, server, token, port } = await serve({ callerOf: async () => peerOf(from) });
  const limited = thread(h, 'auto');
  const full = thread(h, 'full', 'full one');
  const cfg = { home: h.home, host: '127.0.0.1', port } as Parameters<typeof ownerOnly>[0];
  const dead = { ...cfg, port: 1 };
  // tb's parent (a shell, 400) and above it the thread's CLI (300).
  const table = async () => [{ pid: 400, ppid: 300 }, { pid: 300, ppid: 1 }];
  const cliOf = (id: string, key = threadKey(token, id)) => (p: number) => (p === 300 ? `node claude THREADBEAR_THREAD_ID=${id} THREADBEAR_THREAD_KEY=${key} X=1` : 'zsh THREADBEAR_THREAD_KEY= X=1');
  const under = (id: string, key?: string) => ({ table, envOf: cliOf(id, key), ppid: 400, platform: 'darwin' as const });
  const terminal = { table, envOf: () => 'zsh HOME=/Users/x', ppid: 400, platform: 'darwin' as const };
  const wiped = { THREADBEAR_THREAD_KEY: '', THREADBEAR_THREAD_ID: '', THREADBEAR_URL: 'ws://127.0.0.1:1/rpc' };
  try {
    // Can't tell: the process table, a parent's environment, a parent missing.
    for (const deps of [
      { ...terminal, table: async () => { throw new Error('ps: not found'); } },
      { ...terminal, envOf: () => { throw new Error('ps exited 1'); } },
      { ...terminal, envOf: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
      { ...terminal, table: async () => [] },
      { platform: 'win32' as const },
    ]) {
      assert.equal((await tbCaller(wiped, deps)).kind, 'unresolved');
      assert.match((await ownerOnly(cfg, wiped, deps)) ?? '', /couldn't tell/);
    }
    // A limited thread's shell with its key wiped and a dead THREADBEAR_URL:
    // the runner is asked at its own address and says Auto.
    from = limited.id;
    assert.match((await ownerOnly(cfg, wiped, under(limited.id))) ?? '', /on auto/);
    // The runner unreachable: refused, not waved through.
    assert.match((await ownerOnly(dead, wiped, under(limited.id))) ?? '', /Full access/);
    // A stand-in data dir with a token of its own: the CLI's key isn't one it made.
    const fake = makeHarness();
    assert.match((await ownerOnly({ ...cfg, home: fake.home }, wiped, under(limited.id))) ?? '', /isn't pointed at that thread's own runner/);
    // A shell between that claims a key it made up is no better.
    const forged = { ...under(limited.id), envOf: (p: number) => (p === 400 ? `bash THREADBEAR_THREAD_ID=x THREADBEAR_THREAD_KEY=${'c'.repeat(64)}` : cliOf(limited.id)(p)) };
    assert.match((await ownerOnly(cfg, wiped, forged)) ?? '', /isn't pointed/);
    // Only the key in tb's own environment, no parents: still that thread.
    assert.match((await ownerOnly(cfg, { THREADBEAR_THREAD_KEY: threadKey(token, limited.id), THREADBEAR_THREAD_ID: limited.id }, terminal)) ?? '', /on auto/);
    // A Full thread, which the runner sees as it: fine.
    from = full.id;
    assert.equal(await ownerOnly(cfg, wiped, under(full.id)), undefined);
    // Under a thread the runner places as nobody's: not fine.
    from = undefined;
    assert.match((await ownerOnly(cfg, wiped, under(full.id))) ?? '', /Full access/);
    // A terminal: fine, with the runner up or down.
    assert.equal(await ownerOnly(cfg, {}, terminal), undefined);
    assert.equal(await ownerOnly(dead, {}, terminal), undefined);
    // Unless the runner, asked, says it's a limited thread after all.
    from = limited.id;
    assert.match((await ownerOnly(cfg, {}, terminal)) ?? '', /on auto/);
  } finally {
    await server.close();
  }
});

test("tb runner from a limited thread's CLI, its key wiped, no ps on PATH and THREADBEAR_URL at nothing, is refused before any key is read", async (t) => {
  if (process.platform === 'win32') return t.skip("Windows can't read a parent's environment: tb runner there is always refused, as above");
  let from: string | undefined;
  const { h, server, token, port } = await serve({ callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  // A fake ps that says nothing, and one that fails, on PATH.
  const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-fakeps-'));
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const failing = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-fakeps-'));
  fs.writeFileSync(path.join(failing, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // The backend tb runner would use, which must hear nothing.
  const http = await import('node:http');
  let heard = 0;
  const backend = http.createServer((_q, r) => { heard++; r.end('{}'); });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(h.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(h.home, 'secrets', 'convex-key'), 'owner-key\n', { mode: 0o600 });
  try {
    from = me.id;
    for (const pathDir of ['', bin, failing]) {
      for (const sub of [['list'], ['revoke', 'x', '--purge'], ['add', 'x'], ['rotate-owner']]) {
        // The "CLI": a process with the thread's key, which starts tb with it wiped.
        const script = `const {spawn}=require('child_process');const p=spawn(process.execPath,${JSON.stringify([TB, 'runner', ...sub])},{env:{...process.env,THREADBEAR_THREAD_KEY:'',THREADBEAR_THREAD_ID:'',PATH:${JSON.stringify(pathDir)},THREADBEAR_URL:'ws://127.0.0.1:1/rpc'},stdio:'inherit'});p.on('exit',(c)=>process.exit(c??9));`;
        let out = '';
        const cli = spawn(process.execPath, ['-e', script], {
          env: { ...process.env, THREADBEAR_HOME: h.home, THREADBEAR_RUNNER_HOME: h.home, THREADBEAR_PORT: String(port), THREADBEAR_THREAD_ID: me.id, THREADBEAR_THREAD_KEY: threadKey(token, me.id), THREADBEAR_SYNC_URL: `http://127.0.0.1:${(backend.address() as { port: number }).port}` },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        cli.stdout.on('data', (d) => (out += d));
        cli.stderr.on('data', (d) => (out += d));
        const code = await new Promise<number | null>((r) => cli.once('exit', r));
        assert.equal(code, 1, `${pathDir || 'no PATH'} ${sub.join(' ')}: ${out}`);
        assert.match(out, /Auto|Full access|isn't pointed/, out);
      }
    }
    assert.equal(heard, 0, 'the backend heard nothing');
  } finally {
    await server.close();
    backend.close();
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(failing, { recursive: true, force: true });
  }
});

test('a draining server takes the same care with a thread as the main one', async () => {
  let from: string | undefined;
  const { h, server, token, url } = await serve({ onlyOwn: true, callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  try {
    from = me.id;
    const c = await RunnerClient.connect(url, token, { server: 'drain' });
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }), refused);
    assert.equal((await c.call<{ limited: boolean }>('auth.whoami')).limited, true);
    c.close();
  } finally {
    await server.close();
  }
});

// Daybreak, 10 Nov (finding 71), through the RPC gate: a schedule that
// inherits an Ask default can't be switched to Auto with a thread's key.
test("ask: schedules.update can't raise a schedule that inherits an Ask default", async () => {
  const { h, server, token, url, scheduler } = await serve();
  h.runner.cfg.defaults.permissionMode = 'ask';
  const me = thread(h, 'ask');
  const sc = await scheduler.create({ text: 'Tidy', cron: '0 9 * * *', title: 'Inherits', cwd: h.home, accountId: 'claude-3' });
  try {
    const c = await as(url, token, me.id);
    await assert.rejects(c.call('schedules.update', { scheduleId: sc.id, permissionMode: 'auto' }), refused);
    assert.equal(scheduler.find(sc.id).permissionMode, undefined);
    await assert.rejects(c.call('schedules.update', { scheduleId: sc.id, permissionMode: 'full' }), refused);
    // Its runs have Ask, as this thread does: changing what it sends is fine, and so is setting Ask.
    await c.call('schedules.update', { scheduleId: sc.id, text: 'Tidy it', permissionMode: 'ask' });
    assert.equal(scheduler.find(sc.id).permissionMode, 'ask');
    c.close();
  } finally {
    await server.close();
  }
});

// Codex's review of the Daybreak fix for finding 111: a title reaches the
// renamed thread's agent, so tb renaming one above the caller is refused.
for (const mode of MODES) {
  test(`${mode}: renaming a thread with more access through tb is refused, its own or one no higher is not`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    const peer = thread(h, mode, 'peer');
    const c = await as(url, token, me.id);
    try {
      await assert.rejects(c.call('threads.update', { threadId: full.id, title: 'SECURITY_POC' }), refused);
      assert.equal(h.runner.get(full.id).title, 'full one');
      await c.call('threads.update', { threadId: me.id, title: 'mine' });
      await c.call('threads.update', { threadId: peer.id, title: 'renamed' });
      assert.equal(h.runner.get(peer.id).title, 'renamed');
    } finally {
      c.close();
      await server.close();
    }
  });
}

test("a login's cloud token and a thread on a virtual runner are the user's, from the app: refused to any thread's key, Full access too", async () => {
  const started: unknown[] = [];
  const tokens: unknown[] = [];
  const { h, server, token, url } = await serve({
    virtualStart: async (p) => {
      started.push(p);
      return { thread: { id: 'cloud-1', runnerId: 'abcdef012345' } };
    },
    methods: { 'cloudTokens.set': (p) => (tokens.push(p), {}), 'cloudTokens.make': (p) => (tokens.push(p), {}) },
  });
  const me = thread(h, 'full');
  try {
    const c = await as(url, token, me.id);
    await assert.rejects(c.call('cloudTokens.set', { login: 'me@example.com', token: 'sk-ant-oat01-x' }), (e: { code?: number; message?: string }) => refused(e) && /card in the app/.test(e.message ?? ''));
    await assert.rejects(c.call('cloudTokens.make', { login: 'me@example.com' }), refused);
    await assert.rejects(c.call('threads.create', { text: 'x', serviceId: 'runnerServices:1', cwd: '/x', accountId: 'claude-3' }), (e: { code?: number; message?: string }) => refused(e) && /Runs on/.test(e.message ?? ''));
    c.close();
    assert.deepEqual([started.length, tokens.length], [0, 0]);
    // The app, on the runner's token: through.
    const app = await RunnerClient.connect(url, token);
    assert.deepEqual(await app.call('threads.create', { text: 'x', serviceId: 'runnerServices:1', cwd: '/x', accountId: 'claude-3' }), { thread: { id: 'cloud-1', runnerId: 'abcdef012345' } });
    assert.deepEqual(await app.call('cloudTokens.make', { login: 'me@example.com' }), {});
    await assert.rejects(app.call('threads.create', { text: 'x', serviceId: 7 }), (e: { code?: number }) => e.code === -32602);
    app.close();
    assert.equal(started.length, 1);
  } finally {
    await server.close();
  }
});

// The reviews of the fix for finding 158: frames stay small until the lookup
// is done, so a client that sends a big call straight after auth could be cut
// off. A draining runner's link to the primary waits for hello's answer, which
// comes once the lookup is done.
test("a draining runner's link sends a big first call after a slow process lookup", async () => {
  const { PrimaryLink } = await import('../../src/handover.ts');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { server, token, port } = await serve({ callerOf: async () => { await held; return peerOf(undefined); } });
  const link = new PrimaryLink('127.0.0.1', port, token);
  try {
    const call = link.call('auth.whoami', { pad: 'x'.repeat(200 * 1024) });
    setTimeout(release, 100).unref();
    assert.deepEqual(await call, {});
  } finally {
    release();
    link.close();
    await server.close();
  }
});
