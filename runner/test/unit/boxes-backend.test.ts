// A virtual runner's boxes in the backend (convex/boxes.ts, boxMachine.ts;
// docs/virtual-runners.md, decisions 3, 5, 6, 7 and 10): a login's cloud
// token kept sealed, a box's boot token traded once for its key and
// secrets, a new box's key replacing the last one's, and the box's states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, outcome } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, CLAUDE_TOKEN, later, LOGIN, OWNER, SEAL_KEY, THREAD } from '../helpers/box-backend.ts';

const sync = load('sync');
const boxes = load('boxes');
const viewer = load('viewer');
const PHONE = 'phone-token';
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const { BOOT_MS, LEASE_MS, SAVE_MS } = load('boxStates') as Record<string, number>;
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';

const heartbeat = (s: { ctx: unknown }, key: string, runnerId = BOX_RUNNER) =>
  call(s.ctx, sync.heartbeat, { key, runner: { runnerId, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1 } });

// What a box's runner does to save: an upload on its key, then boxSaved.
async function save(s: Awaited<ReturnType<typeof boxBackend>>, boxKey: string, name: string, bytes = 5000) {
  const url: string = await call(s.ctx, sync.iconUploadUrl, { key: boxKey });
  const ticket = new URL(url).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: s.file(name), bytes }), true);
  await call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: name, bytes });
}

test("a cloud token is kept sealed: listed by login and time only, never in the clear", async () => {
  const s = await boxBackend();
  await s.setToken();
  const row = { ...s.rows('cloudTokens')[0] };
  assert.equal(row.login, LOGIN);
  assert.ok(!JSON.stringify(s.rows('cloudTokens')).includes(CLAUDE_TOKEN.slice(13, 40)), 'not stored in the clear');
  const listed = await call(s.ctx, boxes.cloudTokens, { key: OWNER });
  assert.deepEqual(listed.map((l: Record<string, unknown>) => Object.keys(l).sort()), [['login', 'madeAt', 'setAt']]);
  assert.ok(!JSON.stringify(listed).includes(row.sealed));
  // Setting it again replaces it.
  await s.setToken(`sk-ant-oat01-${'R'.repeat(60)}`);
  assert.equal(s.rows('cloudTokens').length, 1);
  assert.notEqual(s.rows('cloudTokens')[0].sealed, row.sealed);
});

test('only the main key sets or lists cloud tokens, and a deployment without a seal key says so', async () => {
  const s = await boxBackend();
  await s.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  assert.equal(await outcome(s.setToken(CLAUDE_TOKEN, LOGIN, MINI_KEY)), 'forbidden');
  assert.equal(await outcome(call(s.ctx, boxes.cloudTokens, { key: MINI_KEY })), 'forbidden');
  assert.equal(await outcome(s.setToken(CLAUDE_TOKEN, LOGIN, 'nobody')), 'auth');
  assert.equal(await outcome(s.setToken('short')), 'badArgs');
  assert.equal(await outcome(s.setToken(CLAUDE_TOKEN, 'two words')), 'badArgs');
  process.env.BOX_SEAL_KEY = Buffer.alloc(16).toString('base64');
  assert.equal(await outcome(s.setToken()), 'config');
  delete process.env.BOX_SEAL_KEY;
  assert.equal(await outcome(s.setToken()), 'config');
  assert.equal(s.rows('cloudTokens').length, 0);
});

