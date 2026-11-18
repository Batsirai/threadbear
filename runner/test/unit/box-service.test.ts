// The virtual runners' service (convex/boxService.ts, boxes.ts startThread,
// boxHooks.ts; docs/virtual-runners.md decisions 2, 6, 7, 9 and 12) with the
// real Fly adapter against a fake Fly API (helpers/fake-fly.ts), never the
// real one: a thread started, its box made, booted, slept, woken and
// deleted, through the scheduled actions as Convex would run them.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, later, LOGIN, OWNER, THREAD } from '../helpers/box-backend.ts';
import { fakeFly } from '../helpers/fake-fly.ts';

const sync = load('sync');
const relay = load('relay');
const phone = load('phone');
const moves = load('moves');
const boxes = load('boxes');
const service = load('boxService');
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ACTIONS = new Set(['createBox', 'wakeBox', 'sleepBox', 'destroyBox', 'checkBox', 'retireBox', 'reapBoxes', 'reapService']);
// What run() runs of what's scheduled: the service's steps, and a move's rehoming.
const RUNS = new Set(['boxes.wakeFor', 'boxes.archiveIfStill', 'boxes.wakeWaiting', 'boxes.wakeAllWaiting', 'boxes.failExpired', 'moves.rehomeRows']);
const REPO = { origin: 'https://github.com/mikecann/threadbear.git', subfolder: '', baseBranch: 'main' };
const AT = new Date().toISOString();
const MINUTE = 60_000;

async function setup(memoryMb = 2048) {
  const s = await boxBackend();
  const fly = fakeFly({ token: 'fly-token', apps: ['tb-boxes'] });
  process.env.FLY_API_TOKEN = 'fly-token';
  process.env.FLY_APP = 'tb-boxes';
  process.env.CONVEX_CLOUD_URL = 'https://dep.convex.cloud';
  globalThis.fetch = fly.fetch as typeof fetch;
  await s.setToken();
  // The helper's own box (THREAD) was made before any of this: its create isn't run here.
  let cursor = s.scheduled.length;
  // Bigger than Fly can pause: a virtual runner from before setRunnerService refused that.
  if (memoryMb > 2048) s.rows('runnerServices')[0].box = { cpus: 2, memoryMb };
  else await call(s.ctx, boxes.setRunnerService, { key: OWNER, serviceId: s.serviceId, name: 'Cloud (Fly)', provider: 'fly', image: 'registry.fly.io/threadbear-box:1', box: { cpus: 2, memoryMb } });
  // Runs the service's scheduled steps as Convex's scheduler would, in order (delays aside), until none are left. Returns their names.
  const run = async (): Promise<string[]> => {
    const ran: string[] = [];
    let steps = 0;
    while (cursor < s.scheduled.length) {
      const job = s.scheduled[cursor++] as { fn: string; args: Record<string, unknown> };
      const [, mod, name] = job.fn.split('.') as [string, string, string];
      if (mod !== 'boxService' && !RUNS.has(`${mod}.${name}`)) continue;
      // The idle cron's sweep runs every time: not listed, to keep the lists to the point.
      if (!['wakeWaiting', 'wakeAllWaiting', 'retryKeptSaves'].includes(name)) ran.push(name);
      if (++steps > 200) throw new Error(`run(): still going after 200 steps: ${ran.slice(-5).join(', ')}`);
      await call(ACTIONS.has(name) ? s.a : s.ctx, load(mod)[name], job.args);
    }
    return ran;
  };
  // Skips what's scheduled so far, for a test that runs steps by hand.
  const skip = () => {
    cursor = s.scheduled.length;
  };
  const start = (threadId: string, text = 'hello') => call(s.a, boxes.startThread, { key: OWNER, serviceId: s.serviceId, threadId, repo: REPO, login: LOGIN, text, permissionMode: 'ask' });
  const rowOf = (threadId: string) => s.rows('boxes').find((r) => r.threadId === threadId)!;
  const stateOf = (threadId: string): string => rowOf(threadId).boxState.kind;
  // The boot token the provider was given for a machine: only there, in its environment.
  const bootOf = (machineId: string): string => fly.byId(machineId)!.config.env.THREADBEAR_BOX_BOOT;
  // What the box's runner does once booted: its exchange, a heartbeat,
  // what's waiting for it (the create that makes its thread, first), then its thread's row.
  const boot = async (threadId: string, machineId: string) => {
    const got = await s.exchange(bootOf(machineId));
    await beat(got.boxKey, got.runnerId);
    await takeAll(got.boxKey, got.runnerId);
    await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId, runnerId: got.runnerId, title: 't', view: 'inbox', needsYou: false }] });
    return got;
  };
  const beat = (boxKey: string, runnerId: string) => call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 1 } });
  // The box's runner takes and finishes what's waiting for it (its create, a message). Each take must work.
  const takeAll = async (boxKey: string, runnerId: string) => {
    for (const c of await call(s.ctx, sync.pendingCommands, { key: boxKey, runnerId })) {
      if (c.kind === 'save') continue;
      assert.equal(await call(s.ctx, sync.takeCommand, { key: boxKey, commandId: c.commandId }), true, `the box takes its ${c.kind}`);
      await call(s.ctx, sync.finishCommand, { key: boxKey, commandId: c.commandId, ok: true });
    }
  };
  // What the box's runner does to save: an upload on its key, then boxSaved.
  const save = async (boxKey: string, name: string) => {
    const url: string = await call(s.ctx, sync.iconUploadUrl, { key: boxKey });
    const ticket = new URL(url).searchParams.get('ticket');
    assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: s.file(name), bytes: 5000 }), true);
    await call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: name, bytes: 5000 });
  };
  const send = (runnerId: string, threadId: string, text = 'more') => call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId, kind: 'send', args: { text } });
  const sleepIdle = (ms: number) => later(ms, () => call(s.ctx, service.sleepIdleBoxes, {}));
  // The reaper's cron: it schedules a run per virtual runner, which run() runs.
  const reap = async () => {
    await call(s.a, service.reapBoxes, {});
    return run();
  };
  // A box past its idle minutes, asked to save, saves, and is slept.
  const sleepWith = async (threadId: string, boxKey: string, name = `save-${threadId}`) => {
    assert.ok((await sleepIdle(11 * MINUTE)) >= 1);
    await save(boxKey, name);
    assert.equal(stateOf(threadId), 'asleep');
    await run();
  };
  // Archived by its runner (into the den): it's asked to save, saves, and its box goes.
  const archive = async (threadId: string, runnerId: string, boxKey: string, name = `archived-${threadId}`) => {
    await call(s.ctx, sync.upsertThreads, { key: boxKey, threads: [{ ...THREAD_BASICS, threadId, runnerId, title: 't', view: 'den', needsYou: false }] });
    assert.deepEqual(await run(), ['archiveIfStill']);
    assert.equal(stateOf(threadId), 'archiving');
    await save(boxKey, name);
    assert.deepEqual(await run(), ['destroyBox']);
    assert.equal(stateOf(threadId), 'gone');
  };
  return { ...s, fly, run, skip, start, rowOf, stateOf, bootOf, boot, beat, takeAll, save, send, sleepIdle, reap, sleepWith, archive };
}

test('a thread starts on a virtual runner: its runner, its box and its create, then the service makes one box', async () => {
  const s = await setup();
  const { runnerId, commandId } = await s.start('T2');
  assert.match(runnerId, /^[0-9a-f]{12}$/);
  const runner = s.rows('runners').find((r) => r.runnerId === runnerId)!;
  assert.deepEqual(runner.box, { serviceId: s.serviceId });
  assert.equal(s.stateOf('T2'), 'creating');
  const cmd = s.rows('commands').find((c) => c._id === commandId)!;
  assert.deepEqual({ runnerId: cmd.runnerId, threadId: cmd.threadId, kind: cmd.kind, state: cmd.state }, { runnerId, threadId: 'T2', kind: 'create', state: 'pending' });
  assert.deepEqual(cmd.args, { text: 'hello', permissionMode: 'ask', from: 'mac' });
  assert.deepEqual(await s.run(), ['createBox']);
  // One machine, of the virtual runner's image and size, its boot token and the deployment's address in its environment and nothing else.
  assert.equal(s.fly.live().length, 1);
  const m = s.fly.live()[0]!;
  assert.equal(m.config.image, 'registry.fly.io/threadbear-box:1');
  assert.deepEqual(m.config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 });
  assert.deepEqual(Object.keys(m.config.env).sort(), ['THREADBEAR_BOX_BOOT', 'THREADBEAR_SYNC_URL']);
  assert.equal(m.config.env.THREADBEAR_SYNC_URL, 'https://dep.convex.cloud');
  assert.match(s.bootOf(m.id), /^tbt_[0-9a-f]{64}$/);
  const row = s.rowOf('T2');
  assert.deepEqual(m.config.metadata, { tb_box: row._id, tb_attempt: '1', tb_service: s.serviceId, tb_idem: `${row._id}-1` });
  assert.equal(row.bootTokenHash, await sha256(s.bootOf(m.id)), 'only its hash kept');
  assert.equal(s.stateOf('T2'), 'starting');
  assert.deepEqual({ id: row.providerBoxId, attempt: row.providerAttempt }, { id: m.id, attempt: 1 });
  // The box boots, takes its create and runs.
  const pending = await call(s.ctx, sync.pendingCommands, { key: OWNER, runnerId });
  assert.deepEqual(pending.map((c: { commandId: string }) => c.commandId), [commandId]);
  const got = await s.boot('T2', m.id);
  assert.equal(got.runnerId, runnerId);
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.rows('commands').find((c) => c._id === commandId)!.state, 'done');
});

