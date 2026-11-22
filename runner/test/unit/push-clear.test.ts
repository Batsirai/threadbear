// A thread that stops needing Mike after a push went out for it sends the
// phones a silent push:clear, so they take its notification down rather than
// leaving a pile of ones he's already dealt with (20 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const sync = load('sync');
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
  assert.equal(scheduled(b, 'push.clear').length, 2, 'and its own clear');
});
