// A virtual runner's box as its state machine holds it (convex/boxMachine.ts,
// docs/virtual-runners.md, docs/lifecycles.md): one member per state, each
// with only its own data. Every deadline is a time in the state's data, so
// its timer is armed for that time.
import { v, type Infer } from 'convex/values';

// A box that hasn't traded its boot token for its key by then never will:
// the token lasts as long (decision 5).
export const BOOT_MS = 10 * 60_000;
// A box that's awake but hasn't heartbeated for this long is lost (decision 12).
export const LEASE_MS = 5 * 60_000;
// A box asked to save that hasn't said it has by then stays up, and is asked again later.
export const SAVE_MS = 10 * 60_000;

export const boxStateV = v.union(
  // The service is asking the provider for the thread's first box.
  // `bootBy`: when it fails if no box has traded its boot token by then.
  v.object({ kind: v.literal('creating'), bootBy: v.number() }),
  // The provider has the box (providerBoxId on the row); it's booting and
  // will trade its boot token for its key.
  v.object({ kind: v.literal('starting'), bootBy: v.number() }),
  // Its runner is up, on its box key. `since`: when it woke, for the day's
  // awake time. `leaseUntil`: when it's lost unless it has heartbeated.
  v.object({ kind: v.literal('awake'), since: v.number(), leaseUntil: v.number() }),
  // Asked to save the thread out of the box before it sleeps (decision 7).
  // `saveBy`: when it stays awake again if no save came.
  v.object({ kind: v.literal('saving'), since: v.number(), leaseUntil: v.number(), saveBy: v.number() }),
  // Saved and slept: the box is paused if the provider can, else deleted.
  v.object({ kind: v.literal('asleep'), since: v.number() }),
  // Coming back for a message: the paused box resumed, or a new one
  // restored from the last save.
  v.object({ kind: v.literal('waking'), bootBy: v.number() }),
  // Archived: the provider is deleting the box.
  v.object({ kind: v.literal('destroying'), since: v.number() }),
  // Its box is deleted. The row stays for its save until deleteAfterDays.
  v.object({ kind: v.literal('gone'), at: v.number() }),
  // A box couldn't be started or brought back. The thread and its save are
  // kept; the next message tries again.
  v.object({ kind: v.literal('failed'), at: v.number(), error: v.string() }),
);
export type BoxState = Infer<typeof boxStateV>;
