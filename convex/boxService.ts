// The virtual runners' service (docs/virtual-runners.md, decisions 2, 7, 8,
// 9 and 12): the actions that call a box's provider, and the crons that
// sleep idle boxes, reap ones nobody wants and delete old saves.
//
// Each action is told only a box row's id. It reads the row again, acts on
// the row's newest attempt at a box only, and reports what the provider
// did through the box's machine (boxes.ts report), naming that attempt, so
// one run twice or late changes nothing of a newer box (boxMachine.ts
// newestAttempt, stale). The machine schedules them (boxMachine.ts
// provide): wakeBox when a box is wanted back, sleepBox once it has slept,
// destroyBox when its thread is archived, createBox for a box lost while
// it was made; and boxes.ts addBox the first box's createBox.
//
// One action at a time calls the provider for a box: each holds the row's
// `op` lease while it does (claimOp), and one that finds it held runs again
// OP_RETRY_MS later. So a sleep's suspend and a wake's start never overlap,
// and after its calls each reads the row again and puts the machine right
// if the row moved on meanwhile (a box woken while it paused is resumed).
//
// A provider's error is tried again twice in the action, after RETRY_MS,
// when it's worth it (unreachable, rate limited, a 5xx). Then: a box that
// couldn't be made or brought back reports FAILED, which keeps the thread
// and its save, and the next message tries again; a sleep or delete that
// didn't happen is left for the reaper, which finds the box still running.
import { v, type Infer } from 'convex/values';
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { box as boxMachine, machines, queued } from './machines';
import { newestAttempt } from './boxMachine';
import { BOOT_PREFIX, BOX_LIMITS, newAttempt, randomHex } from './boxes';
import { sha256 } from './lib';
import { deleteIfUnused } from './sync';
import { flyFromEnv } from './boxProviders/fly';
import { notFound, ProviderError, transient } from './boxProviders/types';
import type { BoxProvider } from './boxProviders/types';

export const RETRY_MS = [300, 1500];
// How long an action may hold a box's op lease (a Fly wait is 60 s at most,
// tried three times), and how soon one that found it held tries again.
export const OP_LEASE_MS = 4 * 60_000;
export const OP_RETRY_MS = 5_000;
// A box being deleted this long is deleted again by the reaper.
export const DESTROY_AGAIN_MS = 10 * 60_000;
// Each cron's work per run, so none outgrows a function's limits; what's
// left goes on in a run of its own from where this one stopped.
export const IDLE_BATCH = 200;
export const REAP_CHUNK = 100;
export const PRUNE_BATCH = 100;
const DAY_MS = 24 * 60 * 60_000;
// A thread working, or waiting on Mike's answer to an approval, isn't idle.
const BUSY: readonly string[] = ['starting', 'running', 'waiting'];
// A size we don't know (a box made before sizes were kept, or one the
// reaper took in): treated as too big to pause.
const UNKNOWN_MB = Number.MAX_SAFE_INTEGER;

/** The provider for a virtual runner's box of `memoryMb` (its pause support), from this deployment's environment (docs/forking.md lists them). */
export function providerFor(provider: string, memoryMb: number): BoxProvider {
  switch (provider) {
    case 'fly':
      return flyFromEnv(process.env, memoryMb);
  }
  throw new Error(`There's no provider called ${provider}.`);
}

async function retrying<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= RETRY_MS.length || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_MS[i]));
    }
  }
}

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 400);

type Event =
  | { type: 'CREATED'; providerBoxId: string; attempt: number }
  | { type: 'RESUMED'; attempt: number }
  | { type: 'LOST'; attempt?: number }
  | { type: 'DESTROYED' }
  | { type: 'FAILED'; error: string; attempt: number };
const report = (ctx: ActionCtx, threadId: string, event: Event): Promise<boolean> => ctx.runMutation(internal.boxes.report, { threadId, event });

// ------------------------------------------------------------ reading a box

const seenV = v.object({
  threadId: v.string(),
  runnerId: v.string(),
  serviceId: v.id('runnerServices'),
  kind: v.string(),
  newest: v.number(),
  hasKey: v.boolean(),
  keyAttempt: v.optional(v.number()),
  providerBoxId: v.optional(v.string()),
  providerAttempt: v.optional(v.number()),
  // The provider box's memory, as made (boxes.size), if it's that attempt's.
  memoryMb: v.number(),
  provider: v.union(v.null(), v.string()),
});
type Seen = Infer<typeof seenV>;

