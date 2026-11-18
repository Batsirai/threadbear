// Every state machine in the backend (docs/lifecycles.md), checked together
// when the app loads: a command's (commandMachine.ts), a move's
// (moveMachine.ts), a runner request's (requestMachine.ts), a thread
// id's clear (clearMachine.ts) and a virtual runner's box (boxMachine.ts). Functions that
// send `server` events, purge rows or read failed timers are built with this
// catalog's internalMutation, which carries the brand those need and a db
// that can't write a machine's state; the rest of the backend stays on
// Convex's own builders, and sends the machine's role events from them.
import { defineMachines, deliveryArgs, type Machines } from '@convex-dev/state-machines';
import type { WithoutSystemFields } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { components, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, mutation, type MutationCtx } from './_generated/server';
import { appSchema } from './schema';
import { command as commandMachine } from './commandMachine';
import { move as moveMachine } from './moveMachine';
import { request as requestMachine } from './requestMachine';
import { clear as clearMachine } from './clearMachine';
import { box as boxMachine } from './boxMachine';
import { steppingFor } from './stepping';
import { wakeIfAsleep } from './boxHooks';

// A machine whose backfill's stepping stone is being deployed is left out (stepping.ts).
export const machines: Machines<typeof appSchema> = defineMachines(appSchema, [...(steppingFor('commandState') ? [] : [commandMachine]), ...(steppingFor('moveState') ? [] : [moveMachine]), ...(steppingFor('requestState') ? [] : [requestMachine]), ...(steppingFor('clearState') ? [] : [clearMachine]), boxMachine] as never, {
  mutation,
  internalMutation,
  internalQuery,
  deliver: internal.machines.deliver,
  component: components.stateMachines,
});

// Imported from here rather than its own module: sending needs the catalog, and importing this loads it.
export const command = commandMachine;
export const move = moveMachine;
export const request = requestMachine;
export const clear = clearMachine;
export const box = boxMachine;

/**
 * A new command, pending for its runner: the machine's QUEUE, which writes
 * its state (and `state`) and arms its timer. Both insert sites (relay.ts
 * queueCommand, phone.ts queue) come through here, so a command for a
 * sleeping box's runner wakes the box (boxHooks.ts wakeIfAsleep).
 */
export async function queued(ctx: MutationCtx, fields: Omit<WithoutSystemFields<Doc<'commands'>>, 'state' | 'commandState' | 'commandStateTimers'>): Promise<Id<'commands'>> {
  const r = await command.create(ctx, { ...fields, state: 'pending' } as never, { type: 'QUEUE' });
  if (r.status !== 'done') throw new ConvexError({ kind: 'conflict', message: `the command couldn't be queued: ${r.reasons.join(' ')}` });
  await wakeIfAsleep(ctx, fields.runnerId, fields.kind);
  return r.id as Id<'commands'>;
}

// Timers fire through this. A timer whose step throws stays pending, its job
// failed, until rearmTimer.
export const deliver = machines.internalMutation({ args: deliveryArgs, handler: machines.deliver });

/** Timers whose step threw, newest first. `npx convex run machines:failedTimers` */
export const failedTimers = machines.internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({ machine: v.string(), id: v.string(), event: v.string(), dueAt: v.number() })),
  handler: async (ctx, args) => await machines.failedTimers(ctx, args),
});

/** Delivers a failed timer again, once its bug is fixed.
 * `npx convex run machines:rearmTimer '{"machine": "command", "id": "...", "event": "LEASE_LAPSED"}'` */
export const rearmTimer = machines.internalMutation({
  args: { machine: v.string(), id: v.string(), event: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await machines.rearmTimer(ctx, args);
    return null;
  },
});

/**
 * Delivers again every timer whose job failed: the deploy runs it after a
 * stepping stone (stepping.ts), as a timer due while its machine was off
 * found nobody to deliver it to. One that fails again for a bug of its own
 * stays failed. `npx convex run machines:rearmFailed`
 */
export const rearmFailed = machines.internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    // Failed deliveries newest first, superseded ones included in the count,
    // so a wide look; the deploy calls this again until it rearms none.
    const failed = await machines.failedTimers(ctx, { limit: 2000 });
    for (const t of failed) await machines.rearmTimer(ctx, t);
    return failed.length;
  },
});

// History is a fact per step, kept by the component. Commands are gone a day
// after they finish (sync.ts pruneOld), so their history goes after two weeks.
// The cron, daily; a batch a run, again straight away while there's more.
export const HISTORY_KEEP_MS = 14 * 24 * 60 * 60_000;
export const pruneHistory = machines.internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const { more } = await machines.pruneHistory(ctx, { before: Date.now() - HISTORY_KEEP_MS });
    if (more) await ctx.scheduler.runAfter(0, internal.machines.pruneHistory, {});
    return null;
  },
});