test('start → create → exchange → idle → save → sleep (paused) → a message resumes it → archive → deleted', async () => {
  const s = await setup(2048);
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  // Not idle yet; then idle the virtual runner's 10 minutes: asked to save, with a save command.
  assert.equal(await s.sleepIdle(5 * MINUTE), 0);
  assert.equal(await s.sleepIdle(11 * MINUTE), 1);
  assert.equal(s.stateOf('T2'), 'saving');
  const saves = s.rows('commands').filter((c) => c.runnerId === runnerId && c.kind === 'save' && c.state === 'pending');
  assert.equal(saves.length, 1);
  assert.equal(saves[0]!.threadId, 'T2');
  // Asked again before it saves: still one save command.
  await s.save(got.boxKey, 'save1');
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.deepEqual(await s.run(), ['sleepBox']);
  assert.equal(s.fly.byId(m.id)!.state, 'suspended', 'paused, as the box is 2 GB');
  assert.ok(s.rowOf('T2').boxKeyHash, 'its key kept, to resume');
  // A message wakes it: the same box, resumed, its key still good.
  await s.send(runnerId, 'T2');
  assert.deepEqual(await s.run(), ['wakeFor', 'wakeBox']);
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  assert.equal(s.fly.live().length, 1, 'no new box');
  assert.equal(await outcome(call(s.ctx, sync.heartbeat, { key: got.boxKey, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 1 } })), 'ok');
  await s.takeAll(got.boxKey, runnerId);
  // Archived (its runner moves it to the den): after the grace it saves, then its box goes.
  await s.archive('T2', runnerId, got.boxKey);
  assert.equal(s.fly.live().length, 0);
  assert.equal(await outcome(call(s.ctx, sync.heartbeat, { key: got.boxKey, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 1 } })), 'auth');
});

test("a box too big to pause is deleted on sleep, and a message makes a new attempt's box that restores the save", async () => {
  const s = await setup(4096);
  const { runnerId } = await s.start('T2');
  await s.run();
  const first = s.fly.live()[0]!;
  const got = await s.boot('T2', first.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 'save1');
  assert.deepEqual(await s.run(), ['sleepBox']);
  assert.equal(s.fly.live().length, 0, 'deleted');
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.equal(s.rowOf('T2').boxKeyHash, undefined, 'its key went with it');
  assert.equal(s.rowOf('T2').providerBoxId, undefined);
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
  const second = s.fly.live()[0]!;
  assert.notEqual(second.id, first.id);
  assert.equal(second.config.metadata.tb_attempt, '2');
  const again = await s.exchange(s.bootOf(second.id));
  assert.equal(again.save.url, 'https://files.example/save1', 'restores the last save');
  assert.equal(again.runnerId, runnerId, 'the same runner, for life');
  assert.equal(s.stateOf('T2'), 'awake');
});

test('a paused box the provider lost: the wake finds it gone and a new box restores the save, the old key dead', async () => {
  const s = await setup(2048);
  const { runnerId } = await s.start('T2');
  await s.run();
  const first = s.fly.live()[0]!;
  const got = await s.boot('T2', first.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 'save1');
  await s.run();
  s.fly.lose(first.id);
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
  assert.equal(s.rowOf('T2').boxKeyHash, undefined);
  const second = s.fly.live()[0]!;
  assert.equal(second.config.metadata.tb_attempt, '2');
  assert.equal(await outcome(call(s.ctx, sync.heartbeat, { key: got.boxKey, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 1 } })), 'auth');
  assert.equal((await s.exchange(s.bootOf(second.id))).save.url, 'https://files.example/save1');
});

test('two quick messages to a sleeping box make one wake', async () => {
  const s = await setup(2048);
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 'save1');
  await s.run();
  await s.send(runnerId, 'T2', 'one');
  await s.send(runnerId, 'T2', 'two');
  assert.deepEqual(await s.run(), ['wakeFor', 'wakeFor', 'wakeBox']);
  assert.equal(s.fly.calls('POST', '/start'), 1);
  assert.equal(s.stateOf('T2'), 'awake');
  // A message while it's awake wakes nothing.
  await s.send(runnerId, 'T2', 'three');
  assert.deepEqual(await s.run(), []);
});

test("a message while it's saving keeps it up, and a box gone silent that the provider says is gone is replaced by itself", async () => {
  const s = await setup(2048);
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  await s.boot('T2', m.id);
  await s.sleepIdle(11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'saving');
  await s.send(runnerId, 'T2');
  assert.deepEqual(await s.run(), ['wakeFor']);
  assert.equal(s.stateOf('T2'), 'awake');
  // No heartbeat for the lease, and the provider no longer has the box: lost, and a new box comes by itself.
  s.fly.lose(m.id);
  await s.fireTimers(Date.now() + 30 * MINUTE);
  assert.equal(s.stateOf('T2'), 'awake', 'not on missed heartbeats alone');
  assert.deepEqual(await s.run(), ['checkBox', 'wakeBox']);
  assert.equal(s.stateOf('T2'), 'starting');
  assert.equal(s.fly.live().length, 1);
});

test('a virtual runner past maxBoxes refuses a new thread at once, saying so, and writes nothing', async () => {
  const s = await setup();
  // The helper's own box is creating: one of two.
  await call(s.ctx, boxes.setRunnerService, { key: OWNER, serviceId: s.serviceId, name: 'Cloud (Fly)', provider: 'fly', image: 'registry.fly.io/threadbear-box:1', box: { cpus: 2, memoryMb: 2048 }, limits: { maxBoxes: 2 } });
  await s.start('T2');
  const before = { runners: s.rows('runners').length, boxes: s.rows('boxes').length, commands: s.rows('commands').length };
  const err = await s.start('T3').catch((e: { data?: { kind: string; message: string } }) => e);
  assert.equal(err.data.kind, 'limit');
  assert.match(err.data.message, /Cloud \(Fly\) has 2 boxes up or starting, its limit/);
  assert.deepEqual({ runners: s.rows('runners').length, boxes: s.rows('boxes').length, commands: s.rows('commands').length }, before);
  // An asleep one doesn't count.
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 's');
  assert.equal(await outcome(s.start('T3')), 'ok');
});

test('the service action run twice, or its create retried after a lost answer, makes one box', async () => {
  const s = await setup();
  await s.start('T2');
  const boxId = s.rowOf('T2')._id;
  // The provider made it, but its answer never came: the retry finds it by its idempotency key.
  s.fly.loseAnswerNext('POST', '/machines', 503);
  await s.run();
  assert.equal(s.fly.live().length, 1);
  assert.equal(s.stateOf('T2'), 'starting');
  // Run again (Convex scheduling it twice): the row has its box, so nothing.
  await call(s.a, service.createBox, { boxId });
  await call(s.a, service.wakeBox, { boxId });
  assert.equal(s.fly.live().length, 1);
  assert.equal(s.rowOf('T2').boxAttempt, 1);
  // Two at once: the second finds the first's attempt on its way.
  const fresh = await s.start('T3');
  const b3 = s.rowOf('T3')._id;
  assert.ok(fresh);
  assert.equal((await call(s.ctx, service.claimAttempt, { boxId: b3, bootHash: 'a'.repeat(64) })).attempt, 1);
  assert.equal(await call(s.ctx, service.claimAttempt, { boxId: b3, bootHash: 'b'.repeat(64) }), null);
});

test("a provider that keeps failing fails the box with why; the next message tries a new attempt", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  s.fly.failNext('POST', '/machines', 422);
  await s.run();
  assert.equal(s.stateOf('T2'), 'failed');
  assert.match(s.rowOf('T2').boxState.error, /^fly: POST \/apps\/tb-boxes\/machines -> 422/);
  // Transient ones are tried again within the action.
  await s.ctx.db.insert('threads', { ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'inbox', needsYou: false });
  s.fly.failNext('POST', '/machines', 503);
  await s.send(runnerId, 'T2');
  assert.deepEqual(await s.run(), ['wakeFor', 'wakeBox']);
  assert.equal(s.stateOf('T2'), 'starting');
  assert.equal(s.fly.live()[0]!.config.metadata.tb_attempt, '2');
  // No provider set up (invariant W(d)): nothing changes, and it's tried again shortly.
  delete process.env.FLY_API_TOKEN;
  await s.start('T3');
  s.skip();
  await call(s.a, service.createBox, { boxId: s.rowOf('T3')._id });
  assert.equal(s.stateOf('T3'), 'creating');
  assert.equal(s.rowOf('T3').boxAttempt, undefined, 'no attempt minted');
  assert.ok((s.scheduled.at(-1) as { fn: string }).fn.endsWith('wakeBox'), 'tried again shortly');
  process.env.FLY_API_TOKEN = 'fly-token';
  await s.run();
  assert.equal(s.stateOf('T3'), 'starting');
});

test('a box lost while it was being made is made again, once', async () => {
  const s = await setup();
  await s.start('T2');
  const boxId = s.rowOf('T2')._id;
  // A create had claimed attempt 1 when the provider lost its box.
  await call(s.ctx, service.claimAttempt, { boxId, bootHash: 'd'.repeat(64) });
  assert.equal(await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'LOST', attempt: 1 } }), true);
  assert.equal(s.stateOf('T2'), 'creating');
  assert.deepEqual(await s.run(), ['createBox', 'createBox']);
  assert.equal(s.fly.live().length, 1);
  assert.equal(s.fly.live()[0]!.config.metadata.tb_attempt, '2');
  assert.equal(s.stateOf('T2'), 'starting');
});

test("a late or stale FAILED doesn't fail a newer attempt", async () => {
  const s = await setup();
  await s.start('T2');
  await s.run();
  const row = s.rowOf('T2');
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'LOST', attempt: 1 } });
  await s.run();
  assert.equal(s.rowOf('T2').boxAttempt, 2);
  assert.equal(await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'FAILED', error: 'old', attempt: 1 } }), false);
  assert.equal(s.stateOf('T2'), 'starting');
  assert.ok(row);
});

test('the reaper destroys orphans and older attempts, adopts a box whose create never reported, and never touches the current one', async () => {
  const s = await setup();
  await s.start('T2');
  await s.run();
  const current = s.fly.live()[0]!;
  const boxId = s.rowOf('T2')._id;
  const svc = s.serviceId;
  const machine = (id: string, tags: Record<string, string>, state = 'started') => s.fly.machines.push({ id, name: id, state, config: { metadata: { ...tags, tb_service: svc } } });
  machine('orphan', { tb_box: 'boxes:999', tb_attempt: '1' });
  machine('garbage', { tb_box: 'not an id', tb_attempt: 'x' });
  machine('older', { tb_box: boxId, tb_attempt: '0' });
  // Someone else's machine in the app, with no tb_service: never listed, never touched.
  s.fly.machines.push({ id: 'other', name: 'other', state: 'started', config: { metadata: {} } });
  // The helper's own box: its create claimed attempt 1 and made a machine, then died before reporting.
  const own = s.rowOf(THREAD);
  await call(s.ctx, service.claimAttempt, { boxId: own._id, bootHash: 'c'.repeat(64) });
  machine('unreported', { tb_box: own._id, tb_attempt: '1' });
  await s.reap();
  const alive = s.fly.live().map((m) => m.id).sort();
  assert.deepEqual(alive, [current.id, 'other', 'unreported'].sort());
  assert.equal(s.rowOf(THREAD).providerBoxId, 'unreported');
  assert.equal(s.stateOf(THREAD), 'starting');
  assert.equal(s.rowOf('T2').providerBoxId, current.id);
  assert.equal(s.stateOf('T2'), 'starting');
  // An archived thread's box that outlived its delete goes; so does a failed one's.
  await call(s.ctx, boxes.report, { threadId: THREAD, event: { type: 'FAILED', error: 'x', attempt: 1 } });
  await s.reap();
  assert.ok(!s.fly.live().some((m) => m.id === 'unreported'));
});