/** What an action needs of a box row, read now. Never its hashes or sealed values. */
export const boxFor = internalQuery({
  args: { boxId: v.id('boxes') },
  returns: v.union(v.null(), seenV),
  handler: async (ctx, { boxId }) => {
    const row = await ctx.db.get(boxId);
    if (!row) return null;
    const s = await ctx.db.get(row.serviceId);
    return {
      threadId: row.threadId,
      runnerId: row.runnerId,
      serviceId: row.serviceId,
      kind: row.boxState.kind,
      newest: newestAttempt(row),
      hasKey: row.boxKeyHash !== undefined,
      ...(row.keyAttempt !== undefined ? { keyAttempt: row.keyAttempt } : {}),
      ...(row.providerBoxId !== undefined ? { providerBoxId: row.providerBoxId } : {}),
      ...(row.providerAttempt !== undefined ? { providerAttempt: row.providerAttempt } : {}),
      memoryMb: row.size && row.size.attempt === row.providerAttempt ? row.size.memoryMb : UNKNOWN_MB,
      provider: s ? s.provider : null,
    };
  },
});

function provider(name: string | null, memoryMb: number): BoxProvider | null {
  if (!name) return null;
  try {
    return providerFor(name, memoryMb);
  } catch (e) {
    console.warn('box provider not set up', message(e));
    return null;
  }
}

// ------------------------------------------------------------ one provider call at a time per box

type OpName = 'createBox' | 'wakeBox' | 'sleepBox' | 'destroyBox';

/** The box's op lease for this action run, unless another run holds it. */
export const claimOp = internalMutation({
  args: { boxId: v.id('boxes'), id: v.string(), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, id, name }) => {
    const row = await ctx.db.get(boxId);
    if (!row) return true;
    if (row.op && row.op.id !== id && row.op.until > Date.now()) return false;
    await ctx.db.patch(boxId, { op: { id, name, until: Date.now() + OP_LEASE_MS } });
    return true;
  },
});

export const releaseOp = internalMutation({
  args: { boxId: v.id('boxes'), id: v.string() },
  returns: v.null(),
  handler: async (ctx, { boxId, id }) => {
    const row = await ctx.db.get(boxId);
    if (row?.op?.id === id) await ctx.db.patch(boxId, { op: undefined });
    return null;
  },
});

// Runs `f` holding the box's op lease, or runs this action again shortly if another holds it.
async function withOp(ctx: ActionCtx, boxId: Id<'boxes'>, name: OpName, f: () => Promise<void>): Promise<void> {
  const id = randomHex(8);
  if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId, id, name }))) {
    await ctx.scheduler.runAfter(OP_RETRY_MS, internal.boxService[name], { boxId });
    return;
  }
  try {
    await f();
  } finally {
    await ctx.runMutation(internal.boxService.releaseOp, { boxId, id });
  }
}

// ------------------------------------------------------------ making and waking a box

/**
 * A new attempt at a box, if the row still wants one (creating or waking)
 * and none is on its way: an attempt whose boot token is still live is,
 * so of two runs at once only the first makes a box. A run that dies after
 * this leaves its token to lapse, and the box machine's boot timer then
 * fails the box; the next message tries again. The size it's made at is
 * kept for the attempt (boxes.size), as the virtual runner's may change.
 */
export const claimAttempt = internalMutation({
  args: { boxId: v.id('boxes'), bootHash: v.string() },
  returns: v.union(v.null(), v.object({ attempt: v.number(), image: v.string(), cpus: v.number(), memoryMb: v.number(), region: v.optional(v.string()) })),
  handler: async (ctx, { boxId, bootHash }) => {
    const row = await ctx.db.get(boxId);
    if (!row || (row.boxState.kind !== 'creating' && row.boxState.kind !== 'waking')) return null;
    if (row.bootTokenHash && row.bootAttempt === newestAttempt(row) && (row.bootExpiresAt ?? 0) > Date.now()) return null;
    const service = await ctx.db.get(row.serviceId);
    if (!service) return null;
    const { attempt } = await newAttempt(ctx, row, bootHash);
    await ctx.db.patch(boxId, { size: { attempt, cpus: service.box.cpus, memoryMb: service.box.memoryMb } });
    return { attempt, image: service.image, cpus: service.box.cpus, memoryMb: service.box.memoryMb, ...(service.region !== undefined ? { region: service.region } : {}) };
  },
});

