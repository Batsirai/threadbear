// A thread that stops needing Mike after a push went out for it sends the
// phones a silent push:clear, so they take its notification down rather than
// leaving a pile of ones he's already dealt with (20 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const sync = load('sync');
const devices = load('devices');
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const MINI = 'cb921b2447ea';
const MINI_KEY = 'tbr_mac-mini';
const OWNER = 'owner-key';
process.env.RUNNER_KEY = OWNER;

const scheduled = (b: ReturnType<typeof memoryBackend>, name: string) => (b.scheduled as { fn: unknown; args: unknown }[]).filter((s) => String(s.fn).endsWith(name)).map((s) => s.args);
const write = (b: ReturnType<typeof memoryBackend>, needsYou: boolean) =>
  call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou }] });

test('a pushed thread that stops needing him clears its notification, once', async () => {
  const b = memoryBackend();
  await write(b, false);
  await write(b, true);
  assert.deepEqual(scheduled(b, 'push.notify'), [{ threadId: 'T' }]);
  assert.deepEqual(scheduled(b, 'push.clear'), []);
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [{ threadId: 'T' }]);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1, 'only on the change');
});

test('no clear for a thread that never had a push, or had one over a day ago', async () => {
  const b = memoryBackend();
  await b.ctx.db.insert('threads', { threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: true });
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [], 'never pushed');
  const row = b.rows('threads')[0] as { _id: string };
  await b.ctx.db.patch(row._id, { needsYou: true, pushedAt: Date.now() - 25 * 60 * 60_000 });
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [], 'pushed too long ago');
});

// Gemini review of Daybreak 169 (22 Nov 2026): every needsYou true-to-false
// flip within a day of a push cleared it again, and flipping back within
// the push cooldown sends no new push, so a runner could keep one push's
// thread toggling and make a silent clear for every phone each time, using
// up the backend's relay allowance with nothing on any screen. One push,
// one clear: a clear comes again only after a new push.
test('one push takes one clear: toggling the thread without a new push clears nothing more', async () => {
  const b = memoryBackend();
  await write(b, false);
  await write(b, true);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1);
  for (let k = 0; k < 5; k++) {
    await write(b, true);
    await write(b, false);
  }
  assert.equal(scheduled(b, 'push.notify').length, 1, 'still within the cooldown: no new push');
  assert.equal(scheduled(b, 'push.clear').length, 1, 'nothing new on the phone to take down');
  const row = b.rows('threads')[0] as { _id: string; pushedAt: number };
  await b.ctx.db.patch(row._id, { pushedAt: row.pushedAt - 60_000 });
  await write(b, true);
  assert.equal(scheduled(b, 'push.notify').length, 2, 'a new push after the cooldown');
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1, 'not until its alert really goes (push:notify arms it)');
  await write(b, true);
  await call(b.ctx, devices.armClear, { threadId: 'T' });
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 2, 'an alert that went out gets its clear');
});

// The review of that: the mark was written before the runner's push
// allowance was asked, so a refused push re-armed a clear (and a refused
// clear marked one sent). A runner key's pushes and clears share 10 a minute.
test("a runner past its push allowance neither re-arms a clear nor uses one up", async (tc) => {
  const now = Date.parse('2026-11-22T10:00:05Z');
  tc.mock.method(Date, 'now', () => now);
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  const put = (threadId: string, needsYou: boolean) => call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId, runnerId: MINI, ...THREAD_BASICS, title: threadId, view: 'inbox', needsYou }] });
  await put('T', false);
  await put('T', true);
  await call(b.ctx, devices.armClear, { threadId: 'T' });
  // Its allowance for this minute used up on other threads.
  for (let k = 0; k < 9; k++) {
    await put(`x${k}`, false);
    await put(`x${k}`, true);
  }
  assert.equal(scheduled(b, 'push.notify').length, 10);
  await put('T', false);
  assert.equal(scheduled(b, 'push.clear').length, 0, 'refused');
  const t = () => b.rows('threads').find((r) => r.threadId === 'T')!;
  assert.equal(t().clearedAt, undefined, 'so not marked as cleared');
  // A push past the cooldown, refused: nothing went out, so nothing to clear.
  await b.ctx.db.patch(t()._id, { pushedAt: t().pushedAt - 60_000, clearedAt: Date.now() });
  await put('T', true);
  assert.equal(scheduled(b, 'push.notify').length, 10, 'refused');
  assert.notEqual(t().clearedAt, undefined, 'still cleared');
});
