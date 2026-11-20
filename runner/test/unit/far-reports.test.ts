// Replies from a thread the main Mac started on another runner go back to
// the thread that started it (src/far-reports.ts): on 20 Nov a thread on
// the Pixel (a runner key) couldn't send_message its report to the M5
// thread that started it, and it never arrived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FarReports, farReportText, lastReplyOf } from '../../src/far-reports.ts';
import type { RemoteThread, RemoteThreads } from '../../src/thread-index.ts';
import { AGENT_MESSAGE_PREFIX, sentByAgent } from '../../src/protocol.ts';
import { tmpDir } from '../helpers/fakes.ts';

const START = Date.parse('2026-11-20T10:00:00Z');

function row(p: Partial<RemoteThread>): RemoteThread {
  return { threadId: 'far1', runnerId: 'pixel', title: 'Check the update', cwd: '/home/m', accountId: 'a', provider: 'claude', status: 'running', needsYou: false, unread: false, preview: '', createdAt: '', lastActivityAt: '2026-11-20T10:00:00Z', ...p };
}
const list = (...threads: RemoteThread[]): RemoteThreads => ({ runners: [{ id: 'pixel', name: 'Pixel', online: true, lastSeenAt: '' }], threads });

function fake(dir = tmpDir('far-reports')) {
  const sent: { to: string; text: string }[] = [];
  const reply = { text: undefined as string | undefined };
  let now = START;
  const here = new Set(['starter1']);
  const make = () =>
    new FarReports({
      file: path.join(dir, 'far-reports.json'),
      lastReply: async () => reply.text,
      has: (id) => here.has(id),
      deliver: (to, text) => sent.push({ to, text }),
      log: { warn: () => {} },
      now: () => now,
      settle: async () => {},
    });
  return { make, sent, reply, here, dir, at: (ms: number) => (now = START + ms) };
}

test("each turn's reply on the other runner goes to the starter, once", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  await fr.seen(list(row({ status: 'running' })));
  assert.equal(f.sent.length, 0, 'nothing while it works');
  f.reply.text = 'Pixel is on cd605515e now.';
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:01:00Z' })));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.to, 'starter1');
  assert.ok(sentByAgent(f.sent[0]!.text), 'it reads as an agent\'s message, not Mike\'s');
  assert.match(f.sent[0]!.text, /"Check the update" \(far1\) on Pixel, which this thread started there/);
  assert.match(f.sent[0]!.text, /Pixel is on cd605515e now\.$/);
  // The same row again, or a change that brings no new reply (a star, a read).
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:01:00Z' })));
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:02:00Z' })));
  assert.equal(f.sent.length, 1);
  // The next turn's reply goes too.
  f.reply.text = 'And the check passed.';
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:05:00Z' })));
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!.text, /And the check passed\.$/);
});

test('a reply that reaches the backend after the row says the turn ended still goes', async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.at(1000);
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:00:01Z' })));
  assert.equal(f.sent.length, 0);
  f.reply.text = 'Done.';
  // The same row, as the list changes for something else.
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:00:01Z' })));
  assert.equal(f.sent.length, 1);
});

test('kept across a restart, so a reply is neither lost nor sent twice', async () => {
  const f = fake();
  f.make().add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.reply.text = 'First.';
  await f.make().seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:01:00Z' })));
  const again = f.make();
  assert.deepEqual(again.watching(), ['far1']);
  await again.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:01:00Z' })));
  await again.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:03:00Z' })));
  assert.equal(f.sent.length, 1);
});

test("waits for a starter that isn't here, forgets in time, and stops once it's archived", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.here.clear();
  f.reply.text = 'Report.';
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:01:00Z' })));
  assert.equal(f.sent.length, 0);
  f.here.add('starter1');
  await fr.seen(list(row({ status: 'idle', lastActivityAt: '2026-11-20T10:01:00Z', archivedAt: '2026-11-20T10:02:00Z' })));
  assert.equal(f.sent.length, 1, 'its last reply still goes');
  assert.deepEqual(fr.watching(), []);
  fr.add({ threadId: 'far2', runnerName: 'Pixel', starter: 'gone' });
  f.at(31 * 24 * 3600_000);
  await fr.seen(list());
  assert.deepEqual(fr.watching(), []);
});

test('the reply is the last agent text of the last turn', () => {
  assert.equal(lastReplyOf([{ type: 'user.message', text: 'go' }, { type: 'assistant.text', text: 'working on it' }, { type: 'tool.call' }, { type: 'assistant.text', text: 'Done: it works.' }, { type: 'turn.completed' }]), 'Done: it works.');
  assert.equal(lastReplyOf([{ type: 'assistant.text', text: 'old' }, { type: 'user.message', text: 'again' }, { type: 'turn.completed' }]), undefined);
  assert.ok(farReportText({ title: 'x', threadId: 'far1', runnerName: 'Pixel', reply: 'r' }).startsWith(AGENT_MESSAGE_PREFIX));
  assert.match(farReportText({ title: 'x', threadId: 'far1', runnerName: 'Pixel', reply: 'r'.repeat(30_000) }), /\[cut: read_thread far1 has the rest\]$/);
});