test("the billing guard pauses an asleep box that's still running, and the reaper loses one that stopped", async () => {
  const s = await setup(2048);
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 'save1');
  // Its pause failed (Fly down): still running.
  s.fly.failNext('POST', '/suspend', 500, 3);
  await s.run();
  assert.equal(s.fly.byId(m.id)!.state, 'created');
  // The guard tries again once the failed pause's backoff is out.
  await later(6 * MINUTE, () => s.reap());
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  // Stopped while asleep (its snapshot gone): lost, and the next wake starts a new box.
  s.fly.byId(m.id)!.state = 'stopped';
  await s.reap();
  assert.equal(s.rowOf('T2').boxKeyHash, undefined);
  assert.equal(s.fly.live().length, 0);
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
});

test('a box stuck being deleted is deleted again by the reaper', async () => {
  const s = await setup();
  await s.start('T2');
  await s.run();
  s.fly.failNext('GET', '/machines', 500, 3);
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  await s.run();
  assert.equal(s.stateOf('T2'), 'destroying');
  await later(11 * MINUTE, () => s.reap());
  await s.run();
  // Never saved: it can't come back.
  assert.equal(s.stateOf('T2'), 'expired');
  assert.equal(s.fly.live().length, 0);
});

// At noon UTC, so its hour doesn't cross into tomorrow's count.
const atNoon = <T>(f: () => Promise<T>) => later(Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`) - Date.now(), f);

test("a box past its day's hours is asked to save even with a turn running and a message waiting", () => atNoon(async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  await s.boot('T2', s.fly.live()[0]!.id);
  await call(s.ctx, boxes.setRunnerService, { key: OWNER, serviceId: s.serviceId, name: 'Cloud (Fly)', provider: 'fly', image: 'registry.fly.io/threadbear-box:1', box: { cpus: 2, memoryMb: 2048 }, limits: { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 } });
  const t = s.rows('threads').find((r) => r.threadId === 'T2')!;
  t.status = 'running';
  await s.send(runnerId, 'T2');
  assert.equal(await s.sleepIdle(30 * MINUTE), 0, 'within its hours, busy: up');
  assert.equal(await s.sleepIdle(61 * MINUTE), 1);
  assert.equal(s.stateOf('T2'), 'saving');
  assert.equal(s.rowOf('T2').boxState.capped, true);
}));

test("archived threads' saves go after the virtual runner's days, and the thread then can't come back", async () => {
  const s = await setup();
  await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  await s.save(got.boxKey, 'save1');
  await s.run();
  assert.equal(s.stateOf('T2'), 'gone');
  assert.equal(await later(13 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {})), 0);
  assert.ok(s.hasFile('save1'));
  assert.equal(await later(15 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {})), 1);
  assert.equal(s.hasFile('save1'), false);
  assert.equal(s.stateOf('T2'), 'expired');
  assert.equal(s.rowOf('T2').save, undefined);
});

test("deleting a box's thread deletes its box; one taken back out of the den within the grace keeps it", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  const write = (view: string) => call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view, needsYou: false }] });
  await write('den');
  await write('inbox');
  assert.deepEqual(await s.run(), ['archiveIfStill']);
  assert.equal(s.stateOf('T2'), 'awake');
  await call(s.ctx, sync.removeThreads, { key: got.boxKey, threadIds: ['T2'] });
  assert.deepEqual(await s.run(), ['archiveIfStill']);
  await s.save(got.boxKey, 'last');
  assert.deepEqual(await s.run(), ['destroyBox']);
  assert.equal(s.stateOf('T2'), 'gone');
});

test('a box asleep, starting or failed counts as reachable: listed with its state, and a move to it is let through', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  // Never heartbeated, creating: listed for the main Mac's runner with its state.
  const listed = async () => (await call(s.ctx, sync.otherRunnersList, { key: OWNER, runnerId: 'main-mac' })).find((r: { runnerId: string }) => r.runnerId === runnerId);
  assert.deepEqual((await listed()).box, { state: 'creating' });
  // A machine's runner has no box field.
  await s.ctx.db.insert('runners', { runnerId: 'mini', name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 0, lastSeenAt: Date.now() - 60 * MINUTE });
  assert.equal((await call(s.ctx, sync.otherRunnersList, { key: OWNER, runnerId: 'main-mac' })).find((r: { runnerId: string }) => r.runnerId === 'mini').box, undefined);
  // Its own thread can move to it while it starts (its thread row on the mini).
  await s.ctx.db.insert('threads', { ...THREAD_BASICS, threadId: 'T2', runnerId: 'mini', title: 't', view: 'inbox', needsYou: false });
  assert.equal(await outcome(call(s.ctx, moves.startMove, { key: OWNER, threadId: 'T2', to: runnerId })), 'ok');
  // Another thread can't, and an offline machine still can't take one.
  await s.ctx.db.insert('threads', { ...THREAD_BASICS, threadId: 'T9', runnerId: 'mini', title: 't', view: 'inbox', needsYou: false });
  assert.equal(await outcome(call(s.ctx, moves.startMove, { key: OWNER, threadId: 'T9', to: runnerId })), 'conflict');
  // Archived and gone: not listed as reachable.
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  assert.deepEqual((await listed()).box, { state: 'destroying' });
});

test("the phone never picks a box's runner for a new thread, and can't name one", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  // The box heartbeats with the owner key once (as the test helper's can): still never the phone's main runner.
  await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 99 } });
  await s.ctx.db.insert('tokens', { hash: await sha256('phone-token'), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  await call(s.ctx, phone.setRunnerOrder, { token: 'phone-token', runnerIds: [runnerId] });
  const id = await call(s.ctx, phone.create, { token: 'phone-token', text: 'new' });
  assert.equal(s.rows('commands').find((c) => c._id === id)!.runnerId, 'any');
  assert.equal(await outcome(call(s.ctx, phone.create, { token: 'phone-token', text: 'new', runnerId })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, kind: 'create', args: { text: 'x' } })), 'badArgs');
  assert.ok(got);
});

test('only the owner makes, changes and lists virtual runners, and the values are checked', async () => {
  const s = await setup();
  // Fly can't pause a box over 2 GB, so for now none is made.
  assert.equal(await outcome(call(s.ctx, boxes.setRunnerService, { key: OWNER, name: 'Huge', provider: 'fly', image: 'img:1', box: { cpus: 4, memoryMb: 8192 } })), 'badArgs');
  const made = await call(s.ctx, boxes.setRunnerService, { key: OWNER, name: 'Big', provider: 'fly', image: 'img:1', box: { cpus: 4, memoryMb: 2048 }, region: 'syd', limits: { maxBoxes: 3 } });
  const listed = await call(s.ctx, boxes.runnerServices, { key: OWNER });
  const big = listed.find((x: { serviceId: string }) => x.serviceId === made);
  assert.deepEqual(big.limits, { maxBoxes: 3, idleSleepMinutes: 10, maxAwakeHoursPerDay: 8, deleteAfterDays: 14 });
  assert.equal(big.region, 'syd');
  assert.equal(listed.find((x: { serviceId: string }) => x.serviceId === s.serviceId).running, 1, "the helper's own box is creating");
  const bad = (a: Record<string, unknown>) => outcome(call(s.ctx, boxes.setRunnerService, { key: OWNER, name: 'X', provider: 'fly', image: 'img:1', box: { cpus: 1, memoryMb: 1024 }, ...a }));
  assert.equal(await bad({ provider: 'aws' }), 'badArgs');
  assert.equal(await bad({ box: { cpus: 1, memoryMb: 1000 } }), 'badArgs');
  assert.equal(await bad({ box: { cpus: 0, memoryMb: 1024 } }), 'badArgs');
  assert.equal(await bad({ image: 'has space' }), 'badArgs');
  assert.equal(await bad({ limits: { maxBoxes: 0 } }), 'badArgs');
  assert.equal(await bad({ region: 'SYD!' }), 'badArgs');
  // The box key, and a runner key, can't.
  const got = await (async () => {
    await s.start('T2');
    await s.run();
    return s.boot('T2', s.fly.live()[0]!.id);
  })();
  assert.equal(await outcome(call(s.ctx, boxes.runnerServices, { key: got.boxKey })), 'forbidden');
  assert.equal(await outcome(call(s.a, boxes.startThread, { key: got.boxKey, serviceId: s.serviceId, threadId: 'T5', repo: REPO, login: LOGIN, text: 'x' })), 'forbidden');
  // A start with a bad first message writes nothing.
  assert.equal(await outcome(call(s.a, boxes.startThread, { key: OWNER, serviceId: s.serviceId, threadId: 'T6', repo: REPO, login: LOGIN, text: 'x', permissionMode: 'yolo' })), 'badArgs');
  assert.equal(s.rows('boxes').some((r) => r.threadId === 'T6'), false);
  // A thread that's already somewhere isn't started on one (it would move there), nor is one that has a box.
  await s.ctx.db.insert('threads', { ...THREAD_BASICS, threadId: 'T7', runnerId: BOX_RUNNER, title: 't', view: 'inbox', needsYou: false });
  assert.equal(await outcome(s.start('T7')), 'conflict');
  assert.equal(await outcome(s.start('T2')), 'conflict');
  assert.equal(s.rows('runners').filter((r) => r.box).length, 1, "T2's runner only: a refused start writes none");
});

// ------------------------------------------------------------ Codex's review of 66ccfc1c4 (18 Nov 2026)

const boxIdOf = (s: Awaited<ReturnType<typeof setup>>, threadId: string) => s.rowOf(threadId)._id;
// The virtual runner's limits (and size, past what setRunnerService now allows, as an older one's could be).
const setLimits = async (s: Awaited<ReturnType<typeof setup>>, limits: Record<string, number>, memoryMb = 2048) => {
  const row = s.rows('runnerServices').find((r) => r._id === s.serviceId)!;
  Object.assign(row, { box: { cpus: 2, memoryMb }, limits: { ...row.limits, ...limits } });
};

// 1. The day's cap didn't depend on the box: one that never saved stayed up for ever.
for (const memoryMb of [2048, 4096]) {
  test(`past its day's hours, a ${memoryMb} MB box whose save never comes sleeps anyway (${memoryMb > 2048 ? 'kept running, asked again' : 'paused'})`, () => atNoon(async () => {
    const s = await setup(memoryMb);
    const { runnerId } = await s.start('T2');
    await s.run();
    const m = s.fly.live()[0]!;
    const got = await s.boot('T2', m.id);
    await setLimits(s, { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 }, memoryMb);
    await later(60 * MINUTE, () => s.beat(got.boxKey, runnerId));
    assert.equal(await s.sleepIdle(61 * MINUTE), 1);
    assert.equal(s.rowOf('T2').boxState.capped, true);
    // It heartbeats, but never saves.
    await later(70 * MINUTE, () => s.beat(got.boxKey, runnerId));
    await s.fireTimers(Date.now() + 72 * MINUTE);
    assert.equal(s.stateOf('T2'), 'asleep');
    await s.run();
    if (memoryMb <= 2048) {
      assert.equal(s.fly.byId(m.id)!.state, 'suspended', 'paused with its memory: nothing lost');
      assert.ok(s.rowOf('T2').boxKeyHash, 'its key kept, to resume');
    } else {
      // Codex's third round: it can't pause, and deleting it would lose its work.
      assert.equal(s.fly.byId(m.id)!.state, 'created', 'kept running');
      assert.ok(s.rowOf('T2').boxKeyHash);
      assert.ok(s.rowOf('T2').keptRunningSince);
      const asks = () => s.rows('commands').filter((c) => c.runnerId === runnerId && c.kind === 'save').length;
      const before = asks();
      await later(72 * MINUTE, () => call(s.ctx, service.retryKeptSaves, {}));
      assert.equal(asks(), before, 'one save asked for at a time');
    }
  }));
}

