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
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { box as boxMachine, machines, queued } from './machines';
import { newestAttempt } from './boxMachine';
import { SAVE_MS, WAKE_GRACE_MS } from './boxStates';
import { activeMove, askToSave, BOOT_PREFIX, BOX_LIMITS, mayMintAttempt, newAttempt, overHours, randomHex, usedTodayMs } from './boxes';
import { sha256 } from './lib';
import { deleteIfUnused } from './sync';
import { FLY_SUSPEND_MAX_MB, flyFromEnv } from './boxProviders/fly';
import { notFound, ProviderError, transient } from './boxProviders/types';
import type { BoxProvider } from './boxProviders/types';

export const RETRY_MS = [300, 1500];
// How long an action may hold a box's op lease (a Fly wait is 60 s at most,
// tried three times), and how soon one that found it held tries again.
// Each provider call checks and renews it, and has a deadline of its own
// (CALL_MS) well inside it, so a lease can only lapse under a run that's died.
export const OP_LEASE_MS = 3 * 60_000;
export const OP_RETRY_MS = 5_000;
export const CALL_MS = 40_000;
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

/** Whether the provider can pause a box of `memoryMb`, by its size alone (Fly: 2048 MB or less). */
export function pauseSupported(provider: string, memoryMb: number): boolean {
  return provider === 'fly' && memoryMb <= FLY_SUSPEND_MAX_MB;
}

/** The provider for a virtual runner's box of `memoryMb` (its pause support), from this deployment's environment (docs/forking.md lists them). */
export function providerFor(provider: string, memoryMb: number): BoxProvider {
  // BOX_CALL_TIMEOUT_MS: a shorter deadline per call, for tests; never longer than CALL_MS.
  const timeoutMs = Math.min(CALL_MS, Number(process.env.BOX_CALL_TIMEOUT_MS) || CALL_MS);
  switch (provider) {
    case 'fly':
      return flyFromEnv(process.env, memoryMb, undefined, timeoutMs);
  }
  throw new Error(`There's no provider called ${provider}.`);
}

async function retrying<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (e instanceof LeaseLost || i >= RETRY_MS.length || !transient(e)) throw e;
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
// `op`: the reporting run's op lease; one that has lost it is told no (boxes.ts report).
const report = (ctx: ActionCtx, threadId: string, event: Event, op?: string): Promise<boolean> => ctx.runMutation(internal.boxes.report, { threadId, event, ...(op ? { op } : {}) });

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
  // Asleep or shelved with work newer than its save (slept unsaved at its
  // day's hours, or archived and its save never came).
  unsaved: v.boolean(),
  // Kept running though asleep or shelved (keepRunning).
  keptRunning: v.boolean(),
  // Attempts whose boxes may hold work newer than the last save (boxMachine.ts holdsWork).
  workAttempts: v.array(v.number()),
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
      unsaved: row.boxState.kind === 'shelved' || (row.boxState.kind === 'asleep' && row.boxState.unsaved === true),
      keptRunning: row.keptRunningSince !== undefined,
      workAttempts: row.workAttempts ?? [],
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

type OpName = 'createBox' | 'wakeBox' | 'sleepBox' | 'destroyBox' | 'checkBox' | 'retireBox';

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

/** Whether this run still holds the box's op lease; if so it runs OP_LEASE_MS from now. */
export const holdOp = internalMutation({
  args: { boxId: v.id('boxes'), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, id }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== id || row.op.until <= Date.now()) return false;
    await ctx.db.patch(boxId, { op: { ...row.op, until: Date.now() + OP_LEASE_MS } });
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

// This run's lease went (it ran past OP_LEASE_MS between checks): it stops, acting on nothing more.
class LeaseLost extends Error {}

type Op = { ctx: ActionCtx; boxId: Id<'boxes'>; id: string };

async function stillHeld(op: Op): Promise<void> {
  if (!(await op.ctx.runMutation(internal.boxService.holdOp, { boxId: op.boxId, id: op.id }))) throw new LeaseLost();
}

/**
 * The provider, fenced by the op lease: each call checks (and renews) the
 * lease before and after it, and each call has its own deadline well
 * inside the lease (providerFor), so a run that has lost the lease never
 * calls the provider again, nor reports what it saw.
 */
function fenced(op: Op, p: BoxProvider): BoxProvider {
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    await stillHeld(op);
    const out = await f(...a);
    await stillHeld(op);
    return out;
  };
  return {
    name: p.name,
    caps: p.caps,
    create: wrap(p.create.bind(p)),
    list: wrap(p.list.bind(p)),
    destroy: wrap(p.destroy.bind(p)),
    ...(p.pause ? { pause: wrap(p.pause.bind(p)) } : {}),
    ...(p.resume ? { resume: wrap(p.resume.bind(p)) } : {}),
  };
}

// Runs `f` holding the box's op lease, or runs this action again shortly if another holds it.
async function withOp(ctx: ActionCtx, boxId: Id<'boxes'>, name: OpName, f: (op: Op) => Promise<void>): Promise<void> {
  const id = randomHex(8);
  if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId, id, name }))) {
    await ctx.scheduler.runAfter(OP_RETRY_MS, internal.boxService[name], { boxId });
    return;
  }
  try {
    await f({ ctx, boxId, id });
  } catch (e) {
    if (!(e instanceof LeaseLost)) throw e;
    console.warn(`${name} lost its op lease, so it stopped`);
  } finally {
    await ctx.runMutation(internal.boxService.releaseOp, { boxId, id });
  }
}

