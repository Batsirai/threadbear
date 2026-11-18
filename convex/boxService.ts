// The virtual runners' service (docs/virtual-runners.md, decisions 2, 7, 8,
// 9 and 12): the actions that call a box's provider, and the crons that
// sleep idle boxes, reap ones nobody wants and delete old saves.
//
// Each action is told only a box row's id. It reads the row again, acts on
// the row's newest attempt at a box only, and reports what the provider
// did through the box's machine (boxes.ts report), naming that attempt, so
// one run twice or late changes nothing of a newer box (boxMachine.ts
// newestAttempt, stale). The machine schedules them (boxMachine.ts
// provide): wakeBox when a box is wanted back, sleepBox once it has saved,
// destroyBox when its thread is archived; and boxes.ts addBox the first
// box's createBox.
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
import { notFound, transient } from './boxProviders/types';
import type { BoxProvider, ListedBox } from './boxProviders/types';

export const RETRY_MS = [300, 1500];
// A box being deleted this long is deleted again by the reaper.
export const DESTROY_AGAIN_MS = 10 * 60_000;
// Each cron's work per run, so none outgrows a function's limits.
export const IDLE_BATCH = 200;
export const REAP_LIST_MAX = 500;
export const REAP_DESTROYS = 25;
export const PRUNE_BATCH = 100;
const DAY_MS = 24 * 60 * 60_000;
// A thread working, or waiting on Mike's answer to an approval, isn't idle.
const BUSY: readonly string[] = ['starting', 'running', 'waiting'];

/** The provider for a virtual runner, from this deployment's environment (docs/forking.md lists them). */
export function providerFor(service: Pick<Doc<'runnerServices'>, 'provider' | 'box'>): BoxProvider {
  switch (service.provider) {
    case 'fly':
      return flyFromEnv(process.env, service.box.memoryMb);
  }
  throw new Error(`There's no provider called ${service.provider}.`);
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
  service: v.union(v.null(), v.object({ provider: v.string(), image: v.string(), box: v.object({ cpus: v.number(), memoryMb: v.number() }), region: v.optional(v.string()) })),
});
type Seen = Infer<typeof seenV>;

/** What an action needs of a box row and its virtual runner, read now. Never its hashes or sealed values. */
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
      service: s ? { provider: s.provider, image: s.image, box: s.box, ...(s.region !== undefined ? { region: s.region } : {}) } : null,
    };
  },
});

function provider(seen: Seen): BoxProvider | null {
  if (!seen.service) return null;
  try {
    return providerFor({ provider: seen.service.provider, box: seen.service.box });
  } catch (e) {
    console.warn('box provider not set up', message(e));
    return null;
  }
}

// ------------------------------------------------------------ making and waking a box

/**
 * A new attempt at a box, if the row still wants one (creating or waking)
 * and none is on its way: an attempt whose boot token is still live is,
 * so of two runs at once (this action scheduled twice, a wake and a loss
 * together) only the first makes a box. A run that dies after this leaves
 * its token to lapse, and the box machine's boot timer then fails the box;
 * the next message tries again.
 */
export const claimAttempt = internalMutation({
  args: { boxId: v.id('boxes'), bootHash: v.string() },
  returns: v.union(v.null(), v.object({ attempt: v.number() })),
  handler: async (ctx, { boxId, bootHash }) => {
    const row = await ctx.db.get(boxId);
    if (!row || (row.boxState.kind !== 'creating' && row.boxState.kind !== 'waking')) return null;
    if (row.bootTokenHash && row.bootAttempt === newestAttempt(row) && (row.bootExpiresAt ?? 0) > Date.now()) return null;
    return { attempt: (await newAttempt(ctx, row, bootHash)).attempt };
  },
});

/** The thread's first box (boxes.ts addBox schedules it). */
export const createBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await bringBack(ctx, boxId);
    return null;
  },
});

/**
 * The thread wants its box back (a message, or its box lost): its paused
 * box resumed, if the provider can pause and that box holds the thread's
 * key with no newer attempt asked for; otherwise a new attempt's box,
 * which restores the last save through its exchange.
 */
export const wakeBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await bringBack(ctx, boxId);
    return null;
  },
});