// 2. A wake went past maxBoxes.
test('a wake past maxBoxes waits, its message pending, and wakes when another box sleeps', async () => {
  const s = await setup();
  // The helper's own box is creating: one of two.
  await setLimits(s, { maxBoxes: 2 });
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.sleepWith('T2', got.boxKey);
  const { runnerId: r3 } = await s.start('T3');
  await s.run();
  const got3 = await s.boot('T3', s.fly.live().find((m) => m.config.metadata.tb_box === boxIdOf(s, 'T3'))!.id);
  const cmd = await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'asleep', 'no room: it waits');
  assert.ok(s.rowOf('T2').wantsWakeAt);
  assert.equal(s.rows('commands').find((c) => c._id === cmd)!.state, 'pending');
  const listed = (await call(s.ctx, sync.otherRunnersList, { key: OWNER, runnerId: 'main-mac' })).find((r: { runnerId: string }) => r.runnerId === runnerId);
  assert.deepEqual(listed.box, { state: 'asleep', waiting: true });
  // T3 sleeps: T2 wakes in its place.
  await s.sleepWith('T3', got3.boxKey);
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.rowOf('T2').wantsWakeAt, undefined);
  assert.ok(r3);
});

// 3. A sleep's slow suspend finished after a wake had resumed the box.
test('a wake while the box is pausing waits for the pause, and the box ends up running', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 'save1');
  s.skip();
  const boxId = boxIdOf(s, 'T2');
  const held = s.fly.hold((r) => r.path.endsWith('/suspend'));
  const sleeping = call(s.a, service.sleepBox, { boxId });
  await held.arrived;
  // A message comes while the suspend is on its way.
  await s.send(runnerId, 'T2');
  s.skip();
  assert.equal(await call(s.ctx, boxes.wakeFor, { runnerId }), true);
  assert.equal(s.stateOf('T2'), 'waking');
  await call(s.a, service.wakeBox, { boxId });
  assert.equal(s.stateOf('T2'), 'waking', 'the wake waits for the pause');
  assert.equal(s.fly.calls('POST', '/start'), 0);
  held.release();
  await sleeping;
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.byId(m.id)!.state, 'started', 'running, as the row says');
});

// 4. A box's pause support came from its virtual runner's size now, not the size it was made at.
test('a box made at 4096 MB is deleted on sleep after its virtual runner is made 2 GB; a refused pause is only tried again', async () => {
  const s = await setup(4096);
  await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await setLimits(s, {}, 2048);
  await s.sleepWith('T2', got.boxKey);
  assert.equal(s.fly.calls('POST', '/suspend'), 0, 'not tried');
  assert.equal(s.fly.live().length, 0);
  assert.equal(s.rowOf('T2').boxKeyHash, undefined);
  // A 2 GB box whose suspend Fly refuses once: not deleted, and not taken as one that can't pause (Codex's sixth round).
  const { runnerId } = await s.start('T3');
  await s.run();
  const m3 = s.fly.live()[0]!;
  const got3 = await s.boot('T3', m3.id);
  s.fly.failNext('POST', '/suspend', 400);
  await s.sleepWith('T3', got3.boxKey);
  assert.notEqual(s.fly.byId(m3.id)!.state, 'destroyed');
  assert.ok(s.rowOf('T3').boxKeyHash);
  await later(6 * MINUTE, () => s.reap());
  assert.equal(s.fly.byId(m3.id)!.state, 'suspended', 'the guard paused it next time');
  assert.ok(runnerId);
});

// 5. A fresh thread's create was refused as THREAD_ELSEWHERE: no thread row yet.
test("a new thread's box takes its create before the thread has a row, and nothing else of another thread", async () => {
  const s = await setup();
  const { runnerId, commandId } = await s.start('T2');
  await s.run();
  const got = await s.exchange(s.bootOf(s.fly.live()[0]!.id));
  assert.equal(s.rows('threads').some((t) => t.threadId === 'T2'), false);
  assert.equal(await call(s.ctx, sync.takeCommand, { key: got.boxKey, commandId }), true);
  assert.equal(s.rows('commands').find((c) => c._id === commandId)!.state, 'taken');
  assert.ok(runnerId);
});

// 6. An archived box thread couldn't be unarchived.
test('an archived thread comes back on a new box from its save when unarchived', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.archive('T2', runnerId, got.boxKey, 'save1');
  // Unarchived from the Mac (or the phone, through the same queue).
  const cmd = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
  const m = s.fly.live()[0]!;
  assert.equal(m.config.metadata.tb_attempt, '2');
  const back = await s.exchange(s.bootOf(m.id));
  assert.equal(back.save.url, 'https://files.example/save1');
  assert.equal(await call(s.ctx, sync.takeCommand, { key: back.boxKey, commandId: cmd }), true);
});

test("once an archived thread's save is deleted, what's sent to it fails saying it can't come back", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.archive('T2', runnerId, got.boxKey, 'save1');
  await later(15 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {}));
  assert.equal(s.stateOf('T2'), 'expired');
  const cmd = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  const c = s.rows('commands').find((x) => x._id === cmd)!;
  assert.equal(c.state, 'failed');
  assert.match(c.note, /can't come back/);
  assert.equal(s.fly.live().length, 0);
  assert.deepEqual((await call(s.ctx, sync.otherRunnersList, { key: OWNER, runnerId: 'main-mac' })).find((r: { runnerId: string }) => r.runnerId === runnerId).box, { state: 'expired' });
});

// 7. The reaper acted on a plan the row had moved on from, and a refused RESUMED stopped the wake.
test("a reaper step planned before a wake resumed the box does nothing", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepWith('T2', got.boxKey);
  // Its snapshot went: stopped. The reaper plans a loss.
  s.fly.byId(m.id)!.state = 'stopped';
  const box = { providerBoxId: m.id, state: 'stopped', boxId: boxIdOf(s, 'T2'), attempt: 1 };
  const [step] = await call(s.ctx, service.reapPlan, { serviceId: s.serviceId, boxes: [box] });
  assert.equal(step.do, 'lost');
  // Meanwhile a message wakes it, and it comes back on the same box.
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(await call(s.ctx, service.reapStep, { serviceId: s.serviceId, box: step.box, do: step.do, seen: step.seen }), false);
  assert.equal(s.stateOf('T2'), 'awake');
  assert.ok(s.rowOf('T2').boxKeyHash);
  assert.equal(await outcome(s.beat(got.boxKey, runnerId)), 'ok');
});

test("the reaper's loss waits for a wake on the same box, and is dropped when the row has moved on", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepWith('T2', got.boxKey);
  s.fly.byId(m.id)!.state = 'stopped';
  s.skip();
  // The reaper asks the provider again, under the box's op lease: held there while a message comes.
  const held = s.fly.hold((r) => r.query.get('metadata.tb_box') !== null);
  const reaping = call(s.a, service.reapService, { serviceId: s.serviceId });
  await held.arrived;
  await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  await call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  assert.equal(s.stateOf('T2'), 'waking', 'the wake waits for the reaper');
  held.release();
  await reaping;
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  assert.equal(s.rowOf('T2').boxAttempt, 1, 'the same box');
});

test("a resume that isn't taken (its key went meanwhile) goes on to a new box", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepWith('T2', got.boxKey);
  await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  const held = s.fly.hold((r) => r.path.endsWith('/start'));
  const waking = call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  await held.arrived;
  // The paused box is reported lost while it starts: its key goes.
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'LOST', attempt: 1 } });
  held.release();
  await waking;
  assert.equal(s.stateOf('T2'), 'starting');
  assert.ok(s.fly.live().some((x) => x.config.metadata.tb_attempt === '2'));
});