/**
 * The provider's box `id` brought in line with the row: running while the
 * thread is up, paused while it's asleep or shelved (if it can pause).
 * Asked again after each call, a few times, since the row may move on
 * while one is on its way; it stops when they match or the lease goes.
 */
async function reconcile(op: Op, p: BoxProvider, id: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const row = await op.ctx.runQuery(internal.boxService.boxFor, { boxId: op.boxId });
    if (!row || row.providerBoxId !== id) return;
    const want = ['waking', 'awake', 'saving', 'archiving'].includes(row.kind) || row.keptRunning ? 'running' : ['asleep', 'shelved'].includes(row.kind) && row.hasKey && p.caps.pause ? 'paused' : null;
    if (!want) return;
    const have = (await retrying(() => p.list({ tb_box: op.boxId }))).find((b) => b.providerBoxId === id)?.state;
    if (!have || have === want) return;
    if (want === 'running' && p.resume) await retrying(() => p.resume!(id));
    else if (want === 'paused' && p.pause) await retrying(() => p.pause!(id));
    else return;
  }
}

// ------------------------------------------------------------ making and waking a box

/**
 * A new attempt at a box, if the row still wants one (creating or waking),
 * none is on its way (an attempt whose boot token is still live is), and
 * this run still holds the op lease. A run that dies after this leaves its
 * token to lapse, and the box machine's boot timer then fails the box; the
 * next message tries again. The size it's made at is kept for the attempt
 * (boxes.size), as the virtual runner's may change.
 */
export const claimAttempt = internalMutation({
  args: { boxId: v.id('boxes'), bootHash: v.string(), op: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ attempt: v.number(), image: v.string(), cpus: v.number(), memoryMb: v.number(), region: v.optional(v.string()) })),
  handler: async (ctx, { boxId, bootHash, op }) => {
    const row = await ctx.db.get(boxId);
    if (!row || (row.boxState.kind !== 'creating' && row.boxState.kind !== 'waking')) return null;
    if (op !== undefined && !(row.op?.id === op && row.op.until > Date.now())) return null;
    if (!mayMintAttempt(row)) return null;
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
    await withOp(ctx, boxId, 'createBox', (op) => bringBack(op));
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
    await withOp(ctx, boxId, 'wakeBox', (op) => bringBack(op));
    return null;
  },
});

async function bringBack(op: Op): Promise<void> {
  const { ctx, boxId } = op;
  let seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
  if (!seen || (seen.kind !== 'creating' && seen.kind !== 'waking')) return;
  // The box that slept, still holding the thread's key: resume it.
  const keyHolder = seen.hasKey && seen.keyAttempt !== undefined && seen.keyAttempt === seen.newest && seen.providerAttempt === seen.keyAttempt;
  const raw = provider(seen.provider, seen.memoryMb);
  // Invariant W(d): no provider set up (or no address to give a box): nothing
  // changes, and it's tried again shortly. Never FAILED, never a new attempt.
  const site = process.env.CONVEX_CLOUD_URL;
  if (!raw || !site) {
    console.warn(!raw ? `the ${seen.provider ?? 'box'} provider isn't set up on this deployment; trying again shortly` : "CONVEX_CLOUD_URL isn't set; trying again shortly");
    await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
    return;
  }
  // Kept running (it couldn't pause with unsaved work in it): it's up already.
  if (seen.kind === 'waking' && keyHolder && seen.keptRunning) {
    if (await report(ctx, seen.threadId, { type: 'RESUMED', attempt: seen.keyAttempt! }, op.id)) return;
    seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'waking') return;
  }
  if (seen.kind === 'waking' && keyHolder && seen.providerBoxId && raw?.caps.pause && raw.resume) {
    const paused = fenced(op, raw);
    const attempt = seen.keyAttempt!;
    const id = seen.providerBoxId;
    let taken = false;
    try {
      await retrying(() => paused.resume!(id));
      taken = await report(ctx, seen.threadId, { type: 'RESUMED', attempt }, op.id);
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      console.warn('a paused box did not resume', message(e));
      // Only the provider saying it's gone (or has lost its disk) gives it up:
      // anything else, and it may still hold work newer than the save, so
      // the wake tries it again shortly (and the boot timer keeps trying).
      if (!notFound(e) && (await providerState(paused, boxId, id)) !== 'gone') {
        await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
        return;
      }
      await report(ctx, seen.threadId, { type: 'LOST', attempt }, op.id);
    }
    if (taken) {
      await reconcile(op, paused, id);
      return;
    }
    // Not resumed (it was lost, or its key went meanwhile): if the thread
    // still wants a box, it gets a new one, here and now.
    seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'waking') return;
  }
  // Invariant W(c): a box that may hold work newer than its save is waited
  // on (the wake tries it again, within its grace), never replaced.
  if (seen.workAttempts.length) {
    if (seen.kind === 'waking') await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
    return;
  }
  const bootToken = BOOT_PREFIX + randomHex(32);
  const claim = await ctx.runMutation(internal.boxService.claimAttempt, { boxId, bootHash: await sha256(bootToken), op: op.id });
  if (!claim) return;
  const { attempt } = claim;
  const made = provider(seen.provider, claim.memoryMb)!;
  const p = fenced(op, made);
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
    if (e instanceof LeaseLost) throw e;
    await report(ctx, seen.threadId, { type: 'FAILED', error: `${made.name}: ${message(e)}`, attempt }, op.id);
    return;
  }
  // Not taken: the thread was archived meanwhile, or a newer attempt has
  // its box. This one isn't wanted.
  if (!(await report(ctx, seen.threadId, { type: 'CREATED', providerBoxId, attempt }, op.id))) await p.destroy(providerBoxId).catch((e) => console.warn('an unwanted box was not deleted; the reaper will', message(e)));
}