test('a new box starts creating, with a sealed thread key and its repo without credentials', async () => {
  const s = await boxBackend();
  const row = s.box();
  assert.equal(row.boxState.kind, 'creating');
  assert.equal(row.runnerId, BOX_RUNNER);
  assert.equal(row.provider, 'fly');
  assert.equal(row.repo.origin, 'https://github.com/mikecann/threadbear.git');
  assert.equal(row.boxKeyHash, undefined);
  assert.ok(row.sealedThreadKey.length > 40);
  // One box a thread, and a box's runner id is its own.
  assert.equal(await outcome(s.newBox()), 'conflict');
  assert.equal(await outcome(s.newBox('another-thread')), 'conflict');
  await s.ctx.db.insert('runners', { runnerId: MINI, name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  assert.equal(await outcome(s.newBox('another-thread', MINI)), 'conflict');
});

test('the exchange works once: a box key, the runner and thread, the login token, the thread key, the repo', async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  assert.match(token, /^tbt_[0-9a-f]{64}$/);
  // Only the hash is kept.
  assert.equal(s.box().bootTokenHash, await sha256(token));
  const got = await s.exchange(token);
  assert.match(got.boxKey, /^tbb_[0-9a-f]{64}$/);
  assert.equal(got.runnerId, BOX_RUNNER);
  assert.equal(got.threadId, THREAD);
  assert.equal(got.claudeToken, CLAUDE_TOKEN);
  assert.equal(Buffer.from(got.threadKey, 'base64').length, 32);
  assert.deepEqual(got.repo, { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'main' });
  assert.equal(got.save, null);
  const row = s.box();
  assert.equal(row.boxState.kind, 'awake');
  assert.equal(row.boxKeyHash, await sha256(got.boxKey));
  assert.equal(row.bootTokenHash, undefined);
  // The same token again is refused, and the key it gave still works.
  assert.equal(await outcome(s.exchange(token)), 'auth');
  assert.equal(await outcome(heartbeat(s, got.boxKey)), 'ok');
  // The same thread key every time (it's the thread's, not the box's).
  await s.report({ type: 'LOST' });
  const again = await s.exchange(await s.mint());
  assert.equal(again.threadKey, got.threadKey);
});

test('an expired, unknown, malformed or replaced boot token is refused', async () => {
  const s = await boxBackend();
  await s.setToken();
  const old = await s.mint();
  assert.equal(await outcome(later(BOOT_MS + 1000, () => s.exchange(old))), 'auth');
  assert.equal(await outcome(s.exchange(`tbt_${'0'.repeat(64)}`)), 'auth');
  assert.equal(await outcome(s.exchange('not a token')), 'auth');
  // A newer token for the thread replaces the older.
  const newer = await s.mint();
  assert.equal(await outcome(s.exchange(old)), 'auth');
  assert.equal(s.state(), 'creating');
  assert.equal(await outcome(s.exchange(newer)), 'ok');
  // Nothing is minted for a box that isn't booting.
  assert.equal(await outcome(s.mint()), 'conflict');
});

test("an exchange that can't unseal uses nothing up: the boot token works once the right seal key is back", async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  const before = { ...s.box() };
  // A deployment whose BOX_SEAL_KEY was changed: as valid a key, but not the one that sealed.
  process.env.BOX_SEAL_KEY = Buffer.alloc(32, 9).toString('base64');
  await assert.rejects(s.exchange(token));
  assert.equal(s.state(), 'creating');
  assert.equal(s.box().boxKeyHash, undefined);
  assert.equal(s.box().bootTokenHash, before.bootTokenHash);
  // A sealed value gone bad does the same.
  process.env.BOX_SEAL_KEY = SEAL_KEY;
  const sealed = s.rows('cloudTokens')[0].sealed;
  s.rows('cloudTokens')[0].sealed = `${sealed.slice(0, -6)}AAAAA=`;
  await assert.rejects(s.exchange(token));
  assert.equal(s.state(), 'creating');
  s.rows('cloudTokens')[0].sealed = sealed;
  assert.equal((await s.exchange(token)).claudeToken, CLAUDE_TOKEN);
  assert.equal(s.state(), 'awake');
});

test('of two exchanges racing with one boot token, exactly one wins', async () => {
  const s = await boxBackend();
  await s.setToken();
  const bootHash = await sha256(await s.mint());
  // Both read and unseal before either claims.
  const p1 = await call(s.ctx, boxes.peekBoot, { bootHash });
  const p2 = await call(s.ctx, boxes.peekBoot, { bootHash });
  const claim = async (p: { sealedToken: string; sealedThreadKey: string }, k: string) => call(s.ctx, boxes.claimBoot, { bootHash, boxKeyHash: await sha256(k), sealedToken: p.sealedToken, sealedThreadKey: p.sealedThreadKey });
  assert.notEqual(await claim(p1, 'tbb_first'), null);
  assert.equal(await claim(p2, 'tbb_second'), null);
  assert.equal(s.box().boxKeyHash, await sha256('tbb_first'));
  // A token set again between the read and the claim: try again, nothing used up.
  await s.report({ type: 'LOST' });
  const again = await sha256(await s.mint());
  const p3 = await call(s.ctx, boxes.peekBoot, { bootHash: again });
  await s.setToken(`sk-ant-oat01-${'Z'.repeat(60)}`);
  assert.equal(await outcome(call(s.ctx, boxes.claimBoot, { bootHash: again, boxKeyHash: 'x', sealedToken: p3.sealedToken, sealedThreadKey: p3.sealedThreadKey })), 'conflict');
  assert.equal(s.state(), 'waking');
});