// 8. A move to or from a sleeping box never woke it.
test('a move off a sleeping box wakes it, and runs to the end', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepWith('T2', got.boxKey);
  await s.ctx.db.insert('runners', { runnerId: 'main-mac', name: 'main', version: 'v', startedAt: AT, draining: false, threadCount: 0, lastSeenAt: Date.now() });
  const { moveId } = await call(s.ctx, moves.startMove, { key: OWNER, threadId: 'T2', to: 'main-mac' });
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake', 'woken to take its part');
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  const box = got.boxKey;
  await call(s.ctx, moves.moveInfo, { key: box, moveId, info: { cwd: '/x' } });
  await call(s.ctx, moves.moveReady, { key: OWNER, moveId, plan: { cwd: '/x' }, sealKey: `${'A'.repeat(43)}=` });
  await call(s.ctx, moves.moveFrozen, { key: box, moveId });
  const url: string = await call(s.ctx, moves.moveChunkUrl, { key: box, moveId });
  const ticket = new URL(url).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: s.file('chunk1'), bytes: 1000 }), true);
  await call(s.ctx, moves.movePacked, { key: box, moveId, chunks: ['chunk1'], sha256: 'a'.repeat(64), bytes: 1000 });
  assert.deepEqual(await call(s.ctx, moves.moveChunks, { key: OWNER, moveId }), ['https://files.example/chunk1']);
  await call(s.ctx, moves.moveClaim, { key: OWNER, moveId });
  await s.run();
  await call(s.ctx, moves.moveDone, { key: OWNER, moveId });
  assert.equal(s.rows('threadMoves').find((x) => x.moveId === moveId)!.state, 'done');
  assert.equal(s.rows('threads').find((t) => t.threadId === 'T2')!.runnerId, 'main-mac');
});

// 9. The crons' bounded scans saw the same first rows every run.
test('the idle cron and the reaper reach every box, a page at a time', async () => {
  const s = await setup();
  await setLimits(s, { maxBoxes: 10 });
  for (const t of ['T2', 'T3', 'T4']) {
    await s.start(t);
    await s.run();
    await s.boot(t, s.fly.live().find((m) => m.config.metadata.tb_box === boxIdOf(s, t))!.id);
  }
  assert.equal(await later(11 * MINUTE, () => call(s.ctx, service.sleepIdleBoxes, { numItems: 1 })), 1);
  await later(11 * MINUTE, () => s.run());
  assert.deepEqual(['T2', 'T3', 'T4'].map((t) => s.stateOf(t)), ['saving', 'saving', 'saving']);
  // Five machines nobody wants, two a run.
  for (let i = 0; i < 5; i++) s.fly.machines.push({ id: `orphan${i}`, name: `orphan${i}`, state: 'started', config: { metadata: { tb_box: 'boxes:999', tb_attempt: '1', tb_service: s.serviceId } } });
  s.skip();
  await call(s.a, service.reapService, { serviceId: s.serviceId, chunk: 2 });
  await s.run();
  assert.equal(s.fly.live().filter((m) => m.id.startsWith('orphan')).length, 0);
  assert.equal(s.fly.live().length, 3, 'the three boxes stay');
});

test("an archived thread isn't woken for marking it seen, only for unarchiving or a message", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.archive('T2', runnerId, got.boxKey, 'save1');
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { markSeen: true } });
  assert.deepEqual(await s.run(), []);
  assert.equal(s.stateOf('T2'), 'gone');
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
});

// ------------------------------------------------------------ Codex's second review of the fixes (18 Nov 2026)

// 1. A command waiting for the box kept it from its day's cap.
test("a box that never takes its create is capped all the same; what's waiting waits for tomorrow's hours", () => atNoon(async () => {
  const s = await setup();
  const { runnerId, commandId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  // Up, heartbeating, but it never takes its create.
  const got = await s.exchange(s.bootOf(m.id));
  await s.beat(got.boxKey, runnerId);
  await setLimits(s, { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 });
  await later(60 * MINUTE, () => s.beat(got.boxKey, runnerId));
  assert.equal(await s.sleepIdle(61 * MINUTE), 1);
  assert.equal(s.rowOf('T2').boxState.capped, true);
  await later(70 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 72 * MINUTE);
  assert.equal(s.stateOf('T2'), 'asleep');
  await later(72 * MINUTE, () => s.run());
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  // Its create still waits, and so does the box: today's hours are used.
  assert.equal(s.rows('commands').find((c) => c._id === commandId)!.state, 'pending');
  assert.ok(s.rowOf('T2').waitsForHours, "waiting for tomorrow's hours");
  assert.equal(s.rowOf('T2').wantsWakeAt, undefined, 'not with those waiting for room');
  assert.equal(await later(80 * MINUTE, () => call(s.ctx, boxes.wakeWaiting, { serviceId: s.serviceId })), 0);
  // Tomorrow it wakes.
  assert.equal(await later(24 * 60 * MINUTE, () => call(s.ctx, boxes.wakeWaiting, { serviceId: s.serviceId })), 1);
  assert.equal(s.stateOf('T2'), 'waking');
}));

test('Mike can wake a box past its day\'s hours, for the rest of the day', () => atNoon(async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await setLimits(s, { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 });
  await later(60 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.sleepIdle(61 * MINUTE);
  await later(61 * MINUTE, () => s.save(got.boxKey, 'save1'));
  await later(61 * MINUTE, () => s.run());
  await later(62 * MINUTE, () => s.send(runnerId, 'T2'));
  await later(62 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'asleep', 'past its hours: it waits');
  assert.equal(await outcome(later(63 * MINUTE, () => call(s.ctx, boxes.wakePastHours, { key: got.boxKey, threadId: 'T2' }))), 'forbidden');
  await later(63 * MINUTE, () => call(s.ctx, boxes.wakePastHours, { key: OWNER, threadId: 'T2' }));
  await later(63 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'awake');
  // And the cap leaves it be for the rest of today.
  assert.equal(await s.sleepIdle(120 * MINUTE), 0);
}));

// 2. Archiving deleted the box without saving.
test('archiving a box that is up saves it first, and unarchiving comes back to that save', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.save(got.boxKey, 'early');
  await s.archive('T2', runnerId, got.boxKey, 'final');
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  const back = await s.exchange(s.bootOf(s.fly.live()[0]!.id));
  assert.equal(back.save.url, 'https://files.example/final');
});

test("an archive whose save never comes keeps the box paused, unarchiving resumes it, and it goes after the virtual runner's days", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  assert.equal(s.stateOf('T2'), 'archiving');
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'shelved');
  await s.run();
  assert.equal(s.fly.byId(m.id)!.state, 'suspended', 'kept, paused: its work is in it');
  assert.ok(s.rowOf('T2').boxKeyHash);
  // Unarchived: the same box resumes.
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  assert.equal(s.rowOf('T2').boxAttempt, 1);
  await s.takeAll(got.boxKey, runnerId);
  // Shelved again and left past its days: the kept box goes, and it can't come back.
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'inbox', needsYou: false }] });
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  await s.run();
  assert.equal(s.stateOf('T2'), 'shelved');
  await later(15 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {}));
  await later(15 * 24 * 60 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'expired');
  assert.equal(s.fly.live().length, 0);
});

// 3. An unarchive sent while the box was being deleted was never acted on.
test('an unarchive sent while its box is being deleted brings it back once it has gone', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await s.save(got.boxKey, 'final');
  assert.equal(s.stateOf('T2'), 'destroying');
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
  assert.ok(s.fly.live().some((m) => m.config.metadata.tb_attempt === '2'));
});

// 4. A run that had lost its op lease went on acting.
test('an action that lost its op lease does nothing more with the provider or the row', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepIdle(11 * MINUTE);
  await s.save(got.boxKey, 'save1');
  s.skip();
  const boxId = boxIdOf(s, 'T2');
  const held = s.fly.hold((r) => r.path.endsWith('/suspend'));
  const sleeping = call(s.a, service.sleepBox, { boxId });
  await held.arrived;
  await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  // Its lease ran out meanwhile, and another run holds it now.
  s.rowOf('T2').op = { id: 'another-run', name: 'wakeBox', until: Date.now() + 60 * MINUTE };
  held.release();
  await sleeping;
  assert.equal(s.fly.calls('POST', '/start'), 0, 'no resume from the stale run');
  assert.equal(s.rowOf('T2').op.id, 'another-run');
  assert.equal(s.stateOf('T2'), 'waking');
});

// 5. Pruning a save left a waiting unarchive waiting for ever.
test("pruning an archived thread's save fails an unarchive that was waiting for room", async () => {
  const s = await setup();
  await setLimits(s, { maxBoxes: 2 });
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.archive('T2', runnerId, got.boxKey);
  await s.start('T3');
  await s.run();
  const cmd = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.ok(s.rowOf('T2').wantsWakeAt, 'no room: waiting');
  await later(15 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {}));
  await s.run();
  const c = s.rows('commands').find((x) => x._id === cmd)!;
  assert.equal(c.state, 'failed');
  assert.match(c.note, /can't come back/);
});

// 6. Only the first 50 waiting for an expired thread failed, maybe not the one that asked.
test("every command waiting for an expired thread fails, the one that asked first", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.archive('T2', runnerId, got.boxKey);
  // 60 waiting already (queued while it was being deleted, say).
  for (let i = 0; i < 60; i++) await load('machines').queued(s.ctx, { runnerId, threadId: 'T2', kind: 'update', args: { markSeen: true }, createdAt: Date.now() });
  await later(15 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {}));
  s.skip();
  const cmd = await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.rows('commands').find((x) => x._id === cmd)!.state, 'failed');
  await s.run();
  assert.equal(s.rows('commands').filter((c) => c.runnerId === runnerId && c.state === 'pending').length, 0);
});

// 7. A box could sleep mid-move.
test("a moving box isn't slept, idle or past its hours, and a later move step wakes a sleeping one", () => atNoon(async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.ctx.db.insert('runners', { runnerId: 'main-mac', name: 'main', version: 'v', startedAt: AT, draining: false, threadCount: 0, lastSeenAt: Date.now() + 2 * 60 * MINUTE });
  const { moveId } = await call(s.ctx, moves.startMove, { key: OWNER, threadId: 'T2', to: 'main-mac' });
  await s.run();
  await call(s.ctx, moves.moveInfo, { key: got.boxKey, moveId, info: { cwd: '/x' } });
  assert.equal(await s.sleepIdle(11 * MINUTE), 0, 'not idle while it moves');
  await setLimits(s, { maxAwakeHoursPerDay: 1 });
  // Slept anyway (as a box could before): the next step of the move wakes it, past its hours.
  await later(40 * MINUTE, () => call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'IDLE', attempt: 1 } }));
  await later(40 * MINUTE, () => s.save(got.boxKey, 'save1'));
  await later(40 * MINUTE, () => s.run());
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  await later(41 * MINUTE, () => call(s.ctx, moves.moveReady, { key: OWNER, moveId, plan: { cwd: '/x' }, sealKey: `${'A'.repeat(43)}=` }));
  await later(41 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'awake', 'woken, as it moves');
  await later(60 * MINUTE, () => s.beat(got.boxKey, runnerId));
  assert.equal(await s.sleepIdle(61 * MINUTE), 0, 'the cap waits for the move');
  // A move with no step for an hour no longer holds it up.
  await later(110 * MINUTE, () => s.beat(got.boxKey, runnerId));
  assert.equal(await s.sleepIdle(112 * MINUTE), 1, 'past its hours, the move gone quiet: it sleeps');
}));