// ------------------------------------------------------------ sleeping and deleting

/**
 * The thread is asleep or shelved (boxMachine.ts sleep, sleepUnsaved,
 * shelve): pause its box if that box can pause (by the size it was made
 * at) and holds the key, else delete it and report it LOST, so the next
 * wake makes a new box from the save. A box the provider no longer has is
 * LOST too, and one whose pause is refused is deleted instead. Then the
 * box is brought in line with the row (reconcile): one woken while it
 * paused is resumed.
 */
export const sleepBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'sleepBox', async (op) => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || (seen.kind !== 'asleep' && seen.kind !== 'shelved') || !seen.providerBoxId) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      const id = seen.providerBoxId;
      const lost = { type: 'LOST' as const, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) };
      const keyHolder = seen.hasKey && seen.keyAttempt === seen.providerAttempt;
      // Only the box holding the key is paused; any other is no use asleep.
      // Whether it can pause is the size it was made at (boxes.size), never
      // one refusal: a pause that fails, refused or not, is the billing
      // guard's to try again, every pass with a backoff (suspendFailed).
      if (p.caps.pause && p.pause && p.resume && keyHolder) {
        try {
          await retrying(() => p.pause!(id));
        } catch (e) {
          if (e instanceof LeaseLost) throw e;
          if (notFound(e)) await report(ctx, seen.threadId, lost, op.id);
          else {
            console.warn('a box did not pause; the billing guard will try again', message(e));
            await ctx.runMutation(internal.boxService.suspendFailed, { boxId, attempt: seen.providerAttempt ?? 0 });
          }
          return;
        }
        await reconcile(op, p, id);
        return;
      }
      // Work newer than its save is never deleted with the box (only once
      // its days are up, or the thread is): it's kept running, asked to save.
      if (seen.unsaved && keyHolder) await keepRunning(op);
      else await deleteAsleep(op, p, seen, id);
    });
    return null;
  },
});

// A pause that failed is tried again by the guard after PASS_MS, doubling, at most an hour.
export const SUSPEND_BACKOFF_MAX_MS = 60 * 60_000;
export const suspendFailed = internalMutation({
  args: { boxId: v.id('boxes'), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { boxId, attempt }) => {
    const row = await ctx.db.get(boxId);
    if (!row) return null;
    const n = row.suspendFails?.attempt === attempt ? row.suspendFails.n + 1 : 1;
    await ctx.db.patch(boxId, { suspendFails: { attempt, n, next: Date.now() + Math.min(PASS_MS * 2 ** (n - 1), SUSPEND_BACKOFF_MAX_MS) } });
    return null;
  },
});

// A box that can't pause, asleep or shelved with unsaved work: kept running
// (its time counts toward its day's hours) and asked to save again on a
// backoff (retryKeptSaves) until it does, or its days run out.
async function keepRunning(op: Op): Promise<void> {
  await op.ctx.runMutation(internal.boxService.markKept, { boxId: op.boxId, op: op.id });
}

export const markKept = internalMutation({
  args: { boxId: v.id('boxes'), op: v.string() },
  returns: v.null(),
  handler: async (ctx, { boxId, op }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== op || row.keptRunningSince !== undefined) return null;
    const now = Date.now();
    // Running, and counted so (boxes.ts countRunning) until the guard sees otherwise.
    await ctx.db.patch(boxId, { keptRunningSince: now, saveAsks: { n: 0, next: now }, seenRunningAt: now });
    return null;
  },
});

// The backoff between asking a kept-running box to save: 10 minutes, doubling, at most 6 hours.
export const SAVE_ASK_MS = 10 * 60_000;
export const SAVE_ASK_MAX_MS = 6 * 60 * 60_000;

/**
 * Boxes kept running with unsaved work (keepRunning): each is asked to save
 * again once its backoff is up. A page a run, the rest in a run of its own.
 */
export const retryKeptSaves = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.number(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    let asked = 0;
    const page = await ctx.db.query('boxes').withIndex('by_kept', (q) => q.gt('keptRunningSince', 0)).paginate({ numItems: IDLE_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      const asks = row.saveAsks ?? { n: 0, next: now };
      if (asks.next > now) continue;
      await askToSave(ctx, row);
      await ctx.db.patch(row._id, { saveAsks: { n: asks.n + 1, next: now + Math.min(SAVE_ASK_MS * 2 ** asks.n, SAVE_ASK_MAX_MS) } });
      asked++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.retryKeptSaves, { cursor: page.continueCursor });
    return asked;
  },
});

// How soon a wake whose resume failed (not for the box being gone) tries again.
export const WAKE_RETRY_MS = 60_000;