test('with no cloud token for its login, the exchange refuses and the boot token still works once one is set', async () => {
  const s = await boxBackend();
  const token = await s.mint();
  assert.equal(await outcome(s.exchange(token)), 'noCloudToken');
  assert.equal(s.state(), 'creating');
  assert.equal(s.box().boxKeyHash, undefined);
  await s.setToken();
  assert.equal((await s.exchange(token)).claudeToken, CLAUDE_TOKEN);
});

test("a second box for the thread kills the first box's key, its upload URLs with it", async () => {
  const s = await boxBackend();
  const first = await s.boot();
  const url: string = await call(s.ctx, sync.iconUploadUrl, { key: first.boxKey });
  // The first box is lost: its key is refused from that step.
  assert.equal(await s.report({ type: 'LOST' }), true);
  assert.equal(s.state(), 'waking');
  assert.equal(await outcome(heartbeat(s, first.boxKey)), 'auth');
  const second = await s.exchange(await s.mint());
  assert.notEqual(second.boxKey, first.boxKey);
  assert.equal(second.runnerId, first.runnerId, 'the same runner, for life');
  assert.equal(await outcome(heartbeat(s, second.boxKey)), 'ok');
  assert.equal(await outcome(heartbeat(s, first.boxKey)), 'auth');
  // The first box's upload URL died with its key.
  const ticket = new URL(url).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: s.file('late'), bytes: 100 }), false);
});

test('a box goes creating, starting, awake, saving, asleep, waking and awake again, then is archived and gone', async () => {
  const s = await boxBackend();
  assert.equal(await s.report({ type: 'CREATED', providerBoxId: 'fly-1' }), true);
  assert.equal(s.state(), 'starting');
  assert.equal(s.box().providerBoxId, 'fly-1');
  const { boxKey } = await s.boot();
  assert.equal(s.state(), 'awake');
  assert.equal(await s.report({ type: 'IDLE' }), true);
  assert.equal(s.state(), 'saving');
  await save(s, boxKey, 'save1');
  assert.equal(s.state(), 'asleep');
  assert.equal(s.box().save.storageId, 'save1');
  assert.ok(s.box().awakeToday.ms >= 0);
  // Asleep on a paused box: its key still works, so it can resume.
  assert.equal(await outcome(heartbeat(s, boxKey)), 'ok');
  assert.equal(await s.report({ type: 'WAKE' }), true);
  assert.equal(s.state(), 'waking');
  // Two quick messages make one wake.
  assert.equal(await s.report({ type: 'WAKE' }), false);
  assert.equal(await s.report({ type: 'RESUMED' }), true);
  assert.equal(s.state(), 'awake');
  assert.equal(await outcome(heartbeat(s, boxKey)), 'ok');
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(s.state(), 'destroying');
  assert.equal(s.box().boxKeyHash, undefined);
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
  // Archiving again is nothing; a box can't come back from it.
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(await s.report({ type: 'WAKE' }), false);
  assert.equal(await s.report({ type: 'DESTROYED' }), true);
  assert.equal(s.state(), 'gone');
  // Its save stays, for deleteAfterDays.
  assert.ok(s.hasFile('save1'));
});

test('a save replaces the last one, and a new box gets the last save to restore', async () => {
  const s = await boxBackend();
  const { boxKey } = await s.boot();
  await save(s, boxKey, 'save1');
  assert.equal(s.state(), 'awake', 'a save while awake keeps it awake');
  await s.report({ type: 'IDLE' });
  await save(s, boxKey, 'save2', 9000);
  assert.equal(s.state(), 'asleep');
  assert.deepEqual({ id: s.box().save.storageId, bytes: s.box().save.bytes }, { id: 'save2', bytes: 9000 });
  assert.equal(s.hasFile('save1'), false, 'the last save is deleted');
  // The paused box was lost while asleep: its key goes with it, so it can't
  // resume, and the next wake makes a new box, which restores the save.
  await s.report({ type: 'LOST' });
  assert.equal(s.state(), 'asleep');
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
  await s.report({ type: 'WAKE' });
  assert.equal(await s.report({ type: 'RESUMED' }), false);
  const got = await s.exchange(await s.mint());
  assert.equal(got.save.url, 'https://files.example/save2');
  assert.equal(got.save.bytes, 9000);
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
});

test("a box's save is a file its own runner uploaded, on its own key", async () => {
  const s = await boxBackend();
  const { boxKey } = await s.boot();
  // A file nobody's runner uploaded (the owner's), and the owner itself.
  s.file('owners');
  assert.equal(await outcome(call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: 'owners', bytes: 10 })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, boxes.boxSaved, { key: OWNER, storageId: 'owners', bytes: 10 })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: 'owners', bytes: 0 })), 'badArgs');
  assert.equal(s.box().save, undefined);
});

