// A moved thread's rows go to the runner it moves to within that runner's
// allowances, and a box is charged for them like any runner key (Daybreak
// finding 181, 24 Nov 2026): moves:rehomeRows added to the new runner's
// counts with no check, so moving full threads in could push a runner past
// its caps, and a box (whose key isn't a runnerKeys row) was taken for the
// owner, its moved rows and files charged to nobody. Played against the
// in-memory database (test/helpers/convex-memory.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, OWNER, THREAD } from '../helpers/box-backend.ts';

const MINI_KEY = 'tbr_mac-mini';
const CLOUD_KEY = 'tbr_cloud';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea'; // T
const CLOUD = 'befe8df8975c'; // S
const SEAL = 'A'.repeat(43) + '=';
const SHA = 'a'.repeat(64);
const STORED = 150 * 1024 * 1024; // sync.ts STORED_BYTES_PER_RUNNER

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const moves = load('moves');
const CAP = sync.RUNNER_KEY_CAPS as { messageBytes: number; evictPerWrite: number; bodyBytes: number; bodyEvictPerWrite: number };
const storedBytes = sync.storedBytes as (r: Record<string, unknown>) => number;

type B = ReturnType<typeof memoryBackend>;

function mover(b: B) {
  const fn = (f: unknown, args: Record<string, unknown>) => call(b.ctx, f as never, args);
  const as = (key: string) => ({
    start: (threadId: string, to: string) => fn(moves.startMove, { key, threadId, to }),
    info: (moveId: string) => fn(moves.moveInfo, { key, moveId, info: { cwd: '/x' } }),
    ready: (moveId: string) => fn(moves.moveReady, { key, moveId, plan: { cwd: '/x' }, sealKey: SEAL }),
    frozen: (moveId: string) => fn(moves.moveFrozen, { key, moveId }),
    pack: async (moveId: string) => {
      const ticket = new URL(await fn(moves.moveChunkUrl, { key, moveId })).searchParams.get('ticket');
      const id = b.file(`chunk-${moveId}`);
      assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: id, bytes: 1000 }), true);
      return fn(moves.movePacked, { key, moveId, chunks: [id], sha256: SHA, bytes: 1000 });
    },
    claim: (moveId: string) => fn(moves.moveClaim, { key, moveId }),
    done: (moveId: string) => fn(moves.moveDone, { key, moveId }),
    upsert: (threadId: string, runnerId: string) => fn(sync.upsertThreads, { key, threads: [{ threadId, runnerId, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] }),
    append: (threadId: string, from: number, n: number, size: number) => fn(sync.appendMessages, { key, messages: Array.from({ length: n }, (_, k) => ({ threadId, seq: from + k, role: 'assistant', text: `${threadId}${from + k} `.padEnd(size, 'x'), at: 'now' })) }),
    bodies: (threadId: string, from: number, n: number, size: number) => fn(sync.appendBodies, { key, bodies: Array.from({ length: n }, (_, k) => ({ threadId, seq: from + k, text: 'o'.repeat(size) })) }),
    picture: async (threadId: string, id: string, bytes: number) => {
      const ticket = new URL(await fn(sync.iconUploadUrl, { key })).searchParams.get('ticket');
      assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: b.file(id), bytes }), true);
      return fn(sync.addReplyImage, { key, threadId, seq: 1, path: `${id}.png`, storageId: id, mediaType: 'image/png' });
    },
  });
  // The rehome pages scheduled and not yet run, run until there are none.
  const runAll = async () => {
    let runs = 0;
    for (let round = 0; round < 500; round++) {
      const next: Record<string, unknown>[] = [];
      for (let i = b.scheduled.length - 1; i >= 0; i--) {
        const job = b.scheduled[i] as { fn: string; args: Record<string, unknown> };
        if (job.fn.endsWith('rehomeRows')) next.unshift(...(b.scheduled.splice(i, 1) as (typeof job)[]).map((j) => j.args));
      }
      if (!next.length) return runs;
      for (const a of next) {
        await fn(moves.rehomeRows, a);
        runs++;
      }
    }
    throw new Error('rehomeRows never finished');
  };
  return { fn, as, runAll };
}

const usage = (b: B, runnerId: string) => b.rows('runnerStorage').find((u) => u.runnerId === runnerId) ?? { bytes: 0, messageBytes: 0, bodyBytes: 0 };
const held = (b: B, table: string, runnerId: string) => b.rows(table).filter((r) => r.runnerId === runnerId).reduce((n, r) => n + storedBytes(r), 0);
const moveOf = (b: B, moveId: string) => b.rows('threadMoves').find((m) => m.moveId === moveId)!;