/**
 * The provider's word on box `id`: 'gone' if it no longer has it or the box
 * has lost its disk (a stopped Fly Machine's rootfs is reset), its state if
 * it has it, or 'unknown' if it couldn't be asked: only 'gone' ever lets a
 * box be given up.
 */
async function providerState(p: BoxProvider, boxId: Id<'boxes'>, id: string): Promise<'gone' | 'running' | 'paused' | 'unknown'> {
  let listed;
  try {
    listed = await retrying(() => p.list({ tb_box: boxId }));
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    return 'unknown';
  }
  const b = listed.find((x) => x.providerBoxId === id);
  return !b || b.state === 'stopped' ? 'gone' : b.state;
}

/**
 * A box that's stopped heartbeating (boxMachine.ts unheard): the provider is
 * asked. Gone (or its disk lost): LOST, and a new box restores the save.
 * Paused: resumed. Running: kept as it is, its key working, the row marked
 * unreachable (until it heartbeats again), and asked again in five minutes.
 */
export const checkBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'checkBox', async (op) => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || !['awake', 'saving'].includes(seen.kind) || !seen.providerBoxId) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      const id = seen.providerBoxId;
      const state = await providerState(p, boxId, id);
      if (state === 'gone') await report(ctx, seen.threadId, { type: 'LOST', ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) }, op.id);
      else if (state === 'paused' && p.resume) await retrying(() => p.resume!(id)).catch((e) => console.warn("an unreachable box didn't resume", message(e)));
    });
    return null;
  },
});

async function deleteAsleep(op: Op, p: BoxProvider, seen: Seen, id: string): Promise<void> {
  try {
    await retrying(() => p.destroy(id));
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    console.warn('a sleeping box was not deleted; the reaper will try again', message(e));
    return;
  }
  await report(op.ctx, seen.threadId, { type: 'LOST', ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) }, op.id);
}

/**
 * The thread is archived (boxMachine.ts archive, savedAndGo), or its kept
 * box's days are up (expireShelf): every box the provider has for it is
 * deleted, older attempts' too, then DESTROYED. One that fails stays as it
 * is, and the reaper runs this again.
 */
export const destroyBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'destroyBox', async (op) => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || !(seen.kind === 'destroying' || (seen.kind === 'expired' && seen.providerBoxId))) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      try {
        // Not one that may hold work newer than the save (an older attempt's,
        // kept): the reaper deletes that once the thread's days run out.
        const keep = (attempt: number | undefined) => seen.kind !== 'expired' && attempt !== undefined && seen.workAttempts.includes(attempt);
        const ids = new Set(seen.providerBoxId && !keep(seen.providerAttempt) ? [seen.providerBoxId] : []);
        for (const b of await retrying(() => p.list({ tb_box: boxId }))) if (!keep(Number(b.tags.tb_attempt))) ids.add(b.providerBoxId);
        for (const id of ids) await retrying(() => p.destroy(id));
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        console.warn('a box was not deleted; the reaper will try again', message(e));
        return;
      }
      await report(ctx, seen.threadId, { type: 'DESTROYED' }, op.id);
    });
    return null;
  },
});

// ------------------------------------------------------------ the crons

/**
 * Sleeps awake boxes (decisions 7 and 12). Its day's hours come first: one
 * up its maxAwakeHoursPerDay today is sent IDLE `capped` and a `save`
 * command whatever's waiting for it (what's waiting waits for tomorrow's
 * hours, or Mike's wakePastHours), and sleeps all the same if no save comes
 * (boxMachine.ts sleepUnsaved). Otherwise one whose thread has been idle
 * the virtual runner's idleSleepMinutes, with no command waiting, gets IDLE
 * and a `save`. A thread moving (a move going, either way) is neither: the
 * cap waits for the move to end. A page of `numItems` a run, the rest in a
 * run of its own from `cursor`; the first page also wakes any box waiting
 * for room or a new day (boxes.ts wakeAllWaiting).
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
      if (await activeMove(ctx, row.threadId)) continue;
      const capped = overHours(row, limits.maxAwakeHoursPerDay, now);
      if (!capped) {
        if (await waitingFor(ctx, row.runnerId)) continue;
        const thread = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', row.threadId)).unique();
        const last = Math.max(row.boxState.since, thread?.lastActivityMs ?? 0);
        if ((thread && BUSY.includes(thread.status)) || now - last < limits.idleSleepMinutes * 60_000) continue;
      }
      const r = await boxMachine.send(machineCtx, row._id, { type: 'IDLE', ...(row.keyAttempt !== undefined ? { attempt: row.keyAttempt } : {}), ...(capped ? { capped: true } : {}) });
      if (r.status !== 'done') continue;
      await askToSave(ctx, row);
      asked++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.sleepIdleBoxes, { cursor: page.continueCursor, numItems: batch });
    if (!cursor) {
      await ctx.scheduler.runAfter(0, internal.boxes.wakeAllWaiting, {});
      await ctx.scheduler.runAfter(0, internal.boxService.retryKeptSaves, {});
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

// ------------------------------------------------------------ the reaper and the billing guard

const listedV = v.object({ providerBoxId: v.string(), state: v.string(), boxId: v.string(), attempt: v.number() });
type Listed = Infer<typeof listedV>;
const doV = v.union(v.literal('destroy'), v.literal('adopt'), v.literal('lost'), v.literal('suspend'), v.literal('keep'));
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

// The guard's pass (reapBoxes, every PASS_MS), and how long a box that's
// up may go unheard before it isn't entitled to run (the lease is 5 minutes;
// checkBox asks the provider meanwhile).
export const PASS_MS = 5 * 60_000;
export const SILENT_MS = 15 * 60_000;
// States a box is charged for by its row (since it came up); in any other,
// by the guard seeing its machine run (observe).
const UP: readonly string[] = ['awake', 'saving', 'archiving'];
type Limits = Doc<'runnerServices'>['limits'];

/**
 * Invariant M, the one place it's decided: whether a machine the provider
 * has running is entitled to run now. Only the row's current attempt, in a
 * running state: booting within its boot timer; waking within
 * WAKE_GRACE_MS; up, heard from within SILENT_MS, and within its day's hours
 * (with SAVE_MS for the cron's capped save; a save asked for, or an
 * archive's, until its saveBy; Mike's wakePastHours; or its thread
 * moving). Anything else the guard pauses.
 */