/** The thread's first box (boxes.ts addBox), or another for one lost while it was made. */
export const createBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'createBox', () => bringBack(ctx, boxId));
    return null;
  },
});

/**
 * The thread wants its box back (a message, or its box lost): its paused
 * box resumed, if it can pause and holds the thread's key with no newer
 * attempt asked for; otherwise a new attempt's box, which restores the
 * last save through its exchange.
 */
export const wakeBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'wakeBox', () => bringBack(ctx, boxId));
    return null;
  },
});

async function bringBack(ctx: ActionCtx, boxId: Id<'boxes'>): Promise<void> {
  let seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
  if (!seen || (seen.kind !== 'creating' && seen.kind !== 'waking')) return;
  // The box that slept, still holding the thread's key: resume it.
  const keyHolder = seen.hasKey && seen.keyAttempt !== undefined && seen.keyAttempt === seen.newest && seen.providerAttempt === seen.keyAttempt;
  const paused = provider(seen.provider, seen.memoryMb);
  if (seen.kind === 'waking' && keyHolder && seen.providerBoxId && paused?.caps.pause && paused.resume) {
    const attempt = seen.keyAttempt!;
    const id = seen.providerBoxId;
    let taken = false;
    try {
      await retrying(() => paused.resume!(id));
      taken = await report(ctx, seen.threadId, { type: 'RESUMED', attempt });
    } catch (e) {
      // Gone, or it won't come back: its key goes, and a new box restores the save.
      console.warn('a paused box did not resume', message(e));
      await report(ctx, seen.threadId, { type: 'LOST', attempt });
    }
    if (taken) return;
    // Not resumed (it was lost, or its key went meanwhile): if the thread
    // still wants a box, it gets a new one, here and now.
    seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'waking') return;
  }
  const site = process.env.CONVEX_CLOUD_URL;
  const bootToken = BOOT_PREFIX + randomHex(32);
  const claim = await ctx.runMutation(internal.boxService.claimAttempt, { boxId, bootHash: await sha256(bootToken) });
  if (!claim) return;
  const { attempt } = claim;
  const p = provider(seen.provider, claim.memoryMb);
  if (!p) {
    await report(ctx, seen.threadId, { type: 'FAILED', error: `The ${seen.provider ?? 'box'} provider isn't set up on this deployment (docs/forking.md, Virtual runners).`, attempt });
    return;
  }
  if (!site) {
    await report(ctx, seen.threadId, { type: 'FAILED', error: "CONVEX_CLOUD_URL isn't set, so a box can't be told where to sync.", attempt });
    return;
  }
  let providerBoxId: string;
  try {
    ({ providerBoxId } = await retrying(() =>
      p.create({
        image: claim.image,
        cpus: claim.cpus,
        memoryMb: claim.memoryMb,
        ...(claim.region ? { region: claim.region } : {}),
        // Nothing reusable (decision 5): the boot token works once, for BOOT_MS.
        env: { THREADBEAR_SYNC_URL: site, THREADBEAR_BOX_BOOT: bootToken },
        name: `tb-${boxId}-${attempt}`,
        tags: { tb_box: boxId, tb_attempt: String(attempt), tb_service: seen!.serviceId },
        // One box per attempt, however often this is tried.
        idempotencyKey: `${boxId}-${attempt}`,
      }),
    ));
  } catch (e) {
    await report(ctx, seen.threadId, { type: 'FAILED', error: `${p.name}: ${message(e)}`, attempt });
    return;
  }
  // Not taken: the thread was archived meanwhile, or a newer attempt has
  // its box. This one isn't wanted.
  if (!(await report(ctx, seen.threadId, { type: 'CREATED', providerBoxId, attempt }))) await p.destroy(providerBoxId).catch((e) => console.warn('an unwanted box was not deleted; the reaper will', message(e)));
}

// ------------------------------------------------------------ sleeping and deleting

