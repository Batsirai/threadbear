// Where the rest of the backend tells a thread's box on a virtual runner
// (docs/virtual-runners.md, decisions 6 and 7) that something happened to
// its thread: a command queued for it (wake it), or the thread archived or
// deleted (delete its box). Each only schedules the box's own step, in an
// internal mutation of boxes.ts: the functions that call these are plain
// mutations, which can't send a box's `server` events.
import type { MutationCtx } from './_generated/server';
import { internal } from './_generated/api';

// The states a command for the box's runner wakes it from: asleep (resume
// it, or a new box from the save), failed (try a new box) and saving (it
// stays up, boxMachine.ts).
export const WAKES_FROM: readonly string[] = ['asleep', 'failed', 'saving'];

// Long enough for the box's runner to finish the command that archived its
// thread before its key stops working.
export const ARCHIVE_GRACE_MS = 60_000;

/**
 * A command was queued for `runnerId` (machines.ts queued, both insert
 * sites): if that's a box that's asleep, wake it. Two quick sends both see
 * it asleep and both schedule boxes:wakeFor; only the first's WAKE is
 * taken, so they make one wake. A box's `save` (boxService.ts askToSave)
 * isn't a reason to wake it.
 */
export async function wakeIfAsleep(ctx: MutationCtx, runnerId: string, kind: string): Promise<void> {
  if (kind === 'save') return;
  const row = await ctx.db
    .query('boxes')
    .withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))
    .first();
  if (row && WAKES_FROM.includes(row.boxState.kind)) await ctx.scheduler.runAfter(0, internal.boxes.wakeFor, { runnerId });
}

/**
 * The thread was archived or deleted: if it has a box, the box is deleted
 * (ARCHIVE, then boxService.ts destroyBox) after ARCHIVE_GRACE_MS, unless
 * it's back out of the archive by then.
 */
export async function archiveSoon(ctx: MutationCtx, threadId: string): Promise<void> {
  const row = await ctx.db
    .query('boxes')
    .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
    .first();
  if (row && row.boxState.kind !== 'destroying' && row.boxState.kind !== 'gone') await ctx.scheduler.runAfter(ARCHIVE_GRACE_MS, internal.boxes.archiveIfStill, { threadId });
}
