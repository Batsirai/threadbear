// A phone command's lifecycle in the backend (convex/sync.ts, "A command's
// lifecycle"): pending -> taken -> done | failed, and nothing else. Found by
// reading the code on 17 Nov 2026 (the state machines survey): a take whose
// answer was lost made the runner's retry get false and drop the command,
// leaving it taken with nobody running it for 14 days; a finish overwrote a
// command however it had ended; and a runner that stopped mid-apply left it
// "Sending…" on the phone for two weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const CLOUD_KEY = 'tbr_cloud';
const MINI = 'cb921b2447ea';
const CLOUD = 'befe8df8975c';
const TOKEN = 'phone-token';
const ATTEMPT = '3b241101-e2bb-4255-8caf-4136c566a962';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runnerKeys', { runnerId: CLOUD, keyHash: await sha256(CLOUD_KEY), name: 'cloud', createdAt: 1 });
  for (const runnerId of [MINI, CLOUD]) await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'T', view: 'inbox', needsYou: false }] });
  const send = async (text = 'hello') => (await call(b.ctx, phone.send, { token: TOKEN, threadId: 'B', text })) as string;
  const row = (id: string) => b.rows('commands').find((r) => r._id === id)!;
  const seen = async (id: string) => call(b.ctx, phone.command, { token: TOKEN, commandId: id });
  return { ...b, send, row, seen };
}

async function later<T>(ms: number, f: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await f();
  } finally {
    Date.now = realNow;
  }
}

test('a take whose answer was lost: the same attempt asking again gets it, so the command runs once', async () => {
  const s = await setup();
  const id = await s.send();
  // The first ask commits; the runner never hears its true.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), true);
  // Its retry with the same attempt is told it has it.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), true);
  // Nobody else gets it: no attempt (an older runner, or a second process), another attempt, another runner.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id }), false);
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: 'another-attempt-id' }), false);
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: CLOUD_KEY, commandId: id, attempt: ATTEMPT })), 'forbidden');
  // Once it's finished, the attempt gets nothing: it can't run twice.
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: true });
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), false);
  assert.equal((await s.seen(id)).state, 'done');
  // An attempt has to look like one.
  const other = await s.send('again');
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: other, attempt: 'x' })), 'badArgs');
  assert.equal(s.row(other).state, 'pending');
});

test('an older runner, with no attempt, takes a command once as before', async () => {
  const s = await setup();
  const id = await s.send();
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id }), true);
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id }), false);
  assert.equal(s.row(id).attempt, undefined);
});

test('a finish changes only a taken command: a repeated or stale one leaves how it ended', async () => {
  const s = await setup();
  // Finished once, then again with another outcome (a retry after a lost answer).
  const a = await s.send();
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: a });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: a, ok: true });
  const doneAt = s.row(a).doneAt;
  await later(60_000, () => call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: a, ok: false, note: 'boom' }));
  assert.deepEqual([s.row(a).state, s.row(a).note, s.row(a).doneAt], ['done', undefined, doneAt]);
  // Cancelled on the phone before any runner took it: a finish doesn't revive it.
  const b = await s.send();
  assert.equal(await call(s.ctx, phone.cancel, { token: TOKEN, commandId: b }), true);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: b, ok: true });
  assert.deepEqual([s.row(b).state, s.row(b).note], ['failed', 'Cancelled']);
  // Never taken: still waiting, for the take that will run it.
  const c = await s.send();
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: c, ok: true });
  assert.equal(s.row(c).state, 'pending');
});

test("a taken command whose runner never finishes it shows as failed after its lease, and isn't handed out again", async () => {
  const s = await setup();
  const id = await s.send();
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), true);
  // Within the lease nothing happens.
  await later(sync.TAKEN_LEASE_MS - 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.equal((await s.seen(id)).state, 'taken');
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.deepEqual(await s.seen(id), { state: 'failed', note: sync.LAPSED_NOTE });
  // The phone's list of waiting messages lets it go.
  assert.deepEqual(await call(s.ctx, phone.waiting, { token: TOKEN, threadId: 'B' }), []);
  // Nothing takes it again, not even its own attempt: it may have run.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT }), false);
  assert.deepEqual(await call(s.ctx, sync.pendingCommands, { key: MINI_KEY, runnerId: MINI }), []);
  // Its runner's late answer still says how it really went, once.
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: true });
  assert.deepEqual(await s.seen(id), { state: 'done' });
  assert.equal(s.row(id).lapsedAt, undefined);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: id, ok: false, note: 'late again' });
  assert.deepEqual(await s.seen(id), { state: 'done' });
});