/**
 * The thread is asleep (boxMachine.ts sleep, sleepUnsaved): pause its box
 * if that box can pause (by the size it was made at) and holds the key,
 * else delete it and report it LOST, so the next wake makes a new box from
 * the save. A box the provider no longer has is LOST too, and one whose
 * pause is refused is deleted instead. If the thread was woken while it
 * paused, the box is resumed again before the lease goes.
 */
export const sleepBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'sleepBox', async () => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || seen.kind !== 'asleep' || !seen.providerBoxId) return;
      const p = provider(seen.provider, seen.memoryMb);
      if (!p) return;
      const id = seen.providerBoxId;
      const lost = { type: 'LOST' as const, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) };
      // Only the box that saved, holding the key, is paused; any other is no use asleep.
      if (p.caps.pause && p.pause && p.resume && seen.hasKey && seen.keyAttempt === seen.providerAttempt) {
        try {
          await retrying(() => p.pause!(id));
        } catch (e) {
          if (notFound(e)) await report(ctx, seen.threadId, lost);
          // Refused (not a hiccup): it can't pause, so it's deleted, as a box that can't is.
          else if (e instanceof ProviderError && !transient(e)) await deleteAsleep(ctx, p, seen, id);
          else console.warn('a box did not pause; the reaper will try again', message(e));
          return;
        }
        // Woken while it paused: it's wanted after all.
        const now = await ctx.runQuery(internal.boxService.boxFor, { boxId });
        if (now && ['waking', 'awake', 'saving'].includes(now.kind) && now.providerBoxId === id) await retrying(() => p.resume!(id)).catch((e) => console.warn('a box woken while it paused did not resume', message(e)));
        return;
      }
      await deleteAsleep(ctx, p, seen, id);
    });
    return null;
  },
});

async function deleteAsleep(ctx: ActionCtx, p: BoxProvider, seen: Seen, id: string): Promise<void> {
  try {
    await retrying(() => p.destroy(id));
  } catch (e) {
    console.warn('a sleeping box was not deleted; the reaper will try again', message(e));
    return;
  }
  await report(ctx, seen.threadId, { type: 'LOST', ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) });
}

/**
 * The thread is archived (boxMachine.ts archive): every box the provider
 * has for it is deleted, older attempts' too, then DESTROYED. One that
 * fails stays `destroying`, and the reaper runs this again.
 */
export const destroyBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'destroyBox', async () => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || seen.kind !== 'destroying') return;
      const p = provider(seen.provider, seen.memoryMb);
      if (!p) return;
      try {
        const ids = new Set(seen.providerBoxId ? [seen.providerBoxId] : []);
        for (const b of await retrying(() => p.list({ tb_box: boxId }))) ids.add(b.providerBoxId);
        for (const id of ids) await retrying(() => p.destroy(id));
      } catch (e) {
        console.warn('a box was not deleted; the reaper will try again', message(e));
        return;
      }
      await report(ctx, seen.threadId, { type: 'DESTROYED' });
    });
    return null;
  },
});

// ------------------------------------------------------------ the crons

/**
 * Sleeps awake boxes (decisions 7 and 12): one whose thread has been idle
 * the virtual runner's idleSleepMinutes, or that has been up its
 * maxAwakeHoursPerDay today, is sent IDLE (`capped` for the second) and a
 * `save` command; the box saves and says so (boxes.ts boxSaved), and
 * sleepBox pauses or deletes it. A capped one that never saves sleeps all
 * the same (boxMachine.ts sleepUnsaved). Not while a command waits for it,
 * so a message that woke it past its hours still gets taken. A page of
 * `numItems` a run, the rest in a run of its own from `cursor`; the first
 * page also wakes any box waiting for room (boxes.ts wakeWaiting).
 */
