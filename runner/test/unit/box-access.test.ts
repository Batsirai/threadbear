// A box key against the backend (docs/virtual-runners.md, decision 4;
// docs/protocol.md, "Box keys"): a box runs its one thread as its own
// runner, and every other row, thread, runner and function is refused.
// The plain rules are in runner-access.test.ts; this plays them through
// the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, OWNER, THREAD } from '../helpers/box-backend.ts';

const sync = load('sync');
const relay = load('relay');
const moves = load('moves');
const boxes = load('boxes');
const machinesModule = load('machines');
const { ACCESS, BOX_CALLS } = load('runnerAccess') as { ACCESS: Record<string, string>; BOX_CALLS: Set<string> };
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };

const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';
const AT = new Date().toISOString();

async function setup() {
  const s = await boxBackend();
  await s.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await s.ctx.db.insert('runners', { runnerId: MINI, name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'mini thread', view: 'inbox', needsYou: false }] });
  const { boxKey } = await s.boot();
  const beat = (runnerId = BOX_RUNNER) => call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 1 } });
  await beat();
  const thread = (threadId: string, runnerId = BOX_RUNNER) => ({ ...THREAD_BASICS, threadId, runnerId, title: 't', view: 'inbox' as const, needsYou: false });
  const write = (threadId: string, runnerId = BOX_RUNNER) => call(s.ctx, sync.upsertThreads, { key: boxKey, threads: [thread(threadId, runnerId)] });
  return { ...s, boxKey, beat, write };
}

test('a box writes its own thread, and never another one or as another runner', async () => {
  const s = await setup();
  assert.equal(await outcome(s.write(THREAD)), 'ok');
  assert.equal(s.rows('threads').find((t) => t.threadId === THREAD)!.runnerId, BOX_RUNNER);
  // A new thread under its own runner id: no.
  assert.equal(await outcome(s.write('another-new-thread')), 'forbidden');
  // Another runner's thread, under either runner id.
  assert.equal(await outcome(s.write('B')), 'forbidden');
  assert.equal(await outcome(s.write('B', MINI)), 'forbidden');
  assert.equal(await outcome(s.write(THREAD, MINI)), 'forbidden');
  assert.equal(s.rows('threads').find((t) => t.threadId === 'B')!.runnerId, MINI);
  // Heartbeat as another runner.
  assert.equal(await outcome(s.beat(MINI)), 'forbidden');
});

test("a box's messages, tool output and pictures go to its own thread only", async () => {
  const s = await setup();
  await s.write(THREAD);
  const msg = (threadId: string, seq: number) => ({ threadId, seq, role: 'assistant' as const, text: 'hi', at: AT });
  await call(s.ctx, sync.appendMessages, { key: s.boxKey, messages: [msg(THREAD, 1), msg('B', 1), msg('nobody', 1)] });
  assert.deepEqual(s.rows('messages').map((m) => m.threadId), [THREAD]);
  assert.deepEqual(await call(s.ctx, sync.replyImages, { key: s.boxKey, threadId: 'B' }), []);
  await call(s.ctx, sync.removeThreads, { key: s.boxKey, threadIds: ['B'] });
  assert.ok(s.rows('threads').some((t) => t.threadId === 'B'), "another runner's thread isn't removed");
  // Its sidebar rows: its own thread's only.
  const index = (threadId: string) => ({ threadId, title: 't', cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: AT, lastActivityAt: AT });
  await call(s.ctx, sync.setThreadIndex, { key: s.boxKey, runnerId: BOX_RUNNER, rows: [index(THREAD), index('B'), index('fresh-id')], removed: [] });
  assert.deepEqual(s.rows('threadIndex').filter((r) => r.runnerId === BOX_RUNNER).map((r) => r.threadId), [THREAD]);
});