// 8. The crons read only the first 100 virtual runners.
test('the reaper and the waiting-wake sweep reach every virtual runner, a page at a time', async () => {
  const s = await setup();
  const ids = [s.serviceId];
  for (let i = 0; i < 3; i++) ids.push(await call(s.ctx, boxes.setRunnerService, { key: OWNER, name: `V${i}`, provider: 'fly', image: 'img:1', box: { cpus: 1, memoryMb: 1024 } }));
  for (const [i, id] of ids.entries()) s.fly.machines.push({ id: `orphan${i}`, name: `o${i}`, state: 'started', config: { metadata: { tb_box: 'boxes:999', tb_attempt: '1', tb_service: id } } });
  s.skip();
  await call(s.a, service.reapBoxes, { numItems: 1 });
  await s.run();
  assert.equal(s.fly.live().filter((m) => m.id.startsWith('orphan')).length, 0);
  const before = s.scheduled.length;
  await call(s.ctx, boxes.wakeAllWaiting, { numItems: 1 });
  for (let i = 0; i < 10; i++) {
    const next = (s.scheduled.slice(before) as { fn: string; args: Record<string, unknown> }[]).filter((j) => j.fn.endsWith('wakeAllWaiting'));
    if (next.length <= i) break;
    await call(s.ctx, boxes.wakeAllWaiting, next[i]!.args);
  }
  const swept = (s.scheduled.slice(before) as { fn: string; args: { serviceId?: string } }[]).filter((j) => j.fn.endsWith('wakeWaiting')).map((j) => j.args.serviceId);
  assert.deepEqual(swept.sort(), [...ids].sort());
});

// ------------------------------------------------------------ Codex's third round (18 Nov 2026)

// 1. A box that can't pause was deleted with work newer than its save.
test("an archived box that can't pause and never saved is kept running and asked to save until it does", async () => {
  const s = await setup(4096);
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.save(got.boxKey, 'old');
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'shelved');
  await s.run();
  assert.equal(s.fly.byId(m.id)!.state, 'created', "kept running: it can't pause, and it holds work newer than its save");
  assert.ok(s.rowOf('T2').keptRunningSince);
  // Asked to save again; it does, and only then does the box go.
  for (const c of s.rows('commands').filter((c) => c.runnerId === runnerId && c.kind === 'save' && c.state === 'pending')) Object.assign(c, { state: 'done', commandState: { kind: 'done', at: Date.now() } });
  assert.equal(await call(s.ctx, service.retryKeptSaves, {}), 1);
  assert.equal(s.rows('commands').filter((c) => c.runnerId === runnerId && c.kind === 'save' && c.state === 'pending').length, 1);
  assert.equal(await call(s.ctx, service.retryKeptSaves, {}), 0, 'backing off');
  await s.save(got.boxKey, 'newest');
  await s.run();
  assert.equal(s.stateOf('T2'), 'gone');
  assert.equal(s.rowOf('T2').save.storageId, 'newest');
  assert.equal(s.fly.live().length, 0);
});

test("a refused suspend leaves a box with unsaved work running for the guard to try again, and its wake takes it up as it is", () => atNoon(async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await setLimits(s, { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 });
  await later(60 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.sleepIdle(61 * MINUTE);
  await later(70 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 72 * MINUTE);
  assert.equal(s.stateOf('T2'), 'asleep');
  s.fly.failNext('POST', '/suspend', 400);
  await later(72 * MINUTE, () => s.run());
  assert.notEqual(s.fly.byId(m.id)!.state, 'destroyed');
  assert.ok(s.rowOf('T2').suspendFails, 'its pause is tried again after a backoff');
  // Mike wakes it: the same box carries on, nothing made.
  await later(73 * MINUTE, () => call(s.ctx, boxes.wakePastHours, { key: OWNER, threadId: 'T2' }));
  await later(73 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.live().length, 1);
  assert.equal(s.rowOf('T2').boxAttempt, 1);
  assert.equal(await outcome(s.beat(got.boxKey, runnerId)), 'ok');
}));

// 2. Archiving a kept box while it woke deleted its only copy.
test('archiving a kept box while it wakes saves first, or keeps it, rather than deleting it', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  await s.run();
  assert.equal(s.stateOf('T2'), 'shelved');
  // It starts to wake (a message); archived again before it's up.
  s.skip();
  assert.equal(await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'WAKE' } }), true);
  assert.equal(s.stateOf('T2'), 'waking');
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  assert.equal(s.stateOf('T2'), 'archiving');
  assert.ok(s.rows('commands').some((c) => c.runnerId === runnerId && c.kind === 'save' && c.state === 'pending'));
  await s.run();
  // No save comes: kept again, not deleted.
  await s.fireTimers(Date.now() + 11 * MINUTE);
  await s.run();
  assert.equal(s.stateOf('T2'), 'shelved');
  assert.notEqual(s.fly.byId(m.id)!.state, 'destroyed');
  assert.ok(s.rowOf('T2').boxKeyHash);
});

// 3. A message cancelled a capped save.
test("a message doesn't cancel a save its day's hours asked for: it waits, unless Mike says", () => atNoon(async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await setLimits(s, { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 });
  await later(60 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.sleepIdle(61 * MINUTE);
  assert.equal(s.rowOf('T2').boxState.capped, true);
  await later(62 * MINUTE, () => s.send(runnerId, 'T2'));
  await later(62 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'saving');
  assert.equal(s.rowOf('T2').boxState.capped, true, 'still on its way to sleep');
  assert.ok(s.rowOf('T2').waitsForHours);
  await later(63 * MINUTE, () => call(s.ctx, boxes.wakePastHours, { key: OWNER, threadId: 'T2' }));
  await later(63 * MINUTE, () => s.run());
  assert.equal(s.stateOf('T2'), 'awake');
}));

// 5. A waking command past the first 50 pending wasn't seen.
test('a waking command behind fifty that wake nothing still brings an archived box back', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await s.save(got.boxKey, 'final');
  assert.equal(s.stateOf('T2'), 'destroying');
  for (let i = 0; i < 60; i++) await load('machines').queued(s.ctx, { runnerId, threadId: 'T2', kind: 'update', args: { markSeen: true }, createdAt: Date.now() });
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
});

// 6. Fifty boxes waiting for tomorrow's hours kept one waiting for room from waking.
test("boxes waiting for room wake though many waiting for tomorrow's hours came first", async () => {
  const s = await setup();
  await setLimits(s, { maxBoxes: 100, maxAwakeHoursPerDay: 1 });
  const today = new Date().toISOString().slice(0, 10);
  const asleepPastHours = (threadId: string) => Object.assign(s.rowOf(threadId), { boxState: { kind: 'asleep', since: Date.now() }, boxStateTimers: [], awakeToday: { day: today, ms: 2 * 60 * MINUTE } });
  const capped: string[] = [];
  for (let i = 0; i < 51; i++) {
    const { runnerId } = await s.start(`C${i}`);
    asleepPastHours(`C${i}`);
    capped.push(runnerId);
  }
  const { runnerId: eligible } = await s.start('E1');
  Object.assign(s.rowOf('E1'), { boxState: { kind: 'asleep', since: Date.now() }, boxStateTimers: [] });
  await setLimits(s, { maxBoxes: 1 });
  s.skip();
  // The helper's own box is creating: no room. Each asks to wake.
  for (const r of capped) await call(s.ctx, boxes.wakeFor, { runnerId: r });
  await call(s.ctx, boxes.wakeFor, { runnerId: eligible });
  assert.equal(s.stateOf('E1'), 'asleep');
  // Room again: the eligible one wakes.
  await call(s.ctx, boxes.report, { threadId: THREAD, event: { type: 'FAILED', error: 'x' } });
  await call(s.ctx, boxes.wakeWaiting, { serviceId: s.serviceId });
  assert.equal(s.stateOf('E1'), 'waking');
  assert.ok(capped.every((_, i) => s.stateOf(`C${i}`) === 'asleep'));
});

// ------------------------------------------------------------ Codex's fourth round (18 Nov 2026)
// A box is only given up when the provider says it's gone (or has lost its disk).

// A sleeping box (paused, 2 GB) with its key, and a message for it.
async function pausedWithMessage(s: Awaited<ReturnType<typeof setup>>) {
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.sleepWith('T2', got.boxKey);
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  return { runnerId, m, got };
}

// 1. A resume that failed for a while gave the kept box up.
test("a resume that fails for a while keeps the box and tries again; it's replaced only once the provider says it's gone", async () => {
  const s = await setup();
  const { runnerId, m } = await pausedWithMessage(s);
  s.fly.failNext('POST', '/start', 503, 3);
  await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  await call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  assert.equal(s.stateOf('T2'), 'waking');
  assert.equal(s.rowOf('T2').boxAttempt, 1, 'no new box');
  assert.ok(s.rowOf('T2').boxKeyHash, 'its key kept');
  // The retry the wake scheduled: the provider's back, and it resumes.
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  assert.equal(s.fly.live().length, 1);
});

test("a kept box's wake keeps trying past its boot timer, and the reaper leaves the box alone", async () => {
  const s = await setup();
  const { runnerId, m } = await unsavedPaused(s);
  s.fly.failNext('POST', '/start', 503, 30);
  await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  await call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  await s.fireTimers(Date.now() + 11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'waking', 'still trying the kept box');
  assert.ok(s.rowOf('T2').boxKeyHash);
  s.skip();
  await s.reap();
  assert.equal(s.fly.byId(m.id)!.state, 'suspended', 'not reaped');
  // Past its grace (fifteen minutes) the wake stops: asleep as it was, its box and key kept.
  await s.fireTimers(Date.now() + 22 * MINUTE);
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.ok(s.rowOf('T2').boxKeyHash);
  assert.notEqual(s.fly.byId(m.id)!.state, 'destroyed');
});