export const sleepIdleBoxes = machines.internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  returns: v.number(),
  handler: async (machineCtx, { cursor, numItems }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    const batch = numItems ?? IDLE_BATCH;
    const services = new Map<string, Doc<'runnerServices'> | null>();
    let asked = 0;
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'awake')).paginate({ numItems: batch, cursor: cursor ?? null });
    for (const row of page.page) {
      if (row.boxState.kind !== 'awake') continue;
      if (!services.has(row.serviceId)) services.set(row.serviceId, await ctx.db.get(row.serviceId));
      const limits = services.get(row.serviceId)?.limits ?? BOX_LIMITS;
      if (await waitingFor(ctx, row.runnerId)) continue;
      const thread = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', row.threadId)).unique();
      const last = Math.max(row.boxState.since, thread?.lastActivityMs ?? 0);
      const idle = !(thread && BUSY.includes(thread.status)) && now - last >= limits.idleSleepMinutes * 60_000;
      const overHours = awakeTodayMs(row, row.boxState.since, now) >= limits.maxAwakeHoursPerDay * 60 * 60_000;
      if (!idle && !overHours) continue;
      const r = await boxMachine.send(machineCtx, row._id, { type: 'IDLE', ...(row.keyAttempt !== undefined ? { attempt: row.keyAttempt } : {}), ...(overHours ? { capped: true } : {}) });
      if (r.status !== 'done') continue;
      await askToSave(ctx, row);
      asked++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.sleepIdleBoxes, { cursor: page.continueCursor, numItems: batch });
    if (!cursor) for (const s of await ctx.db.query('runnerServices').take(100)) await ctx.scheduler.runAfter(0, internal.boxes.wakeWaiting, { serviceId: s._id });
    return asked;
  },
});