test('lapsing goes a batch at a time, and schedules itself again while more are due', async () => {
  const s = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 101; i++) {
    const id = await s.send(`m${i}`);
    await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
    ids.push(id);
  }
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.equal(ids.filter((id) => s.row(id).state === 'failed').length, 100);
  assert.ok(s.scheduled.some((j: any) => j.fn.endsWith('lapseCommands')));
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.equal(ids.filter((id) => s.row(id).state === 'failed').length, 101);
});

// Codex's review: a lapse dropped the args a late finish is checked by, so a
// late moves.describe answer kept its origin's ssh user, and a late login
// change's answer was thrown away.
test("a lapsed command's late finish is checked as an on-time one: a description's origin is cleaned, a login change's answer kept", async () => {
  const s = await setup();
  const describe = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'call', args: { method: 'moves.describe', params: {} } });
  const login = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'update', args: { accountId: 'claude-2' } });
  for (const id of [describe, login]) await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id, attempt: ATTEMPT });
  await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
  assert.deepEqual([s.row(describe).state, s.row(login).state], ['failed', 'failed']);
  assert.equal(s.row(describe).args.params, undefined, 'its words still go');
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: describe, ok: true, result: JSON.stringify({ title: 't', cwd: '/c', home: '/h', provider: 'claude', origin: 'ssh://UNCLASSIFIEDSSHLOGIN@example.com/owner/repo.git' }) });
  assert.ok(!String(s.row(describe).result).includes('UNCLASSIFIEDSSHLOGIN'), s.row(describe).result);
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId: login, ok: true, result: JSON.stringify({ accountId: 'claude-2' }) });
  assert.equal(s.row(login).result, JSON.stringify({ accountId: 'claude-2' }));
  assert.deepEqual([s.row(describe).state, s.row(login).state], ['done', 'done']);
});

test('lapsing reads within its byte budget, so taken messages of hundreds of KB still lapse, a run at a time', async () => {
  const s = await setup();
  const big = 'x'.repeat(256 * 1024);
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const id = await s.send(big + i);
    await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId: id });
    ids.push(id);
  }
  let runs = 0;
  while (ids.some((id) => s.row(id).state === 'taken')) {
    s.resetReads();
    await later(sync.TAKEN_LEASE_MS + 60_000, () => call(s.ctx, sync.lapseCommands, {}));
    assert.ok(s.bytesRead() < 16 * 1024 * 1024, `read ${s.bytesRead()}`);
    assert.ok(++runs < 10);
  }
  assert.ok(runs > 1, 'more than one run');
});

// ------------------------------------------------------------ runner requests

test("a runner request's claim: the same claim asked again is told yes, any other is refused, and a handed-back claim is spent", async () => {
  const s = await setup();
  await call(s.ctx, relay.fileRequest, { key: MINI_KEY, requestId: 'req-00001', threadId: 'B', target: 'main', request: { text: 'start one' } });
  const row = () => s.rows('runnerRequests').find((r) => r.requestId === 'req-00001')!;
  const decide = (state: string, extra: Record<string, unknown> = {}) => call(s.ctx, relay.decideRequest, { key: OWNER, requestId: 'req-00001', docId: String(row()._id), state, ...extra });
  await decide('claimed', { claim: ATTEMPT });
  assert.deepEqual([row().state, row().claim], ['claimed', ATTEMPT]);
  // Its answer was lost; asking again with the same claim is fine, and changes nothing.
  await decide('claimed', { claim: ATTEMPT });
  // Another claim, or none (an older runner), is refused as before.
  assert.equal(await outcome(decide('claimed', { claim: 'another-claim-id' })), 'badArgs');
  assert.equal(await outcome(decide('claimed')), 'badArgs');
  assert.equal(await outcome(decide('claimed', { claim: 'x' })), 'badArgs');
  // Handed back: the claim goes with it, so it can't be reused to skip the next claim.
  await decide('pending');
  assert.deepEqual([row().state, row().claim], ['pending', undefined]);
  await decide('claimed', { claim: 'second-claim-id' });
  assert.equal(await outcome(decide('claimed', { claim: ATTEMPT })), 'badArgs');
  // The asking runner reads it back with its claim (requestOut lets it through).
  assert.equal((await call(s.ctx, relay.runnerRequest, { key: OWNER, requestId: 'req-00001' })).claim, 'second-claim-id');
});