export function entitled(row: Doc<'boxes'>, limits: Limits, b: Listed, moving: boolean, now: number): boolean {
  if (b.attempt !== newestAttempt(row)) return false;
  const s = row.boxState;
  const heard = (row.lastHeartbeatAt ?? 0) > now - SILENT_MS;
  const hoursOk = moving || usedTodayMs(row, now) < limits.maxAwakeHoursPerDay * 60 * 60_000 + SAVE_MS || !overHours(row, limits.maxAwakeHoursPerDay, now);
  switch (s.kind) {
    case 'creating':
    case 'starting':
      return now < s.bootBy;
    case 'waking':
      return now < (s.since ?? 0) + WAKE_GRACE_MS;
    case 'awake':
      return heard && hoursOk;
    case 'saving':
    case 'archiving':
      return heard && (hoursOk || now < s.saveBy);
    default:
      return false;
  }
}

/**
 * What the reaper and guard do with a machine the provider has (decisions
 * 12, invariants W and M). Thread deletion (no row) and retention's end
 * (expired) are the only things that delete a machine that may hold work.
 * - no row, another virtual runner's, a bogus attempt, or expired: destroy;
 * - stopped (on Fly its disk is reset) while it held the thread's work or
 *   key: lost, the provider's word;
 * - the current attempt's box the row doesn't know yet: adopt, work or
 *   not (a second for an attempt the row knows another of: destroy, unless
 *   it may hold work);
 * - holding no work newer than a save: an older attempt's, or a current
 *   one no state wants (gone, failed, or resting without the key): destroy;
 * - running and not entitled (entitled): suspend, never delete; one known
 *   not to pause is left running and counted (observe);
 * - anything else, one that may hold work newer than its save among them: kept.
 */
function planFor(row: Doc<'boxes'> | null, serviceId: string, limits: Limits, provider: string, b: Listed, moving: boolean, now: number): Do {
  if (!row || row.serviceId !== serviceId || !Number.isSafeInteger(b.attempt) || b.attempt < 1 || b.attempt > newestAttempt(row) || row.boxState.kind === 'expired') return 'destroy';
  const kind = row.boxState.kind;
  const work = row.workAttempts?.includes(b.attempt) ?? false;
  const current = b.attempt === newestAttempt(row);
  if (b.state === 'stopped' && (work || (current && row.keyAttempt === b.attempt && kind !== 'destroying'))) return 'lost';
  // The current attempt's machine the row doesn't know (its CREATED never came): taken in, work or not.
  // A second machine for an attempt the row knows another of: deleted, unless it may hold work.
  if (current && row.providerBoxId !== b.providerBoxId) return row.providerAttempt !== b.attempt ? 'adopt' : work ? 'keep' : 'destroy';
  if (!work) {
    if (!current) return 'destroy';
    if (kind === 'gone' || kind === 'failed') return 'destroy';
    if ((kind === 'asleep' || kind === 'shelved') && row.keyAttempt !== b.attempt) return 'destroy';
  }
  if (b.state === 'running' && !entitled(row, limits, b, moving, now)) {
    // One that can't pause by the size its attempt was made at is left running, counted (observe).
    if (!(row.size?.attempt === b.attempt && pauseSupported(provider, row.size.memoryMb))) return 'keep';
    // A pause that failed waits out its backoff (suspendFailed).
    if (row.suspendFails?.attempt === b.attempt && row.suspendFails.next > now) return 'keep';
    return 'suspend';
  }
  return 'keep';
}

async function rowOf(ctx: { db: MutationCtx['db'] }, boxId: string): Promise<Doc<'boxes'> | null> {
  const id = ctx.db.normalizeId('boxes', boxId);
  return id ? await ctx.db.get(id) : null;
}

async function planOf(ctx: QueryCtx, serviceId: Id<'runnerServices'>, b: Listed, now: number): Promise<{ row: Doc<'boxes'> | null; do: Do }> {
  const row = await rowOf(ctx as never, b.boxId);
  const service = await ctx.db.get(serviceId);
  const moving = row ? await activeMove(ctx, row.threadId, now) : false;
  return { row, do: planFor(row, serviceId, service?.limits ?? BOX_LIMITS, service?.provider ?? '', b, moving, now) };
}

