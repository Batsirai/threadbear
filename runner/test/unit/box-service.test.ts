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

const ACTIONS = new Set(['createBox', 'wakeBox', 'sleepBox', 'destroyBox', 'reapBoxes', 'reapService']);
// What run() runs of what's scheduled: the service's steps, and a move's rehoming.
const RUNS = new Set(['boxes.wakeFor', 'boxes.archiveIfStill', 'boxes.wakeWaiting', 'moves.rehomeRows']);
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
  await call(s.ctx, boxes.setRunnerService, { key: OWNER, serviceId: s.serviceId, name: 'Cloud (Fly)', provider: 'fly', image: 'registry.fly.io/threadbear-box:1', box: { cpus: 2, memoryMb } });
  // Runs the service's scheduled steps as Convex's scheduler would, in order (delays aside), until none are left. Returns their names.
  const run = async (): Promise<string[]> => {
    const ran: string[] = [];
    let steps = 0;
    while (cursor < s.scheduled.length) {
      const job = s.scheduled[cursor++] as { fn: string; args: Record<string, unknown> };
      const [, mod, name] = job.fn.split('.') as [string, string, string];
      if (mod !== 'boxService' && !RUNS.has(`${mod}.${name}`)) continue;
      // wakeWaiting runs from the idle cron every time: not listed, to keep the lists to the point.
      if (name !== 'wakeWaiting') ran.push(name);
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
  return { ...s, fly, run, skip, start, rowOf, stateOf, bootOf, boot, beat, takeAll, save, send, sleepIdle, reap, sleepWith };
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
  // Archived (its runner moves it to the den): after the grace, its box goes.
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  assert.deepEqual(await s.run(), ['archiveIfStill', 'destroyBox']);
  assert.equal(s.stateOf('T2'), 'gone');
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

test("a message while it's saving keeps it up, and a lost box's lease wakes a new one by itself", async () => {
  const s = await setup(2048);
  const { runnerId } = await s.start('T2');
  await s.run();
  await s.boot('T2', s.fly.live()[0]!.id);
  await s.sleepIdle(11 * MINUTE);
  assert.equal(s.stateOf('T2'), 'saving');
  await s.send(runnerId, 'T2');
  assert.deepEqual(await s.run(), ['wakeFor']);
  assert.equal(s.stateOf('T2'), 'awake');
  // No heartbeat for the lease: lost, and the machine schedules a new box.
  await s.fireTimers(Date.now() + 30 * MINUTE);
  assert.equal(s.stateOf('T2'), 'waking');
  assert.deepEqual(await s.run(), ['wakeBox']);
  assert.equal(s.stateOf('T2'), 'starting');
  assert.equal(s.fly.live().length, 2, 'the old one is the reaper\'s');
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
  // No provider set up: it fails saying so, rather than waiting ten minutes.
  delete process.env.FLY_API_TOKEN;
  await s.start('T3');
  await s.run();
  assert.equal(s.stateOf('T3'), 'failed');
  assert.match(s.rowOf('T3').boxState.error, /provider isn't set up/);
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

test("the reaper sleeps an asleep box that's still running, and loses one that stopped", async () => {
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
  assert.ok((await s.reap()).includes('sleepBox'));
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

test("a box past its day's hours is asked to save even with a dev server running, but not while a message waits", () => atNoon(async () => {
  const s = await setup();
  const { runnerId } = await s.start('T2');
  await s.run();
  await s.boot('T2', s.fly.live()[0]!.id);
  await call(s.ctx, boxes.setRunnerService, { key: OWNER, serviceId: s.serviceId, name: 'Cloud (Fly)', provider: 'fly', image: 'registry.fly.io/threadbear-box:1', box: { cpus: 2, memoryMb: 2048 }, limits: { maxAwakeHoursPerDay: 1, idleSleepMinutes: 600 } });
  // Busy (a turn running) and a message waiting: not now.
  const t = s.rows('threads').find((r) => r.threadId === 'T2')!;
  t.status = 'running';
  await s.send(runnerId, 'T2');
  assert.equal(await s.sleepIdle(61 * MINUTE), 0);
  for (const c of s.rows('commands').filter((c) => c.kind === 'send')) Object.assign(c, { state: 'done', commandState: { kind: 'done', at: Date.now() } });
  assert.equal(await s.sleepIdle(61 * MINUTE), 1);
  assert.equal(s.stateOf('T2'), 'saving');
}));

test("archived threads' saves go after the virtual runner's days, and the thread then can't come back", async () => {
  const s = await setup();
  await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await s.save(got.boxKey, 'save1');
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: 'T2' });
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
  assert.deepEqual(await s.run(), ['archiveIfStill', 'destroyBox']);
  // Never saved: it can't come back.
  assert.equal(s.stateOf('T2'), 'expired');
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
  const made = await call(s.ctx, boxes.setRunnerService, { key: OWNER, name: 'Big', provider: 'fly', image: 'img:1', box: { cpus: 4, memoryMb: 8192 }, region: 'syd', limits: { maxBoxes: 3 } });
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
const setLimits = (s: Awaited<ReturnType<typeof setup>>, limits: Record<string, number>, memoryMb = 2048) =>
  call(s.ctx, boxes.setRunnerService, { key: OWNER, serviceId: s.serviceId, name: 'Cloud (Fly)', provider: 'fly', image: 'registry.fly.io/threadbear-box:1', box: { cpus: 2, memoryMb }, limits });

// 1. The day's cap didn't depend on the box: one that never saved stayed up for ever.
for (const memoryMb of [2048, 4096]) {
  test(`past its day's hours, a ${memoryMb} MB box whose save never comes sleeps anyway (${memoryMb > 2048 ? 'deleted' : 'paused'})`, () => atNoon(async () => {
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
      assert.equal(s.fly.live().length, 0, "deleted, as it can't pause");
      assert.equal(s.rowOf('T2').boxKeyHash, undefined);
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
test('a box made at 4096 MB is deleted on sleep after its virtual runner is made 2 GB, and a refused pause deletes it too', async () => {
  const s = await setup(4096);
  await s.start('T2');
  await s.run();
  const got = await s.boot('T2', s.fly.live()[0]!.id);
  await setLimits(s, {}, 2048);
  await s.sleepWith('T2', got.boxKey);
  assert.equal(s.fly.calls('POST', '/suspend'), 0, 'not tried');
  assert.equal(s.fly.live().length, 0);
  assert.equal(s.rowOf('T2').boxKeyHash, undefined);
  // A 2 GB box whose suspend Fly refuses outright.
  const { runnerId } = await s.start('T3');
  await s.run();
  const m3 = s.fly.live()[0]!;
  const got3 = await s.boot('T3', m3.id);
  s.fly.failNext('POST', '/suspend', 400);
  await s.sleepWith('T3', got3.boxKey);
  assert.equal(s.fly.byId(m3.id)!.state, 'destroyed');
  assert.equal(s.rowOf('T3').boxKeyHash, undefined, 'lost: the next wake makes a new box from the save');
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
  await s.save(got.boxKey, 'save1');
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  assert.equal(s.stateOf('T2'), 'gone');
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
  await s.save(got.boxKey, 'save1');
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
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
  await s.save(got.boxKey, 'save1');
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: 'T2', runnerId, title: 't', view: 'den', needsYou: false }] });
  await s.run();
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId, threadId: 'T2', kind: 'update', args: { markSeen: true } });
  assert.deepEqual(await s.run(), []);
  assert.equal(s.stateOf('T2'), 'gone');
  await s.send(runnerId, 'T2');
  await s.run();
  assert.equal(s.stateOf('T2'), 'starting');
});