// A command waiting for, or being run by, the box's runner: a reason to stay up. Its own save isn't.
async function waitingFor(ctx: MutationCtx, runnerId: string): Promise<boolean> {
  for (const state of ['pending', 'taken'] as const) {
    for await (const c of ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', runnerId).eq('state', state))) if (c.kind !== 'save') return true;
  }
  return false;
}

// Today's (UTC) awake time: what it had before this stretch, and this stretch's part of today.
export function awakeTodayMs(row: Pick<Doc<'boxes'>, 'awakeToday'>, since: number, now = Date.now()): number {
  const day = new Date(now).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  return (row.awakeToday?.day === day ? row.awakeToday.ms : 0) + Math.max(0, now - Math.max(since, dayStart));
}

// The box's runner is asked to save its thread (decision 7): a `save`
// command for its thread, one at a time.
async function askToSave(ctx: MutationCtx, row: Doc<'boxes'>): Promise<void> {
  for await (const c of ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', row.runnerId).eq('state', 'pending'))) if (c.kind === 'save') return;
  await queued(ctx, { runnerId: row.runnerId, threadId: row.threadId, kind: 'save', args: {}, createdAt: Date.now() });
}

// ------------------------------------------------------------ the reaper

const listedV = v.object({ providerBoxId: v.string(), state: v.string(), boxId: v.string(), attempt: v.number() });
type Listed = Infer<typeof listedV>;
const doV = v.union(v.literal('destroy'), v.literal('adopt'), v.literal('lost'), v.literal('sleep'), v.literal('keep'));
type Do = Infer<typeof doV>;
// What a step's row was when it was planned: a step whose row has moved on since is dropped.
const snapV = v.union(v.null(), v.object({ kind: v.string(), newest: v.number(), providerBoxId: v.optional(v.string()), keyAttempt: v.optional(v.number()), since: v.optional(v.number()) }));
type Snap = Infer<typeof snapV>;

function snapOf(row: Doc<'boxes'> | null): Snap {
  if (!row) return null;
  const since = (row.boxState as { since?: number }).since;
  return { kind: row.boxState.kind, newest: newestAttempt(row), ...(row.providerBoxId !== undefined ? { providerBoxId: row.providerBoxId } : {}), ...(row.keyAttempt !== undefined ? { keyAttempt: row.keyAttempt } : {}), ...(since !== undefined ? { since } : {}) };
}
const sameSnap = (a: Snap, b: Snap) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the reaper does with a box the provider has (decision 12). Never the
 * current attempt's box while it's wanted:
 * - no row for it, another virtual runner's row, or an attempt other than
 *   the row's newest (an older one's, or not one at all): destroy;
 * - its row archived and gone or expired, or failed (no key works for it): destroy;
 * - its row being deleted: destroyBox's (one stuck is run again, stuckDestroying);
 * - asleep, but not the box holding the thread's key (that one's lost,
 *   and the next wake makes a new box): destroy;
 * - the current attempt's box the row doesn't know yet (its CREATED never
 *   came): adopt, reporting CREATED; a second box for the same attempt:
 *   destroy;
 * - the key holder's box stopped while awake, saving or asleep (crashed,
 *   or its snapshot gone): lost, which wakes a new box from the save;
 * - asleep but still running (its pause or delete didn't happen): sleep.
 */
function planFor(row: Doc<'boxes'> | null, serviceId: string, b: Listed): Do {
  if (!row || row.serviceId !== serviceId || !Number.isSafeInteger(b.attempt) || b.attempt < 1 || b.attempt !== newestAttempt(row)) return 'destroy';
  const kind = row.boxState.kind;
  if (kind === 'gone' || kind === 'expired' || kind === 'failed') return 'destroy';
  if (kind === 'destroying') return 'keep';
  if (kind === 'asleep' && row.keyAttempt !== b.attempt) return 'destroy';
  if (row.providerBoxId !== b.providerBoxId) return row.providerAttempt === b.attempt ? 'destroy' : 'adopt';
  if (b.state === 'stopped' && ['awake', 'saving', 'asleep'].includes(kind) && row.keyAttempt === b.attempt) return 'lost';
  if (kind === 'asleep' && b.state === 'running') return 'sleep';
  return 'keep';
}

async function rowOf(ctx: { db: MutationCtx['db'] }, boxId: string): Promise<Doc<'boxes'> | null> {
  const id = ctx.db.normalizeId('boxes', boxId);
  return id ? await ctx.db.get(id) : null;
}

/** The reaper's plan for a page of listed boxes, with each row as it is now. */
export const reapPlan = internalQuery({
  args: { serviceId: v.id('runnerServices'), boxes: v.array(listedV) },
  returns: v.array(v.object({ box: listedV, do: doV, seen: snapV, boxId: v.optional(v.id('boxes')) })),
  handler: async (ctx, { serviceId, boxes }) => {
    const out = [];
    for (const b of boxes) {
      const row = await rowOf(ctx as never, b.boxId);
      out.push({ box: b, do: planFor(row, serviceId, b), seen: snapOf(row), ...(row ? { boxId: row._id } : {}) });
    }
    return out;
  },
});

/**
 * One step of the reaper's plan, checked again first: only if its row is
 * as the plan saw it and the step is still what it would plan, in this
 * one step. So a stale plan (the box woken, resumed or replaced since) does
 * nothing. A loss is reported here; an adoption is reported (CREATED,
 * which the machine checks too); a sleep scheduled. Answers what the
 * action should do with the provider box: destroy it, or nothing.
 */
export const reapStep = machines.internalMutation({
  args: { serviceId: v.id('runnerServices'), box: listedV, do: doV, seen: snapV },
  returns: v.boolean(),
  handler: async (machineCtx, { serviceId, box: b, do: planned, seen }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await rowOf(ctx, b.boxId);
    if (!sameSnap(snapOf(row), seen) || planFor(row, serviceId, b) !== planned) return false;
    if (planned === 'destroy') return true;
    if (!row) return false;
    if (planned === 'lost') return (await boxMachine.send(machineCtx, row._id, { type: 'LOST', attempt: b.attempt })).status === 'done';
    if (planned === 'adopt') await boxMachine.send(machineCtx, row._id, { type: 'CREATED', providerBoxId: b.providerBoxId, attempt: b.attempt });
    if (planned === 'sleep') await ctx.scheduler.runAfter(0, internal.boxService.sleepBox, { boxId: row._id });
    return false;
  },
});

export const servicesToReap = internalQuery({
  args: {},
  returns: v.array(v.id('runnerServices')),
  handler: async (ctx) => (await ctx.db.query('runnerServices').take(100)).map((s) => s._id),
});

export const stuckDestroying = internalQuery({
  args: {},
  returns: v.array(v.id('boxes')),
  handler: async (ctx) => {
    const before = Date.now() - DESTROY_AGAIN_MS;
    const rows = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'destroying')).take(PRUNE_BATCH);
    return rows.filter((r) => r.boxState.kind === 'destroying' && r.boxState.since < before).map((r) => r._id);
  },
});