/** The plan for a page of listed machines, with each row as it is now. */
export const reapPlan = internalQuery({
  args: { serviceId: v.id('runnerServices'), boxes: v.array(listedV) },
  returns: v.array(v.object({ box: listedV, do: doV, seen: snapV, boxId: v.optional(v.id('boxes')) })),
  handler: async (ctx, { serviceId, boxes }) => {
    const out = [];
    const now = Date.now();
    for (const b of boxes) {
      const { row, do: planned } = await planOf(ctx, serviceId, b, now);
      out.push({ box: b, do: planned, seen: snapOf(row), ...(row ? { boxId: row._id } : {}) });
    }
    return out;
  },
});

/**
 * One step of the plan, checked again first: only if its row is as the
 * plan saw it and the step is still what it would plan, in this one step,
 * so a stale plan does nothing. A loss is reported here; an adoption too
 * (CREATED, which the machine checks). Answers whether the action should
 * now do the provider's part (destroy, or suspend).
 */
export const reapStep = machines.internalMutation({
  args: { serviceId: v.id('runnerServices'), box: listedV, do: doV, seen: snapV },
  returns: v.boolean(),
  handler: async (machineCtx, { serviceId, box: b, do: planned, seen }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const { row, do: now } = await planOf(ctx, serviceId, b, Date.now());
    if (!sameSnap(snapOf(row), seen) || now !== planned) return false;
    if (planned === 'destroy' || planned === 'suspend') return true;
    if (!row) return false;
    if (planned === 'lost') return (await boxMachine.send(machineCtx, row._id, { type: 'LOST', attempt: b.attempt })).status === 'done';
    if (planned === 'adopt') await boxMachine.send(machineCtx, row._id, { type: 'CREATED', providerBoxId: b.providerBoxId, attempt: b.attempt });
    return false;
  },
});

/**
 * Invariant M's count: running time as the provider shows it. Each pass,
 * a row whose machines the provider shows running, other than its current
 * one in a state charged by the row (UP), is charged the time since its
 * last pass (at most two passes' worth, today's part only) and marked
 * `seenRunningAt`, which counts it toward maxBoxes (boxes.ts countRunning).
 */
export const observe = internalMutation({
  args: { serviceId: v.id('runnerServices'), boxes: v.array(listedV) },
  returns: v.null(),
  handler: async (ctx, { serviceId, boxes }) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const byRow = new Map<string, Listed[]>();
    for (const b of boxes) byRow.set(b.boxId, [...(byRow.get(b.boxId) ?? []), b]);
    for (const [boxId, list] of byRow) {
      const row = await rowOf(ctx, boxId);
      if (!row || row.serviceId !== serviceId) continue;
      const byState = UP.includes(row.boxState.kind);
      const counted = (RUNNING_STATES as readonly string[]).includes(row.boxState.kind);
      const running = list.some((b) => b.state === 'running' && !(byState && b.attempt === newestAttempt(row)));
      const patchFields: Partial<Doc<'boxes'>> = { chargedAt: now };
      // Not running: nothing for a pause's backoff to wait on.
      if (row.suspendFails && !list.some((b) => b.attempt === row.suspendFails!.attempt && b.state === 'running')) patchFields.suspendFails = undefined;
      if (running) {
        const from = Math.max(row.chargedAt ?? now - PASS_MS, now - 2 * PASS_MS, dayStart);
        patchFields.awakeToday = { day, ms: (row.awakeToday?.day === day ? row.awakeToday.ms : 0) + Math.max(0, now - from) };
      }
      patchFields.seenRunningAt = running && !counted ? now : undefined;
      await ctx.db.patch(row._id, patchFields);
    }
    return null;
  },
});
const RUNNING_STATES = ['creating', 'starting', 'awake', 'saving', 'archiving', 'waking'] as const;