async function keyed() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runnerKeys', { runnerId: CLOUD, keyHash: await sha256(CLOUD_KEY), name: 'cloud', createdAt: 1 });
  for (const [runnerId, name] of [
    [LAPTOP, 'Laptop'],
    [MINI, 'mac-mini'],
    [CLOUD, 'cloud'],
  ] as const) {
    await b.ctx.db.insert('runners', { runnerId, name, version: '1', lastSeenAt: Date.now(), startedAt: new Date().toISOString(), draining: false, threadCount: 0 });
  }
  const m = mover(b);
  return { ...b, ...m, owner: m.as(OWNER), mini: m.as(MINI_KEY), cloud: m.as(CLOUD_KEY) };
}

async function withCaps<T>(caps: Partial<typeof CAP>, f: () => Promise<T>): Promise<T> {
  const was = { ...CAP };
  Object.assign(CAP, caps);
  try {
    return await f();
  } finally {
    Object.assign(CAP, was);
  }
}

test("a thread moved to a runner at its caps never puts it past them: its oldest give way, and pictures it has no room for aren't kept for it", async () => {
  const s = await keyed();
  // Cloud's thread T: 30 messages, 10 tool outputs and a picture. Mac mini's own O, as much again.
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 30, 2_000);
  await s.cloud.bodies('T', 1, 10, 2_000);
  await s.cloud.picture('T', 'cloud-pic', 100_000);
  await s.mini.upsert('O', MINI);
  await s.mini.append('O', 1, 30, 2_000);
  await s.mini.bodies('O', 1, 10, 2_000);
  const mini = usage(s, MINI);
  // Mac mini's allowances: room for a few more of each, and only a few made a call.
  await withCaps({ messageBytes: mini.messageBytes + 10_000, evictPerWrite: 3, bodyBytes: mini.bodyBytes + 5_000, bodyEvictPerWrite: 2 }, async () => {
    await s.ctx.db.patch(s.rows('runnerStorage').find((u) => u.runnerId === MINI)!._id, { bytes: STORED - 1_000 });
    const { moveId } = await s.owner.start('T', MINI);
    await s.cloud.info(moveId);
    await s.mini.ready(moveId);
    await s.cloud.frozen(moveId);
    await s.cloud.pack(moveId);
    await s.mini.claim(moveId);
    await s.mini.done(moveId);
    const runs = await s.runAll();
    assert.ok(runs > 5, 'it took runs of their own to make room');
    assert.equal(moveOf(s, moveId).state, 'done');
    // Within its caps, and its counts are what its rows hold.
    const after = usage(s, MINI);
    assert.ok(after.messageBytes <= CAP.messageBytes, `messages ${after.messageBytes} within ${CAP.messageBytes}`);
    assert.ok(after.bodyBytes <= CAP.bodyBytes, `tool output ${after.bodyBytes} within ${CAP.bodyBytes}`);
    assert.equal(after.messageBytes, held(s, 'messages', MINI));
    assert.equal(after.bodyBytes, held(s, 'eventBodies', MINI));
    // Nothing of T's is still Cloud's, nor counted against it.
    assert.equal(s.rows('messages').filter((r) => r.runnerId === CLOUD).length, 0);
    assert.equal(s.rows('eventBodies').filter((r) => r.runnerId === CLOUD).length, 0);
    assert.equal(usage(s, CLOUD).messageBytes, 0);
    assert.equal(usage(s, CLOUD).bodyBytes, 0);
    // The oldest went first: T's newest message is there.
    assert.ok(s.rows('messages').some((r) => r.threadId === 'T' && r.seq === 30));
    // The picture: no room on Mac mini, so the backend's copy goes and nobody is charged for it.
    assert.equal(s.rows('replyImages').length, 0);
    assert.equal(s.hasFile('cloud-pic'), false);
    assert.equal(after.bytes, STORED - 1_000);
    assert.equal(s.rows('storageOwners').filter((o) => o.storageId === 'cloud-pic').length, 0);
  });
});