// A box that slept at its day's hours with no save: paused, holding work newer than any save.
// `paused`: whether its pause is expected to have worked.
async function unsavedPaused(s: Awaited<ReturnType<typeof setup>>, paused = true) {
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'IDLE', attempt: 1, capped: true } });
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'asleep');
  await s.run();
  if (paused) assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  assert.deepEqual(s.rowOf('T2').workAttempts, [1]);
  return { runnerId, m, got };
}

test("a box that may hold work newer than its save isn't superseded, by the Mac's own boot token or the reaper", async () => {
  const s = await setup();
  const { m } = await unsavedPaused(s);
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'WAKE' } });
  s.skip();
  // Invariant W(c): no newer attempt while attempt 1 may hold that work.
  assert.equal(await outcome(call(s.a, boxes.mintBootToken, { key: OWNER, threadId: 'T2' })), 'conflict');
  assert.equal(s.rowOf('T2').boxAttempt, 1);
  await s.reap();
  assert.notEqual(s.fly.byId(m.id)!.state, 'destroyed', 'kept: it may hold work newer than the save');
});

// 2. Missed heartbeats alone gave a live box up.
test("a box that stops heartbeating but is still running is kept, marked unreachable, its key working", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  await s.fireTimers(Date.now() + 6 * MINUTE);
  assert.equal(s.stateOf('T2'), 'awake');
  assert.ok(s.rowOf('T2').unreachableSince);
  assert.deepEqual(await s.run(), ['checkBox']);
  assert.equal(s.stateOf('T2'), 'awake', 'the provider has it running: kept');
  assert.equal(s.rowOf('T2').boxAttempt, 1);
  const listed = (await call(s.ctx, sync.otherRunnersList, { key: OWNER, runnerId: 'main-mac' })).find((r: { runnerId: string }) => r.runnerId === runnerId);
  assert.deepEqual(listed.box, { state: 'awake', unreachable: true });
  // It's back: heartbeating clears it.
  assert.equal(await outcome(s.beat(got.boxKey, runnerId)), 'ok');
  assert.equal(s.rowOf('T2').unreachableSince, undefined);
  // A suspended one is resumed.
  s.fly.byId(m.id)!.state = 'suspended';
  await s.fireTimers(Date.now() + 20 * MINUTE);
  await s.run();
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  assert.equal(s.stateOf('T2'), 'awake');
});

// 3. Kept-running boxes didn't count toward maxBoxes.
test('a box kept running counts toward maxBoxes', async () => {
  const s = await setup(4096);
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  await s.run();
  assert.ok(s.rowOf('T2').keptRunningSince);
  // The helper's own box failed its boot timer meanwhile; T2's kept one is one of one.
  assert.equal(s.stateOf(THREAD), 'failed');
  await setLimits(s, { maxBoxes: 1 }, 4096);
  assert.equal(await outcome(s.start('T3')), 'limit');
});

// 4. A stretch across midnight UTC was all charged to the new day.
test('awake time across midnight UTC counts only its part after midnight toward the new day', () => {
  const { awakeAdded } = load('boxMachine') as { awakeAdded: (row: unknown, since: number, now: number) => { awakeToday: { day: string; ms: number } } };
  const midnight = Date.parse('2026-11-19T00:00:00.000Z');
  const got = awakeAdded({ awakeToday: { day: '2026-11-18', ms: 5 * 60 * MINUTE } }, midnight - 30 * MINUTE, midnight + 30 * MINUTE);
  assert.deepEqual(got.awakeToday, { day: '2026-11-19', ms: 30 * MINUTE });
});

// ------------------------------------------------------------ Codex's fifth round: invariants W and M (18 Nov 2026)

// 1. W(a)(b)(c): a newer attempt's save, loss or boot token dropped an older box's unsaved work.
test('W: a box holding work newer than its save is resumed, not replaced, and only its own save or loss lets it go', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  const got = await s.boot('T2', m.id);
  // Attempt 1 saves S1 and keeps working: that save doesn't cover it.
  await s.save(got.boxKey, 'S1');
  assert.deepEqual(s.rowOf('T2').workAttempts, [1]);
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'IDLE', attempt: 1, capped: true } });
  await later(9 * MINUTE, () => s.beat(got.boxKey, runnerId));
  await s.fireTimers(Date.now() + 11 * MINUTE);
  await s.run();
  assert.equal(s.stateOf('T2'), 'asleep');
  // A wake: the Mac can't mint attempt 2, and the service resumes attempt 1.
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'WAKE' } });
  assert.equal(await outcome(call(s.a, boxes.mintBootToken, { key: OWNER, threadId: 'T2' })), 'conflict');
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.rowOf('T2').boxAttempt, 1);
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  // A loss names only its own attempt (a row from before this, holding two).
  s.rowOf('T2').workAttempts = [1, 2];
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'LOST', attempt: 2 } });
  assert.deepEqual(s.rowOf('T2').workAttempts, [1]);
});

// 2. W(c)(d): with the provider not set up, an unarchive gave the kept box up.
test("W: with no provider set up, waking a kept box changes nothing and tries again, then resumes that box", async () => {
  const s = await setup();
  const { runnerId, m } = await unsavedPaused(s);
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  assert.equal(s.stateOf('T2'), 'shelved');
  await s.run();
  delete process.env.FLY_API_TOKEN;
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  s.skip();
  await call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  assert.equal(s.stateOf('T2'), 'waking');
  assert.equal(s.rowOf('T2').boxAttempt, 1, 'no new attempt');
  assert.ok(s.rowOf('T2').boxKeyHash, 'its key kept');
  process.env.FLY_API_TOKEN = 'fly-token';
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake');
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  assert.equal(s.rowOf('T2').boxAttempt, 1);
});

// 3. M: a suspend that failed for a hiccup was never tried again, and the box fell out of the counts.
test('M: the billing guard pauses a running box that should be asleep, every pass until it works, counting it meanwhile', async () => {
  const s = await setup();
  const failing = s.fly.failWhile((r) => r.path.endsWith('/suspend'), 503);
  const { m } = await unsavedPaused(s, false);
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.notEqual(s.fly.byId(m.id)!.state, 'suspended', 'its pause failed');
  await s.reap();
  assert.ok(s.rowOf('T2').seenRunningAt, 'seen running: counted');
  await setLimits(s, { maxBoxes: 1 });
  assert.equal(await outcome(s.start('T3')), 'limit');
  // Tried again each pass once its backoff is out; still failing, backing off further.
  await later(6 * MINUTE, () => s.reap());
  assert.equal(s.rowOf('T2').suspendFails.n, 2);
  failing.stop();
  await later(20 * MINUTE, () => s.reap());
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  await later(21 * MINUTE, () => s.reap());
  assert.equal(s.rowOf('T2').seenRunningAt, undefined);
  assert.equal(s.rowOf('T2').suspendFails, undefined);
});

// 4. M: a capped box kept running billed for ever.
test("M: a box kept running asleep is counted and charged, and is let go after its virtual runner's days", async () => {
  // Too big to pause (a virtual runner from before 2 GB was the most): its size says so.
  const s = await setup(4096);
  const refuse = s.fly.failWhile(() => false, 400);
  const { runnerId, m } = await unsavedPaused(s, false);
  assert.ok(s.rowOf('T2').keptRunningSince, 'kept running: it holds unsaved work and cannot pause');
  const before = s.rowOf('T2').awakeToday?.ms ?? 0;
  await later(5 * MINUTE, () => s.reap());
  assert.ok((s.rowOf('T2').awakeToday?.ms ?? 0) > before, 'its running time is charged');
  refuse.stop();
  // Its days are up (asleep, measured from when it slept): the box goes, and it comes back from its last save.
  await later(15 * 24 * 60 * MINUTE, () => call(s.ctx, service.pruneSaves, {}));
  await later(15 * 24 * 60 * MINUTE, () => s.run());
  assert.equal(s.fly.byId(m.id)!.state, 'destroyed');
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.equal(s.rowOf('T2').boxKeyHash, undefined);
  assert.deepEqual(s.rowOf('T2').workAttempts, []);
  assert.equal(s.rowOf('T2').keptRunningSince, undefined);
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
});

// 5. M: a resume that half worked ran for ever, uncounted.
test('M: a wake whose box runs but never comes up is charged, and paused once its grace is out', async () => {
  const s = await setup();
  const { runnerId, m, got } = await unsavedPaused(s);
  const stuck = s.fly.failWhile((r) => r.path.endsWith('/wait') && r.query.get('state') === 'started', 503);
  const cmd = await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  s.skip();
  await call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  assert.equal(s.fly.byId(m.id)!.state, 'started', 'it runs');
  // Its runner takes the message (nothing's left waiting to wake it again once it's paused).
  assert.equal(await call(s.ctx, sync.takeCommand, { key: got.boxKey, commandId: cmd }), true);
  assert.equal(s.stateOf('T2'), 'waking');
  s.skip();
  // Within its grace the guard leaves it running, and charges it.
  await later(5 * MINUTE, () => s.reap());
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  const charged = s.rowOf('T2').awakeToday?.ms ?? 0;
  await later(10 * MINUTE, () => s.reap());
  assert.ok((s.rowOf('T2').awakeToday?.ms ?? 0) > charged);
  // Out of its grace: paused, and the thread sleeps as it was, its key kept.
  await later(16 * MINUTE, () => s.reap());
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.ok(s.rowOf('T2').boxKeyHash);
  stuck.stop();
});

// ------------------------------------------------------------ Codex's sixth round (18 Nov 2026)