async function bringBack(ctx: ActionCtx, boxId: Id<'boxes'>): Promise<void> {
  let seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
  if (!seen || (seen.kind !== 'creating' && seen.kind !== 'waking')) return;
  const p = provider(seen);
  if (!p) {
    await report(ctx, seen.threadId, { type: 'FAILED', error: `The ${seen.service?.provider ?? 'box'} provider isn't set up on this deployment (docs/forking.md, Virtual runners).`, attempt: seen.newest });
    return;
  }
  // The box that slept, still holding the thread's key: resume it.
  const keyHolder = seen.hasKey && seen.keyAttempt !== undefined && seen.keyAttempt === seen.newest && seen.providerAttempt === seen.keyAttempt;
  if (seen.kind === 'waking' && keyHolder && seen.providerBoxId && p.caps.pause && p.resume) {
    const attempt = seen.keyAttempt!;
    const id = seen.providerBoxId;
    try {
      await retrying(() => p.resume!(id));
      await report(ctx, seen.threadId, { type: 'RESUMED', attempt });
      return;
    } catch (e) {
      // Gone, or it won't come back: its key goes, and a new box restores the save.
      console.warn('a paused box did not resume', message(e));
      await report(ctx, seen.threadId, { type: 'LOST', attempt });
      seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || seen.kind !== 'waking') return;
    }
  }
  const site = process.env.CONVEX_CLOUD_URL;
  const bootToken = BOOT_PREFIX + randomHex(32);
  const claim = await ctx.runMutation(internal.boxService.claimAttempt, { boxId, bootHash: await sha256(bootToken) });
  if (!claim) return;
  const { attempt } = claim;
  if (!site) {
    await report(ctx, seen.threadId, { type: 'FAILED', error: "CONVEX_CLOUD_URL isn't set, so a box can't be told where to sync.", attempt });
    return;
  }
  const service = seen.service!;
  let providerBoxId: string;
  try {
    ({ providerBoxId } = await retrying(() =>
      p.create({
        image: service.image,
        cpus: service.box.cpus,
        memoryMb: service.box.memoryMb,
        ...(service.region ? { region: service.region } : {}),
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
 * The box has saved and the thread is asleep (boxMachine.ts sleep): pause
 * it if the provider can, else delete it and report it LOST, so the next
 * wake makes a new box from the save. A paused box the provider no longer
 * has is LOST too.
 */
export const sleepBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'asleep' || !seen.providerBoxId) return null;
    const p = provider(seen);
    if (!p) return null;
    const id = seen.providerBoxId;
    const lost = { type: 'LOST' as const, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) };
    // Only the box that saved, holding the key, is paused; any other is no use asleep.
    if (p.caps.pause && p.pause && seen.hasKey && seen.keyAttempt === seen.providerAttempt) {
      try {
        await retrying(() => p.pause!(id));
      } catch (e) {
        if (notFound(e)) await report(ctx, seen.threadId, lost);
        else console.warn('a box did not pause; the reaper will try again', message(e));
      }
      return null;
    }
    try {
      await retrying(() => p.destroy(id));
    } catch (e) {
      console.warn('a sleeping box was not deleted; the reaper will try again', message(e));
      return null;
    }
    await report(ctx, seen.threadId, lost);
    return null;
  },
});

/**
 * The thread is archived (boxMachine.ts archive): every box the provider
 * has for it is deleted, older attempts' too, then DESTROYED. One that
 * fails stays `destroying`, and the reaper runs this again.
 */
export const destroyBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'destroying') return null;
    const p = provider(seen);
    if (!p) return null;
    try {
      const ids = new Set(seen.providerBoxId ? [seen.providerBoxId] : []);
      for (const b of await retrying(() => p.list({ tb_box: boxId }))) ids.add(b.providerBoxId);
      for (const id of ids) await retrying(() => p.destroy(id));
    } catch (e) {
      console.warn('a box was not deleted; the reaper will try again', message(e));
      return null;
    }
    await report(ctx, seen.threadId, { type: 'DESTROYED' });
    return null;
  },
});

// ------------------------------------------------------------ the crons

/**
 * Sleeps awake boxes (decisions 7 and 12): one whose thread has been idle
 * the virtual runner's idleSleepMinutes, or that has been up its
 * maxAwakeHoursPerDay today, is sent IDLE for its box and a `save`
 * command; the box saves and says so (boxes.ts boxSaved), and sleepBox
 * pauses or deletes it. Not while a command waits for it, so a message
 * that woke it past its hours still gets taken. At most IDLE_BATCH a run.
 */
export const sleepIdleBoxes = machines.internalMutation({
  args: {},
  returns: v.number(),
  handler: async (machineCtx) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    const services = new Map<string, Doc<'runnerServices'> | null>();
    let asked = 0;
    for (const row of await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'awake')).take(IDLE_BATCH)) {
      if (row.boxState.kind !== 'awake') continue;
      if (!services.has(row.serviceId)) services.set(row.serviceId, await ctx.db.get(row.serviceId));
      const limits = services.get(row.serviceId)?.limits ?? BOX_LIMITS;
      if (await waitingFor(ctx, row.runnerId)) continue;
      const thread = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', row.threadId)).unique();
      const last = Math.max(row.boxState.since, thread?.lastActivityMs ?? 0);
      const idle = !(thread && BUSY.includes(thread.status)) && now - last >= limits.idleSleepMinutes * 60_000;
      const overHours = awakeTodayMs(row, row.boxState.since, now) >= limits.maxAwakeHoursPerDay * 60 * 60_000;
      if (!idle && !overHours) continue;
      const r = await boxMachine.send(machineCtx, row._id, { type: 'IDLE', ...(row.keyAttempt !== undefined ? { attempt: row.keyAttempt } : {}) });
      if (r.status !== 'done') continue;
      await askToSave(ctx, row);
      asked++;
    }
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

const listedV = v.object({ providerBoxId: v.string(), state: v.string(), boxId: v.string(), attempt: v.number() });
const stepV = v.object({ providerBoxId: v.string(), boxId: v.optional(v.id('boxes')), threadId: v.optional(v.string()), attempt: v.number(), do: v.union(v.literal('destroy'), v.literal('adopt'), v.literal('lost'), v.literal('sleep')) });
type Step = Infer<typeof stepV>;