export const servicesToReap = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  returns: v.object({ ids: v.array(v.id('runnerServices')), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db.query('runnerServices').paginate({ numItems, cursor });
    return { ids: page.page.map((s) => s._id), next: page.isDone ? null : page.continueCursor };
  },
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

/**
 * The reaper and billing guard (planFor), every PASS_MS: a run per virtual
 * runner, a page of virtual runners at a time carrying on from `cursor`;
 * and, on the first page, boxes stuck being deleted.
 */
export const reapBoxes = internalAction({
  args: { cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { cursor, numItems }) => {
    const { ids, next } = await ctx.runQuery(internal.boxService.servicesToReap, { cursor: cursor ?? null, numItems: numItems ?? 50 });
    for (const serviceId of ids) await ctx.scheduler.runAfter(0, internal.boxService.reapService, { serviceId });
    if (next) await ctx.scheduler.runAfter(0, internal.boxService.reapBoxes, { cursor: next, ...(numItems ? { numItems } : {}) });
    if (!cursor) for (const boxId of await ctx.runQuery(internal.boxService.stuckDestroying, {})) await ctx.scheduler.runAfter(0, internal.boxService.destroyBox, { boxId });
    return null;
  },
});

/**
 * One virtual runner's machines, `chunk` of them by id after `after`, then
 * the next chunk in a run of its own: every machine is reached however
 * many there are. Each chunk is charged (observe), then planned and acted
 * on. A loss or a pause is only made under the box's op lease, after
 * asking the provider again; a pause that fails is tried again next pass.
 * With no provider set up, nothing changes.
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
    await ctx.runMutation(internal.boxService.observe, { serviceId, boxes });
    for (const step of await ctx.runQuery(internal.boxService.reapPlan, { serviceId, boxes })) {
      if (step.do === 'keep') continue;
      try {
        if ((step.do === 'lost' || step.do === 'suspend') && step.boxId) await reapLeased(ctx, serviceId, step.boxId, step.box, step.do, step.seen);
        else if (await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: step.box, do: step.do, seen: step.seen })) await p.destroy(step.box.providerBoxId);
      } catch (e) {
        console.warn('a reaper step failed; the next run tries again', message(e));
      }
    }
    if (listed.length > size) await ctx.scheduler.runAfter(0, internal.boxService.reapService, { serviceId, after: boxes[boxes.length - 1]!.providerBoxId, chunk: size });
    // Once a pass (its first chunk), the other way round: every row against the whole listing.
    if (after === undefined) await sweepDrift(ctx, serviceId, p, listed.map((b) => ({ providerBoxId: b.providerBoxId, running: b.state === 'running' })));
    return null;
  },
});

// States a box's loss is taken in (boxMachine.ts LOST).
const LOSABLE: readonly string[] = ['creating', 'starting', 'awake', 'saving', 'archiving', 'asleep', 'waking', 'shelved'];

/**
 * The reconciler's other half (Framing B): every row of the virtual runner
 * against the provider's whole listing. One counted as running
 * (seenRunningAt) whose machine the listing doesn't show running stops
 * being counted. One whose machine is missing from the listing is asked
 * about directly (driftCheck), and reported LOST if the provider has it no
 * more. A page of rows a call.
 */
export const driftPage = internalMutation({
  args: { serviceId: v.id('runnerServices'), listed: v.array(v.object({ providerBoxId: v.string(), running: v.boolean() })), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ missing: v.array(v.object({ boxId: v.id('boxes'), providerBoxId: v.string(), attempt: v.number() })), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { serviceId, listed, cursor }) => {
    const byId = new Map(listed.map((b) => [b.providerBoxId, b.running]));
    const page = await ctx.db.query('boxes').withIndex('by_service_state', (q) => q.eq('serviceId', serviceId)).paginate({ numItems: PRUNE_BATCH, cursor });
    const missing = [];
    for (const row of page.page) {
      if (row.seenRunningAt !== undefined && !(row.providerBoxId && byId.get(row.providerBoxId))) await ctx.db.patch(row._id, { seenRunningAt: undefined });
      if (row.providerBoxId && !byId.has(row.providerBoxId) && LOSABLE.includes(row.boxState.kind)) missing.push({ boxId: row._id, providerBoxId: row.providerBoxId, attempt: row.providerAttempt ?? newestAttempt(row) });
    }
    return { missing, next: page.isDone ? null : page.continueCursor };
  },
});

async function sweepDrift(ctx: ActionCtx, serviceId: Id<'runnerServices'>, raw: BoxProvider, listed: { providerBoxId: string; running: boolean }[]): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: { missing: { boxId: Id<'boxes'>; providerBoxId: string; attempt: number }[]; next: string | null } = await ctx.runMutation(internal.boxService.driftPage, { serviceId, listed, cursor });
    for (const m of page.missing) await driftCheck(ctx, raw, m).catch((e) => console.warn("a drift check didn't happen; the next pass tries again", message(e)));
    cursor = page.next;
  } while (cursor);
}

// A machine missing from the listing, asked about directly under the box's
// op lease, and reported LOST only if the provider has it no more and the
// row still names it (driftLost).
async function driftCheck(ctx: ActionCtx, raw: BoxProvider, m: { boxId: Id<'boxes'>; providerBoxId: string; attempt: number }): Promise<void> {
  const id = randomHex(8);
  if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId: m.boxId, id, name: 'drift' }))) return;
  const p = fenced({ ctx, boxId: m.boxId, id }, raw);
  try {
    if ((await retrying(() => p.list({ tb_box: m.boxId }))).some((b) => b.providerBoxId === m.providerBoxId)) return;
    await ctx.runMutation(internal.boxService.driftLost, { ...m, op: id });
  } catch (e) {
    if (!(e instanceof LeaseLost)) throw e;
  } finally {
    await ctx.runMutation(internal.boxService.releaseOp, { boxId: m.boxId, id });
  }
}

export const driftLost = machines.internalMutation({
  args: { boxId: v.id('boxes'), providerBoxId: v.string(), attempt: v.number(), op: v.string() },
  returns: v.boolean(),
  handler: async (machineCtx, { boxId, providerBoxId, attempt, op }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== op || row.providerBoxId !== providerBoxId || (row.providerAttempt ?? newestAttempt(row)) !== attempt) return false;
    return (await boxMachine.send(machineCtx, boxId, { type: 'LOST', attempt })).status === 'done';
  },
});

/**
 * A loss or a pause, under the box's op lease (no wake or sleep is calling
 * the provider for it), and only if the provider still shows the machine
 * as the plan did and the step still holds. A pause that fails, refused or
 * not, is tried again after its backoff (suspendFailed).
 */