test("a box hears and takes its own thread's commands, never another thread's or runner's", async () => {
  const s = await setup();
  await s.write(THREAD);
  const mine = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BOX_RUNNER, threadId: THREAD, kind: 'send', args: { text: 'hello' } });
  const create = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BOX_RUNNER, kind: 'create', args: { text: 'go', cwd: '/w' } });
  // Only the owner or the phone queue for a box's runner; one naming another thread is hidden and refused.
  const other = await machinesModule.queued(s.ctx, { runnerId: BOX_RUNNER, threadId: 'B', kind: 'send', args: { text: 'x' }, createdAt: Date.now() });
  const minis = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'y' } });
  const pending = await call(s.ctx, sync.pendingCommands, { key: s.boxKey, runnerId: BOX_RUNNER });
  assert.deepEqual(pending.map((c: { commandId: string }) => c.commandId).sort(), [mine, create].sort());
  assert.equal(await outcome(call(s.ctx, sync.pendingCommands, { key: s.boxKey, runnerId: MINI })), 'forbidden');
  assert.equal(await call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: mine }), true);
  await call(s.ctx, sync.finishCommand, { key: s.boxKey, commandId: mine, ok: true });
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: other })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: minis })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.finishCommand, { key: s.boxKey, commandId: minis, ok: true })), 'forbidden');
});

test('every function a box key has no business with is refused, owner-only ones and all', async () => {
  const s = await setup();
  const modules = [sync, relay, moves, boxes];
  const refused: string[] = [];
  for (const fn of Object.keys(ACCESS).filter((f) => !BOX_CALLS.has(f))) {
    const mod = modules.find((m) => m[fn]);
    assert.ok(mod, `found ${fn}`);
    // Actions ask the gate through a query; the rest at their first line.
    const ctx = fn === 'setCloudToken' || fn === 'mintBootToken' ? s.a : s.ctx;
    const err = await mod[fn].handler(ctx, { key: s.boxKey }).then(
      () => null,
      (e: { data?: { kind?: string; message?: string } }) => e,
    );
    assert.equal(err?.data?.kind, 'forbidden', fn);
    assert.match(err.data.message, /a box's key runs its one thread/, fn);
    refused.push(fn);
  }
  for (const fn of ['issueToken', 'addRunnerKey', 'runnersList', 'queueCommand', 'startMove', 'saveSchedule', 'savePocketCard', 'setAccounts', 'sharedUsage', 'pools', 'memorySince', 'setPresence', 'prune', 'setCloudToken', 'mintBootToken', 'archiveBox']) assert.ok(refused.includes(fn), fn);
});

test("a box's moves are its own thread's only", async () => {
  const s = await setup();
  await s.write(THREAD);
  // The main Mac moves the mini's thread to the box's runner: not the box's thread, so not its move.
  const { moveId: theirs } = await call(s.ctx, moves.startMove, { key: OWNER, threadId: 'B', to: BOX_RUNNER });
  assert.deepEqual(await call(s.ctx, moves.moves, { key: s.boxKey, runnerId: BOX_RUNNER }), []);
  assert.equal(await outcome(call(s.ctx, moves.moveReady, { key: s.boxKey, moveId: theirs, plan: {}, sealKey: `${'A'.repeat(43)}=` })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, moves.moveFailed, { key: s.boxKey, moveId: theirs, note: 'no' })), 'forbidden');
  await call(s.ctx, moves.cancelMove, { key: OWNER, moveId: theirs });
  // Its own thread moving off the box is its to take part in.
  const { moveId: mine } = await call(s.ctx, moves.startMove, { key: OWNER, threadId: THREAD, to: MINI });
  assert.deepEqual((await call(s.ctx, moves.moves, { key: s.boxKey, runnerId: BOX_RUNNER })).map((m: { moveId: string }) => m.moveId), [mine]);
  assert.equal(await outcome(call(s.ctx, moves.moveInfo, { key: s.boxKey, moveId: mine, info: { title: 't' } })), 'ok');
});

test('a box asks for a new thread from its own thread only', async () => {
  const s = await setup();
  await s.write(THREAD);
  const ask = (threadId: string, requestId: string) => call(s.ctx, relay.fileRequest, { key: s.boxKey, requestId, threadId, target: 'mini', request: { text: 'please' } });
  assert.equal(await outcome(ask(THREAD, 'req-own-1')), 'ok');
  assert.equal(await outcome(ask('B', 'req-their-1')), 'forbidden');
});

test('an archived box key, or one that never was, is refused everywhere', async () => {
  const s = await setup();
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(await outcome(s.beat()), 'auth');
  assert.equal(await outcome(call(s.ctx, sync.pendingCommands, { key: s.boxKey, runnerId: BOX_RUNNER })), 'auth');
  assert.equal(await outcome(call(s.ctx, sync.heartbeat, { key: `tbb_${'0'.repeat(64)}`, runner: { runnerId: BOX_RUNNER, name: 'b', version: 'v', startedAt: AT, draining: false, threadCount: 1 } })), 'auth');
});