/** The reaper (planFor), a run per virtual runner, and boxes stuck being deleted. */
export const reapBoxes = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const serviceId of await ctx.runQuery(internal.boxService.servicesToReap, {})) await ctx.scheduler.runAfter(0, internal.boxService.reapService, { serviceId });
    for (const boxId of await ctx.runQuery(internal.boxService.stuckDestroying, {})) await ctx.scheduler.runAfter(0, internal.boxService.destroyBox, { boxId });
    return null;
  },
});

/**
 * One virtual runner's boxes, `chunk` of them by id after `after` (the last
 * id the run before got to: deleting boxes doesn't move the rest), then the
 * next chunk in a run of its own: every box is reached however many there are.
 * A loss is only reported under the box's op lease, after asking the
 * provider again, so it can't race a wake's resume.
 */
export const reapService = internalAction({
  args: { serviceId: v.id('runnerServices'), after: v.optional(v.string()), chunk: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { serviceId, after, chunk }) => {
    const size = chunk ?? REAP_CHUNK;
    const p = provider(await ctx.runQuery(internal.boxService.serviceProvider, { serviceId }), UNKNOWN_MB);
    if (!p) return null;
    let listed;
    try {
      listed = (await retrying(() => p.list({ tb_service: serviceId }))).filter((b) => after === undefined || b.providerBoxId > after).sort((a, b) => (a.providerBoxId < b.providerBoxId ? -1 : 1));
    } catch (e) {
      console.warn("could not list a virtual runner's boxes", message(e));
      return null;
    }
    const boxes = listed.slice(0, size).map((b) => ({ providerBoxId: b.providerBoxId, state: b.state, boxId: b.tags.tb_box ?? '', attempt: Number(b.tags.tb_attempt) || 0 }));
    for (const step of await ctx.runQuery(internal.boxService.reapPlan, { serviceId, boxes })) {
      if (step.do === 'keep') continue;
      try {
        if (step.do === 'lost' && step.boxId) await reapLost(ctx, serviceId, p, step.boxId, step.box, step.seen);
        else if (await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: step.box, do: step.do, seen: step.seen })) await p.destroy(step.box.providerBoxId);
      } catch (e) {
        console.warn('a reaper step failed; the next run tries again', message(e));
      }
    }
    if (listed.length > size) await ctx.scheduler.runAfter(0, internal.boxService.reapService, { serviceId, after: boxes[boxes.length - 1]!.providerBoxId, chunk: size });
    return null;
  },
});

// A stopped box's loss: under the op lease (no wake or sleep is calling the
// provider for it), and only if the provider still says it's stopped.
async function reapLost(ctx: ActionCtx, serviceId: Id<'runnerServices'>, p: BoxProvider, boxId: Id<'boxes'>, b: Listed, seen: Snap): Promise<void> {
  const id = randomHex(8);
  if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId, id, name: 'reap' }))) return;
  try {
    const now = (await retrying(() => p.list({ tb_box: boxId }))).find((x) => x.providerBoxId === b.providerBoxId);
    if (!now || now.state !== 'stopped') return;
    if (await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: { ...b, state: now.state }, do: 'lost', seen })) await p.destroy(b.providerBoxId);
  } finally {
    await ctx.runMutation(internal.boxService.releaseOp, { boxId, id });
  }
}

export const serviceProvider = internalQuery({
  args: { serviceId: v.id('runnerServices') },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { serviceId }) => (await ctx.db.get(serviceId))?.provider ?? null,
});

/**
 * An archived thread's save after its virtual runner's deleteAfterDays
 * (decision 12): deleted, and the box `expired`, so the thread says it
 * can't come back rather than wait for ever. At most PRUNE_BATCH a run, the
 * rest in a run of its own.
 */
export const pruneSaves = machines.internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.number(),
  handler: async (machineCtx, { cursor }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    let pruned = 0;
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'gone')).paginate({ numItems: PRUNE_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      if (row.boxState.kind !== 'gone') continue;
      const days = (await ctx.db.get(row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
      if (row.boxState.at > now - days * DAY_MS) continue;
      const save = row.save?.storageId;
      if ((await boxMachine.send(machineCtx, row._id, { type: 'EXPIRE' })).status !== 'done') continue;
      if (save) await deleteIfUnused(ctx, save);
      pruned++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { cursor: page.continueCursor });
    return pruned;
  },
});