async function reapLeased(ctx: ActionCtx, serviceId: Id<'runnerServices'>, boxId: Id<'boxes'>, b: Listed, planned: 'lost' | 'suspend', seen: Snap): Promise<void> {
  const seenRow = await ctx.runQuery(internal.boxService.boxFor, { boxId });
  const raw = seenRow ? provider(seenRow.provider, seenRow.providerBoxId === b.providerBoxId ? seenRow.memoryMb : UNKNOWN_MB) : null;
  if (!raw) return;
  const id = randomHex(8);
  if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId, id, name: 'reap' }))) return;
  const op = { ctx, boxId, id };
  const p = fenced(op, raw);
  try {
    const now = (await retrying(() => p.list({ tb_box: boxId }))).find((x) => x.providerBoxId === b.providerBoxId);
    if (!now || now.state !== b.state) return;
    if (!(await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: b, do: planned, seen }))) return;
    if (planned === 'lost') {
      await p.destroy(b.providerBoxId);
      return;
    }
    if (!p.pause) return;
    try {
      await retrying(() => p.pause!(b.providerBoxId));
    } catch (e) {
      if (e instanceof LeaseLost || notFound(e)) throw e;
      // Refused or a hiccup alike: tried again after its backoff.
      await ctx.runMutation(internal.boxService.suspendFailed, { boxId, attempt: b.attempt });
      throw e;
    }
    await ctx.runMutation(internal.boxes.report, { threadId: seenRow!.threadId, event: { type: 'PAUSED', attempt: b.attempt }, op: id });
  } catch (e) {
    if (!(e instanceof LeaseLost)) console.warn("a guard step didn't happen; the next pass tries again", message(e));
  } finally {
    await ctx.runMutation(internal.boxService.releaseOp, { boxId, id });
  }
}

export const retireDue = internalQuery({
  args: { boxId: v.id('boxes'), asleepSince: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, asleepSince }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.boxState.kind !== 'asleep' || row.boxState.since !== asleepSince) return false;
    const days = (await ctx.db.get(row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
    return asleepSince <= Date.now() - days * DAY_MS;
  },
});

export const serviceProvider = internalQuery({
  args: { serviceId: v.id('runnerServices') },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { serviceId }) => (await ctx.db.get(serviceId))?.provider ?? null,
});

/**
 * Retention (decision 12): a thread left past its virtual runner's
 * deleteAfterDays loses what it keeps. Archived (`gone`, `shelved`): its
 * save and any kept box are deleted and it's `expired`, so it says it
 * can't come back (what's waiting for it fails, boxes.ts failExpired).
 * Asleep (measured from when it slept): its box, kept running or paused,
 * is deleted (retireBox), and it comes back from its last save, losing any
 * work newer than that. `gone`, then `shelved`, then `asleep` rows, at most
 * PRUNE_BATCH a run, the rest in a run of its own.
 */
export const pruneSaves = machines.internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), kind: v.optional(v.union(v.literal('gone'), v.literal('shelved'), v.literal('asleep'))) },
  returns: v.number(),
  handler: async (machineCtx, { cursor, kind = 'gone' }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    let pruned = 0;
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', kind)).paginate({ numItems: PRUNE_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      const s = row.boxState;
      const at = s.kind === 'gone' || s.kind === 'shelved' ? s.at : s.kind === 'asleep' ? s.since : undefined;
      if (at === undefined) continue;
      const days = (await ctx.db.get(row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
      if (at > now - days * DAY_MS) continue;
      if (s.kind === 'asleep') {
        if (row.providerBoxId === undefined && !row.workAttempts?.length) continue;
        // With the sleep it's for: retireBox checks it's still that sleep, still past its days.
        await ctx.scheduler.runAfter(0, internal.boxService.retireBox, { boxId: row._id, asleepSince: s.since });
        pruned++;
        continue;
      }
      const save = row.save?.storageId;
      if ((await boxMachine.send(machineCtx, row._id, { type: 'EXPIRE' })).status !== 'done') continue;
      if (save) await deleteIfUnused(ctx, save);
      pruned++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { cursor: page.continueCursor, kind });
    else if (kind === 'gone') await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { kind: 'shelved' });
    else if (kind === 'shelved') await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { kind: 'asleep' });
    return pruned;
  },
});

/**
 * An asleep thread past its retention (pruneSaves): every machine of it is
 * deleted (retention's end overrides invariant W), each reported LOST for
 * its attempt, so the next wake makes a new box from the last save.
 */
export const retireBox = internalAction({
  args: { boxId: v.id('boxes'), asleepSince: v.number() },
  returns: v.null(),
  handler: async (ctx, { boxId, asleepSince }) => {
    await withOp(ctx, boxId, 'retireBox', async (op) => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      // Still the sleep it was planned on, and still past the days set now: a thread woken and slept again since isn't touched.
      if (!seen || !(await ctx.runQuery(internal.boxService.retireDue, { boxId, asleepSince }))) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      for (const b of await retrying(() => p.list({ tb_box: boxId }))) {
        await retrying(() => p.destroy(b.providerBoxId));
        await report(ctx, seen.threadId, { type: 'LOST', attempt: Number(b.tags.tb_attempt) || 0 }, op.id);
      }
      // Its box went before (a delete that didn't report, say): what the row holds of it goes too.
      const after = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      for (const a of after?.workAttempts ?? []) await report(ctx, seen.threadId, { type: 'LOST', attempt: a }, op.id);
      if (after?.providerAttempt !== undefined) await report(ctx, seen.threadId, { type: 'LOST', attempt: after.providerAttempt }, op.id);
    });
    return null;
  },
});