// 1. Framing A: a box whose resume half worked made work, unknown to the row, and lost it.
test('A: a key that takes a command joins the boxes that may hold work, so a half-resumed box is kept', async () => {
  const s = await setup();
  const { runnerId, m, got } = await pausedWithMessage(s);
  assert.deepEqual(s.rowOf('T2').workAttempts, [], 'saved as it slept');
  const stuck = s.fly.failWhile((r) => r.path.endsWith('/wait') && r.query.get('state') === 'started', 503);
  const cmd = await s.send(runnerId, 'T2');
  s.skip();
  await call(s.ctx, boxes.wakeFor, { runnerId });
  s.skip();
  await call(s.a, service.wakeBox, { boxId: boxIdOf(s, 'T2') });
  assert.equal(s.fly.byId(m.id)!.state, 'started');
  // Its runner is up after all, and takes the message: it may now hold work newer than the save.
  assert.equal(await call(s.ctx, sync.takeCommand, { key: got.boxKey, commandId: cmd }), true);
  assert.deepEqual(s.rowOf('T2').workAttempts, [1]);
  assert.equal(await outcome(call(s.a, boxes.mintBootToken, { key: OWNER, threadId: 'T2' })), 'conflict');
  // Its boot timer doesn't revoke a used key.
  await s.fireTimers(Date.now() + 11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'waking');
  assert.ok(s.rowOf('T2').boxKeyHash);
  await s.fireTimers(Date.now() + 22 * MINUTE);
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.ok(s.rowOf('T2').boxKeyHash);
  s.skip();
  await later(22 * MINUTE, () => s.reap());
  assert.notEqual(s.fly.byId(m.id)!.state, 'destroyed');
  stuck.stop();
});

// 2. A retirement planned on one sleep deleted the box of the next.
test("a retirement planned on one sleep does nothing once the thread has woken and slept again", async () => {
  const s = await setup();
  const { runnerId, m, got } = await pausedWithMessage(s);
  const DAYS = 15 * 24 * 60 * MINUTE;
  await later(DAYS, () => call(s.ctx, service.pruneSaves, { kind: 'asleep' }));
  const job = (s.scheduled as { fn: string; args: Record<string, unknown> }[]).filter((j) => j.fn.endsWith('retireBox')).at(-1)!;
  s.skip();
  // Woken and slept again, fresh.
  await later(DAYS, async () => {
    await s.send(runnerId, 'T2');
    await s.run();
    assert.equal(s.stateOf('T2'), 'awake');
    await s.takeAll(got.boxKey, runnerId);
  });
  await later(DAYS + 11 * MINUTE, async () => {
    await call(s.ctx, service.sleepIdleBoxes, {});
    await s.save(got.boxKey, 'fresh');
    await s.run();
  });
  assert.equal(s.stateOf('T2'), 'asleep');
  await later(DAYS + 12 * MINUTE, () => call(s.a, service.retireBox, job.args));
  assert.notEqual(s.fly.byId(m.id)!.state, 'destroyed');
  assert.ok(s.rowOf('T2').boxKeyHash);
});

// 3. A guard pause dropped the time the box had been up.
test('a box the guard pauses is charged the time it was up', () => atNoon(async () => {
  const s = await setup();
  await s.start('T2');
  await s.run();
  await s.boot('T2', s.fly.live()[0]!.id);
  // Silent twenty minutes (the provider still runs it): the guard pauses it.
  s.skip();
  await later(20 * MINUTE, () => s.reap());
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.ok(s.rowOf('T2').awakeToday.ms >= 19 * MINUTE, 'its twenty minutes up are counted');
}));

// 5. A loss mid-archive left its attempt blocking the thread's recovery.
test("a box lost mid-archive stops holding the thread's work, so unarchiving makes a new box", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.save(got.boxKey, 'S1');
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  assert.equal(s.stateOf('T2'), 'archiving');
  assert.equal(await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'LOST', attempt: 1 } }), true);
  assert.equal(s.stateOf('T2'), 'destroying');
  assert.deepEqual(s.rowOf('T2').workAttempts, []);
  await s.run();
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
});

// 6. Framing B: a box that traded its token before its create reported was never taken in.
test('B: the reaper takes in the current attempt’s machine though it already holds work', async () => {
  const s = await setup();
  await s.start('T2');
  s.skip();
  const { bootToken, attempt } = await call(s.a, boxes.mintBootToken, { key: OWNER, threadId: 'T2' });
  const boxId = boxIdOf(s, 'T2');
  s.fly.machines.push({ id: 'unreported', name: 'u', state: 'started', config: { guest: { memory_mb: 2048 }, env: { THREADBEAR_BOX_BOOT: bootToken }, metadata: { tb_box: boxId, tb_attempt: String(attempt), tb_service: s.serviceId } } });
  const got = await s.exchange(bootToken);
  await s.beat(got.boxKey, got.runnerId);
  assert.deepEqual(s.rowOf('T2').workAttempts, [1]);
  assert.equal(s.rowOf('T2').providerBoxId, undefined);
  await s.reap();
  assert.equal(s.rowOf('T2').providerBoxId, 'unreported');
  assert.equal(s.stateOf('T2'), 'awake');
});

// 7. Framing B: a machine gone from the provider kept its maxBoxes slot.
test('B: a machine gone from the provider is found by the reconciler, its slot freed', async () => {
  const s = await setup(4096);
  const { m } = await unsavedPaused(s, false);
  assert.ok(s.rowOf('T2').seenRunningAt, 'kept running, counted');
  s.fly.lose(m.id);
  await s.reap();
  assert.equal(s.rowOf('T2').seenRunningAt, undefined);
  assert.equal(s.rowOf('T2').providerBoxId, undefined);
  assert.deepEqual(s.rowOf('T2').workAttempts, [], 'gone, on the provider’s word');
  await setLimits(s, { maxBoxes: 1 }, 4096);
  assert.equal(await outcome(s.start('T3')), 'ok');
});

// ------------------------------------------------------------ Codex's seventh round (18 Nov 2026): the fence

// 1. A retirement deleted work its box made after the retirement's check.
test('the fence: a retirement revokes the box key as it decides, so no new work lands before the delete', async () => {
  const s = await setup();
  const { runnerId, m, got } = await pausedWithMessage(s);
  const DAYS = 15 * 24 * 60 * MINUTE;
  await later(DAYS, () => call(s.ctx, service.pruneSaves, { kind: 'asleep' }));
  const job = (s.scheduled as { fn: string; args: Record<string, unknown> }[]).filter((j) => j.fn.endsWith('retireBox')).at(-1)!;
  s.skip();
  const held = s.fly.hold((r) => r.query.get('metadata.tb_box') !== null);
  const retiring = later(DAYS, () => call(s.a, service.retireBox, job.args));
  await held.arrived;
  // Between its decision and the delete, the box can write nothing.
  assert.equal(await outcome(s.beat(got.boxKey, runnerId)), 'auth');
  held.release();
  await retiring;
  assert.equal(s.fly.byId(m.id)!.state, 'destroyed');
});

// 2. A write after the save, then an archive: the attempt was kept but its key revoked and its machine forgotten.
test("work written after the last save makes an archive keep the box, and a repeated save doesn't count as work", async () => {
  const s = await setup();
  const { runnerId, m, got } = await pausedWithMessage(s);
  assert.deepEqual(s.rowOf('T2').workAttempts, []);
  // The same save sent again isn't work.
  await call(s.ctx, boxes.boxSaved, { key: got.boxKey, storageId: s.rowOf('T2').save.storageId, bytes: 5000 });
  assert.deepEqual(s.rowOf('T2').workAttempts, []);
  // A late heartbeat after the save is: its box may hold work newer than the save.
  await s.beat(got.boxKey, runnerId);
  assert.deepEqual(s.rowOf('T2').workAttempts, [1]);
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
  assert.equal(s.stateOf('T2'), 'shelved', 'kept, not deleted');
  assert.ok(s.rowOf('T2').boxKeyHash);
  assert.equal(s.rowOf('T2').providerBoxId, m.id);
  await s.run();
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { unarchive: true } });
  await s.run();
  assert.equal(s.stateOf('T2'), 'awake', 'the same box resumed');
  assert.equal(s.rowOf('T2').boxAttempt, 1);
});

// 3. A newer attempt left the older key able to work.
test('the fence: minting a newer attempt revokes the older key in the same step', async () => {
  const s = await setup();
  const { runnerId, got } = await pausedWithMessage(s);
  await call(s.ctx, boxes.report, { threadId: 'T2', event: { type: 'WAKE' } });
  s.skip();
  const newer = await call(s.a, boxes.mintBootToken, { key: OWNER, threadId: 'T2' });
  assert.equal(newer.attempt, 2);
  assert.equal(await outcome(s.beat(got.boxKey, runnerId)), 'auth');
});

// 4. A message waiting when the guard paused the box stayed pending.
test('a message waiting when the guard pauses a box wakes it again', async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  await s.boot('T2', s.fly.live()[0]!.id);
  await s.send(runnerId, 'T2');
  s.skip();
  await later(20 * MINUTE, () => s.reap());
  assert.equal(s.stateOf('T2'), 'awake', 'paused for its silence, then woken for the message');
});

// 5. A pause whose wait failed was undone by the lease checker.
test("the lease checker doesn't resume a box the guard paused if it may not run", async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  const m = s.fly.live()[0]!;
  await s.boot('T2', m.id);
  const lostWait = s.fly.failWhile((r) => r.path.endsWith('/wait') && r.query.get('state') === 'suspended', 503);
  s.skip();
  await later(20 * MINUTE, () => s.reap());
  assert.equal(s.fly.byId(m.id)!.state, 'suspended');
  assert.equal(s.stateOf('T2'), 'awake', 'the wait failed, so nothing reported');
  lostWait.stop();
  await s.fireTimers(Date.now() + 21 * MINUTE);
  await later(21 * MINUTE, () => s.run());
  assert.equal(s.fly.calls('POST', '/start'), 0, 'not resumed');
  assert.equal(s.stateOf('T2'), 'asleep');
  assert.ok(runnerId);
});

// 6. A retirement that waited for the lease lost the sleep it was for.
test('an action that waits for the lease runs again with all of its arguments', async () => {
  const s = await setup();
  await pausedWithMessage(s);
  const boxId = boxIdOf(s, 'T2');
  s.rowOf('T2').op = { id: 'another-run', name: 'wakeBox', until: Date.now() + 60 * MINUTE };
  s.skip();
  await call(s.a, service.retireBox, { boxId, asleepSince: 12345 });
  const again = (s.scheduled as { fn: string; args: Record<string, unknown> }[]).at(-1)!;
  assert.ok(again.fn.endsWith('retireBox'));
  assert.deepEqual(again.args, { boxId, asleepSince: 12345 });
});