test('a rehome page run again, or run late, gives and counts nothing twice', async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 450, 300);
  await s.cloud.bodies('T', 1, 5, 300);
  await s.cloud.picture('T', 'pic', 70_000);
  const { moveId } = await s.owner.start('T', MINI);
  await s.cloud.info(moveId);
  await s.mini.ready(moveId);
  await s.cloud.frozen(moveId);
  await s.cloud.pack(moveId);
  await s.mini.claim(moveId);
  // Every page run twice over.
  const pages: Record<string, unknown>[] = [];
  const twice = async () => {
    for (let round = 0; round < 50; round++) {
      const next: Record<string, unknown>[] = [];
      for (let i = s.scheduled.length - 1; i >= 0; i--) {
        const job = s.scheduled[i] as { fn: string; args: Record<string, unknown> };
        if (job.fn.endsWith('rehomeRows')) next.unshift(...(s.scheduled.splice(i, 1) as (typeof job)[]).map((j) => j.args));
      }
      if (!next.length) return;
      for (const a of next) {
        pages.push(a);
        await s.fn(moves.rehomeRows, a);
        await s.fn(moves.rehomeRows, a);
      }
    }
  };
  await twice();
  await s.mini.done(moveId);
  for (const a of pages) await s.fn(moves.rehomeRows, a);
  const mini = usage(s, MINI);
  assert.equal(mini.messageBytes, held(s, 'messages', MINI));
  assert.equal(mini.bodyBytes, held(s, 'eventBodies', MINI));
  assert.equal(s.rows('messages').filter((r) => r.threadId === 'T').length, 450);
  assert.equal(mini.bytes, 70_000, 'the picture counted once');
  assert.equal(usage(s, CLOUD).messageBytes, 0);
});

test("a thread moved to a box and back keeps every row and file charged to the runner it's on", async () => {
  const s = await boxBackend();
  const MINI_ONLINE = { runnerId: MINI, name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() };
  await s.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await s.ctx.db.insert('runners', MINI_ONLINE);
  const { boxKey } = await s.boot();
  await call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId: BOX_RUNNER, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1 } });
  const m = mover(s);
  const mini = m.as(MINI_KEY);
  const box = m.as(boxKey);
  // The box's thread starts on Mac mini, with messages, tool output and a picture.
  await mini.upsert(THREAD, MINI);
  await mini.append(THREAD, 1, 20, 500);
  await mini.bodies(THREAD, 1, 4, 500);
  await mini.picture(THREAD, 'mini-pic', 80_000);
  const moveTo = async (to: string, from: ReturnType<typeof m.as>, onto: ReturnType<typeof m.as>) => {
    const { moveId } = await m.as(OWNER).start(THREAD, to);
    await from.info(moveId);
    await onto.ready(moveId);
    await from.frozen(moveId);
    await from.pack(moveId);
    await onto.claim(moveId);
    await onto.done(moveId);
    await m.runAll();
    assert.equal(moveOf(s, moveId).state, 'done');
  };
  await moveTo(BOX_RUNNER, mini, box);
  // The box's, by its own runner id, counted against it: never the owner's.
  const onBox = (table: string) => s.rows(table).filter((r) => r.threadId === THREAD).map((r) => r.runnerId);
  assert.deepEqual([...new Set(onBox('messages'))], [BOX_RUNNER]);
  assert.deepEqual([...new Set(onBox('eventBodies'))], [BOX_RUNNER]);
  assert.equal(usage(s, BOX_RUNNER).messageBytes, held(s, 'messages', BOX_RUNNER));
  assert.equal(usage(s, BOX_RUNNER).bodyBytes, held(s, 'eventBodies', BOX_RUNNER));
  assert.deepEqual(s.rows('storageOwners').filter((o) => o.storageId === 'mini-pic').map((o) => [o.runnerId, o.bytes]), [[BOX_RUNNER, 80_000]]);
  assert.equal(usage(s, MINI).messageBytes, 0);
  assert.equal(usage(s, MINI).bodyBytes, 0);
  // And back: Mac mini's again, the box's counts given back.
  await moveTo(MINI, box, mini);
  assert.deepEqual([...new Set(onBox('messages'))], [MINI]);
  assert.equal(usage(s, MINI).messageBytes, held(s, 'messages', MINI));
  assert.equal(usage(s, BOX_RUNNER).messageBytes, 0);
  assert.equal(usage(s, BOX_RUNNER).bodyBytes, 0);
  assert.deepEqual(s.rows('storageOwners').filter((o) => o.storageId === 'mini-pic').map((o) => o.runnerId), [MINI]);
});