/**
 * What the reaper does with each box a virtual runner's provider has
 * (decision 12). Never the current attempt's box while it's wanted:
 * - no row for it, another virtual runner's row, or an attempt other than
 *   the row's newest (an older one's, or not one at all): destroy;
 * - its row archived and gone, or failed (no key works for it): destroy;
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
export const reapPlan = internalQuery({
  args: { serviceId: v.id('runnerServices'), boxes: v.array(listedV) },
  returns: v.array(stepV),
  handler: async (ctx, { serviceId, boxes }) => {
    const out: Step[] = [];
    for (const b of boxes) {
      const id = ctx.db.normalizeId('boxes', b.boxId);
      const row = id ? await ctx.db.get(id) : null;
      const step = (what: Step['do']) => out.push({ providerBoxId: b.providerBoxId, attempt: b.attempt, do: what, ...(row ? { boxId: row._id, threadId: row.threadId } : {}) });
      // Attempts count from 1, and each is minted before its box is asked
      // for: any other number is an older attempt's, or nothing of ours.
      if (!row || row.serviceId !== serviceId || !Number.isSafeInteger(b.attempt) || b.attempt < 1 || b.attempt !== newestAttempt(row)) {
        step('destroy');
        continue;
      }
      const kind = row.boxState.kind;
      if (kind === 'gone' || kind === 'failed') step('destroy');
      else if (kind === 'destroying') continue;
      else if (kind === 'asleep' && row.keyAttempt !== b.attempt) step('destroy');
      else if (row.providerBoxId !== b.providerBoxId) step(row.providerAttempt === b.attempt ? 'destroy' : 'adopt');
      else if (b.state === 'stopped' && ['awake', 'saving', 'asleep'].includes(kind) && row.keyAttempt === b.attempt) step('lost');
      else if (kind === 'asleep' && b.state === 'running') step('sleep');
    }
    return out;
  },
});

export const servicesToReap = internalQuery({
  args: {},
  returns: v.array(v.object({ serviceId: v.id('runnerServices'), provider: v.string(), memoryMb: v.number() })),
  handler: async (ctx) => (await ctx.db.query('runnerServices').take(100)).map((s) => ({ serviceId: s._id, provider: s.provider, memoryMb: s.box.memoryMb })),
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

/** The reaper (reapPlan), per virtual runner, at most REAP_DESTROYS deletes each a run. */
export const reapBoxes = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const s of await ctx.runQuery(internal.boxService.servicesToReap, {})) {
      let p: BoxProvider;
      let listed: ListedBox[];
      try {
        p = providerFor({ provider: s.provider, box: { cpus: 1, memoryMb: s.memoryMb } });
        listed = await retrying(() => p.list({ tb_service: s.serviceId }));
      } catch (e) {
        console.warn('could not list a virtual runner\'s boxes', message(e));
        continue;
      }
      const boxes = listed.slice(0, REAP_LIST_MAX).map((b) => ({ providerBoxId: b.providerBoxId, state: b.state, boxId: b.tags.tb_box ?? '', attempt: Number(b.tags.tb_attempt) || 0 }));
      let destroyed = 0;
      for (const step of await ctx.runQuery(internal.boxService.reapPlan, { serviceId: s.serviceId, boxes })) {
        try {
          if (step.do === 'adopt' && step.threadId) await report(ctx, step.threadId, { type: 'CREATED', providerBoxId: step.providerBoxId, attempt: step.attempt });
          else if (step.do === 'sleep' && step.boxId) await ctx.scheduler.runAfter(0, internal.boxService.sleepBox, { boxId: step.boxId });
          else if (destroyed < REAP_DESTROYS) {
            destroyed++;
            if (step.do === 'lost' && step.threadId) await report(ctx, step.threadId, { type: 'LOST', attempt: step.attempt });
            await p.destroy(step.providerBoxId);
          }
        } catch (e) {
          console.warn('a reaper step failed; the next run tries again', message(e));
        }
      }
    }
    for (const boxId of await ctx.runQuery(internal.boxService.stuckDestroying, {})) await ctx.scheduler.runAfter(0, internal.boxService.destroyBox, { boxId });
    return null;
  },
});

/**
 * Deletes archived threads' saves after their virtual runner's
 * deleteAfterDays (decision 12), and the box row with it: a row that's
 * `gone` has nothing else left. At most PRUNE_BATCH a run.
 */
export const pruneSaves = machines.internalMutation({
  args: {},
  returns: v.number(),
  handler: async (machineCtx) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    let pruned = 0;
    for (const row of await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'gone')).take(PRUNE_BATCH)) {
      if (row.boxState.kind !== 'gone') continue;
      const days = (await ctx.db.get(row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
      if (row.boxState.at > now - days * DAY_MS) continue;
      await boxMachine.purge(machineCtx, row._id);
      if (row.save) await deleteIfUnused(ctx, row.save.storageId);
      pruned++;
    }
    return pruned;
  },
});