test('timers: a box that never checks in fails; one that stops heartbeating is lost; a save that never comes keeps it up', async () => {
  const s = await boxBackend();
  // Never exchanged: failed after ten minutes, and the next message tries again.
  await s.fireTimers(Date.now() + BOOT_MS + 1000);
  assert.equal(s.state(), 'failed');
  assert.match(s.box().boxState.error, /10 minutes/);
  assert.equal(await s.report({ type: 'WAKE' }), true);
  assert.equal(s.state(), 'waking');
  const { boxKey } = await s.boot();
  assert.equal(s.state(), 'awake');
  // Heartbeating: the lease runs on from its last heartbeat.
  const t1 = Date.now() + LEASE_MS - 1000;
  await later(t1 - Date.now(), () => heartbeat(s, boxKey));
  await s.fireTimers(Date.now() + LEASE_MS + 10);
  assert.equal(s.state(), 'awake');
  assert.ok(s.box().boxState.leaseUntil > Date.now() + LEASE_MS);
  // Asked to save, and nothing comes: it stays up.
  await s.report({ type: 'IDLE' });
  await later(SAVE_MS - 2000, () => heartbeat(s, boxKey));
  await s.fireTimers(Date.now() + SAVE_MS + 10);
  assert.equal(s.state(), 'awake');
  // No heartbeat for the lease: lost, its key refused.
  await s.fireTimers(Date.now() + 3 * LEASE_MS);
  assert.equal(s.state(), 'waking');
  assert.equal(s.box().boxKeyHash, undefined);
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
});

test('the provider failing fails the box, its key with it; a failed or archived box takes no boot', async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  assert.equal(await s.report({ type: 'FAILED', error: 'no capacity\nin syd' }), true);
  assert.equal(s.state(), 'failed');
  assert.equal(s.box().boxState.error, 'no capacity in syd');
  assert.equal(await outcome(s.exchange(token)), 'auth');
  await s.report({ type: 'WAKE' });
  const late = await s.mint();
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(await outcome(s.exchange(late)), 'auth');
  assert.equal(s.state(), 'destroying');
});

test("a box's heartbeat marks its runner as a box's, and nothing a heartbeat sends takes it off", async () => {
  const s = await boxBackend();
  const { boxKey } = await s.boot();
  await call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId: BOX_RUNNER, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1, rpcUrl: 'wss://evil.example/rpc' } });
  const runner = s.rows('runners').find((r) => r.runnerId === BOX_RUNNER)!;
  assert.deepEqual(runner.box, { serviceId: s.serviceId });
  // No Mac app dials a box.
  assert.equal(runner.rpcUrl, undefined);
  // The owner key heartbeating as that runner keeps it.
  await heartbeat(s, OWNER);
  assert.deepEqual(s.rows('runners').find((r) => r.runnerId === BOX_RUNNER)!.box, { serviceId: s.serviceId });
  assert.ok(s.box().lastHeartbeatAt! > 0);
  // A box key is no runner key: none was made for it.
  assert.equal(s.rows('runnerKeys').length, 0);
});

test('no query hands back a sealed token, a thread key or a key hash', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await heartbeat(s, got.boxKey);
  const sealed = [s.rows('cloudTokens')[0].sealed, s.box().sealedThreadKey, s.box().boxKeyHash];
  // The Machines page's queries, for a phone or browser token.
  await s.ctx.db.insert('tokens', { hash: await sha256(PHONE), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  const viewed = [
    await call(s.ctx, viewer.overview, { token: PHONE }),
    await call(s.ctx, viewer.rows, { token: PHONE, table: 'boxes' }),
    await call(s.ctx, viewer.rows, { token: PHONE, table: 'boxes', machine: 'box', kind: 'awake' }),
    await call(s.ctx, viewer.row, { token: PHONE, table: 'boxes', id: s.boxId }),
  ];
  assert.equal(viewed[1].rows.length, 1, 'the viewer still lists the box');
  assert.equal(viewed[3].doc.threadId, THREAD, 'and shows its row');
  const answers = [...viewed, await call(s.ctx, boxes.cloudTokens, { key: OWNER }), await call(s.ctx, sync.threadsOf, { key: got.boxKey, runnerId: BOX_RUNNER }), await call(s.ctx, sync.runnersList, { key: OWNER })];
  const text = JSON.stringify(answers);
  for (const x of [...sealed, CLAUDE_TOKEN, got.threadKey]) assert.ok(!text.includes(x), 'nothing secret in what queries return');
});
