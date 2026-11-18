// A thread's box on a virtual runner as a state machine (docs/virtual-runners.md,
// decisions 3, 5, 6 and 7; docs/lifecycles.md). The main Mac starts the
// thread's box and archives it; the runner in the box says when it has traded its
// boot token for its key (boxes.ts exchange) and when it has saved the
// thread; the service's own actions and crons say what the provider did.
// Boxes authenticate with keys and boot tokens in their args, not ctx.auth,
// so each function in boxes.ts and sync.ts checks who's asking before it
// sends: the roles say who sends what, and their checks pass.
//
// A box's key (`boxKeyHash` on the row) is good while the row says so: the
// effects clear it whenever a box is replaced, archived or fails, so a lost
// box's key is refused from the step that gives up on it.
//
// Every step that needs the provider schedules the service's action for it
// (boxService.ts): a box to wake or replace (wakeBox), one to pause or
// delete once it has saved (sleepBox), and one to delete when the thread is
// archived (destroyBox), and another create for a box lost while it was
// being made (createBox). The first box's create is scheduled by boxes.ts
// addBox, as the row has no id while its START runs. Each
// action reads the row again and acts on its newest attempt only, so one
// scheduled twice, or late, does nothing more.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { BOOT_MS, LEASE_MS, SAVE_MS } from './boxStates';

type Box = Doc<'boxes'>;
const ERROR_CHARS = 500;

export const box = defineMachine(
  appSchema,
  {
    name: 'box',
    table: 'boxes',
    field: 'boxState',
    description: "A thread's box on a virtual runner: made when the thread starts, saved and slept when it's idle, woken for a message (the same box resumed, or a new one from the save), and deleted when the thread is archived. Every box that runs the thread is the same runner, each on a key of its own.",
    callers: {
      owner: "Only the main Mac's runner starts or archives a thread's box.",
      runner: "Only the runner in the thread's own box, on its boot token or key, says it's up or saved.",
    },
    events: {
      owner: { START: {}, ARCHIVE: {} },
      runner: { READY: {}, SAVED: { storageId: v.id('_storage'), bytes: v.number() } },
      // `attempt`: which box the event is about (boxes.ts mintBootToken numbers
      // each), on every event about one box. Without one, it's taken to be
      // about the newest (a loss: every box's so far). WAKE is the thread's.
      server: { CREATED: { providerBoxId: v.string(), attempt: v.optional(v.number()) }, IDLE: { attempt: v.optional(v.number()) }, WAKE: {}, RESUMED: { attempt: v.optional(v.number()) }, LOST: { attempt: v.optional(v.number()) }, DESTROYED: {}, FAILED: { error: v.string(), attempt: v.optional(v.number()) } },
    },
    guards: {
      heardFrom: "The box hasn't heartbeated within the lease.",
      resumable: "Only the box holding the thread's key resumes, and only while no newer box has been asked for: otherwise a new box has to start.",
      notStale: 'It names an older attempt at a box than the newest one this thread has: it changes nothing of the newer one.',
      newBox: 'That box has already traded its boot token, or is older than the newest: its news is only its provider id.',
    },
    states: {
      start: {
        on: { START: { to: 'creating', effect: 'start', description: 'A thread starts on a virtual runner: the service asks the provider for its first box, with a boot token and nothing reusable in its environment.' } },
      },
      creating: {
        description: "The service is asking the provider for the thread's first box.",
        timers: { BOOT_TIMEOUT: { at: 'bootBy', description: "Ten minutes have passed and no box has traded the thread's boot token for its key." } },
        on: {
          CREATED: { to: 'starting', guard: 'newBox', effect: 'created', description: 'The provider has made the box, which boots and starts its runner.' },
          READY: { to: 'awake', effect: 'ready', description: "The box booted and traded its boot token for its key before the provider's answer came back." },
          FAILED: { to: 'failed', guard: 'notStale', effect: 'fail', description: "The provider couldn't make a box." },
          LOST: { effect: 'createAgain', description: 'The provider lost the box it was making: the service makes another before the ten minutes are up.' },
          BOOT_TIMEOUT: { to: 'failed', effect: 'bootTimeout', description: 'No box checked in: the thread waits for the next message to try again.' },
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread before its box is up.' },
        },
      },
      starting: {
        description: 'The box is booting: its runner will trade the boot token for its box key, the login token and the thread key.',
        timers: { BOOT_TIMEOUT: { at: 'bootBy', description: "Ten minutes have passed since the box was asked for, and it hasn't traded its boot token." } },
        on: {
          READY: { to: 'awake', effect: 'ready', description: 'The box traded its boot token: its key is the only one for the thread from now on.' },
          CREATED: { guard: 'notStale', effect: 'created', description: "The provider's id for the booting box, or for a newer attempt's box (the last was lost or given up on), which boots in its place." },
          FAILED: { to: 'failed', guard: 'notStale', effect: 'fail', description: "The provider says the box didn't start." },
          LOST: [
            { to: 'waking', guard: 'notStale', effect: 'bootLost', description: 'The box was lost while it booted: no key or boot token of it works, and a new box is made, restoring the last save if there is one.' },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          BOOT_TIMEOUT: { to: 'failed', effect: 'bootTimeout', description: 'The box never checked in: the thread waits for the next message to try again.' },
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread while its box boots.' },
        },
      },
      awake: {
        description: "The box's runner is running the thread, on its own box key, and heartbeats every minute.",
        timers: { LEASE_DUE: { at: 'leaseUntil', description: 'Five minutes since the lease was last renewed: the box must have heartbeated meanwhile.' } },
        on: {
          LEASE_DUE: [
            { guard: 'heardFrom', effect: 'renewLease', description: 'It has heartbeated: the lease runs five minutes from its last heartbeat.' },
            { to: 'waking', effect: 'lost', description: "No heartbeat for five minutes: the box is lost. Its key is refused from now, and a new box restores the thread from its last save." },
          ],
          LOST: [
            { to: 'waking', guard: 'notStale', effect: 'lost', description: "The provider says the box is gone: its key is refused from now, and a new box restores the thread from its last save." },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          IDLE: { to: 'saving', guard: 'notStale', effect: 'askSave', description: "The thread has been idle a while (or the box has been up its day's hours): the box is asked to save the thread before it sleeps." },
          SAVED: { effect: 'saved', description: 'The box saved the thread unasked: the save replaces the last one, and it stays awake.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the box that's up, arriving late: kept, for pausing and deleting it." },
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread: its box is deleted.' },
        },
      },
      saving: {
        description: 'The box is saving the thread out of itself: committing and pushing its work, and uploading the folder and transcript sealed with the thread key.',
        timers: {
          LEASE_DUE: { at: 'leaseUntil', description: 'Five minutes since the lease was last renewed: the box must have heartbeated meanwhile.' },
          SAVE_TIMEOUT: { at: 'saveBy', description: "Ten minutes have passed and the box hasn't said it saved." },
        },
        on: {
          SAVED: { to: 'asleep', effect: 'sleep', description: 'The save is in: it replaces the last one, and the box is paused if the provider can, else deleted.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the box, arriving late: kept, for pausing and deleting it." },
          WAKE: { to: 'awake', effect: 'stayUp', description: 'A message came in while it saved: the box stays up.' },
          SAVE_TIMEOUT: { to: 'awake', effect: 'stayUp', description: "No save came: the box stays up rather than lose work, and it's asked again at the next idle check." },
          LEASE_DUE: [
            { guard: 'heardFrom', effect: 'renewLease', description: 'It has heartbeated: the lease runs five minutes from its last heartbeat.' },
            { to: 'waking', effect: 'lost', description: 'No heartbeat for five minutes: the box is lost, and a new box restores the thread from its last save.' },
          ],
          LOST: [
            { to: 'waking', guard: 'notStale', effect: 'lost', description: 'The provider says the box is gone mid-save: a new box restores the thread from its last save.' },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread: its box is deleted.' },
        },
      },
      asleep: {
        description: "The thread is saved and its box paused or deleted. Nothing is running; it costs a paused box's disk at most.",
        on: {
          WAKE: { to: 'waking', effect: 'wake', description: "A message for the thread: the paused box is resumed, or a new one restores the save. Once only: a second message while it's waking doesn't start another." },
          LOST: { effect: 'forgetBox', description: "The provider lost the paused box: its key goes with it, and as the save is still here, the next wake starts a new box." },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the paused box, arriving late: kept, for resuming and deleting it." },
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread: its box, if any, is deleted.' },
        },
      },
      waking: {
        description: 'The thread is coming back for a message: its paused box resuming, or a new box being made that restores the last save.',
        timers: { BOOT_TIMEOUT: { at: 'bootBy', description: "Ten minutes have passed and the box hasn't come back." } },
        on: {
          RESUMED: { to: 'awake', guard: 'resumable', effect: 'resumed', description: 'The paused box resumed, its runner still holding its key.' },
          CREATED: [
            { to: 'starting', guard: 'newBox', effect: 'created', description: "A new box was made: the last box's key stops working, and the new one boots, trades a fresh boot token, and restores the save." },
            { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the paused box, sent again: kept, and it can still resume." },
          ],
          LOST: { effect: 'forgetOldBox', description: "The paused box was lost before it resumed: its key stops working, and a new box restores the save instead." },
          READY: { to: 'awake', effect: 'ready', description: 'A new box traded its boot token: its key replaces the last box\'s, which is refused from now.' },
          FAILED: { to: 'failed', guard: 'notStale', effect: 'fail', description: "The provider couldn't bring a box back." },
          BOOT_TIMEOUT: { to: 'failed', effect: 'bootTimeout', description: 'No box came back: the thread waits for the next message to try again.' },
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread while it wakes.' },
        },
      },
      destroying: {
        description: "The thread is archived: the provider is deleting its box. No key works for it any more.",
        on: {
          DESTROYED: { to: 'gone', effect: 'destroyed', description: 'The provider has deleted the box.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for a box made just before the archive: kept, so it's deleted too." },
        },
      },
      gone: { description: "The box is deleted. The row stays for its save, deleted after the virtual runner's deleteAfterDays." },
      failed: {
        description: "A box couldn't be started or brought back. The thread and its last save are kept, and no key works for it.",
        on: {
          WAKE: { to: 'waking', effect: 'wake', description: 'A new message tries again with a new box.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for a box that came too late: kept, so it's found and deleted." },
          ARCHIVE: { to: 'destroying', effect: 'archive', description: 'Mike archives the thread: any box the provider still has is deleted.' },
        },
      },
    },
  },
  {
    callers: { owner: () => true, runner: () => true },
    guards: {
      heardFrom: (_ctx, { row }) => (row.lastHeartbeatAt ?? 0) > Date.now() - LEASE_MS,
      resumable: (_ctx, { row, event }) => row.boxKeyHash !== undefined && row.keyAttempt === newestAttempt(row) && (event.attempt === undefined || event.attempt === row.keyAttempt),
      notStale: (_ctx, { row, event }) => !stale(row, event.attempt),
      newBox: (_ctx, { row, event }) => !stale(row, event.attempt) && !(event.attempt !== undefined && event.attempt === row.keyAttempt),
    },
    effects: {
      start: async () => ({ kind: 'creating' as const, bootBy: Date.now() + BOOT_MS }),
      // A new box: whatever box held the key before is done with. Its own key comes at its exchange.
      created: async (ctx, { id, row, state, event }) => {
        // A key of an older attempt than this box's goes; this box's own (or a newer one's) can't be here yet.
        const olderKey = event.attempt === undefined || (row.keyAttempt ?? 0) < event.attempt;
        await patch(ctx, id, { ...(olderKey ? { boxKeyHash: undefined, keyAttempt: undefined } : {}), providerBoxId: event.providerBoxId, providerAttempt: event.attempt });
        return { kind: 'starting' as const, bootBy: state.bootBy };
      },
      noteBox: async (ctx, { id, state, event }) => {
        await patch(ctx, id, { providerBoxId: event.providerBoxId, providerAttempt: event.attempt });
        return state;
      },
      // boxes.ts claimBoot sets the new key's hash in the same mutation.
      ready: async (ctx, { id, row }) => {
        const now = Date.now();
        await patch(ctx, id, { lastHeartbeatAt: now, bootTokenHash: undefined, bootExpiresAt: undefined, bootAttempt: undefined, keyAttempt: row.bootAttempt });
        return { kind: 'awake' as const, since: now, leaseUntil: now + LEASE_MS };
      },
      // Its own key, and nobody newer asked for (resumable): there's no newer boot token to touch.
      resumed: async (ctx, { id }) => {
        const now = Date.now();
        await patch(ctx, id, { lastHeartbeatAt: now });
        return { kind: 'awake' as const, since: now, leaseUntil: now + LEASE_MS };
      },
      renewLease: async (_ctx, { state, row }) => ({ ...state, leaseUntil: (row.lastHeartbeatAt ?? Date.now()) + LEASE_MS }),
      // Through the one rule (lostBox): the lease's own lapse names no attempt, so it ends them all.
      lost: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, { ...awakeAdded(row, state.since), ...lostBox(row, attemptOf(event)) });
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS };
      },
      askSave: async (_ctx, { state }) => ({ kind: 'saving' as const, since: state.since, leaseUntil: state.leaseUntil, saveBy: Date.now() + SAVE_MS }),
      stayUp: async (_ctx, { state }) => ({ kind: 'awake' as const, since: state.since, leaseUntil: state.leaseUntil }),
      saved: async (ctx, { id, state, event }) => {
        await patch(ctx, id, { save: { storageId: event.storageId, bytes: event.bytes, at: Date.now() } });
        return state;
      },
      sleep: async (ctx, { id, row, state, event }) => {
        const now = Date.now();
        await patch(ctx, id, { ...awakeAdded(row, state.since), save: { storageId: event.storageId, bytes: event.bytes, at: now } });
        await provide(ctx, 'sleepBox', id);
        return { kind: 'asleep' as const, since: now };
      },
      wake: async (ctx, { id }) => {
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS };
      },
      bootLost: async (ctx, { id, row, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS };
      },
      // What was the lost box's (its attempt's or older), not the boot token
      // or box of a newer attempt.
      forgetOldBox: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        return state;
      },
      // Another attempt, unless a newer one is on its way (boxService.ts claimAttempt).
      createAgain: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        await provide(ctx, 'createBox', id);
        return state;
      },
      forgetBox: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        return state;
      },
      archive: async (ctx, { id, row, state }) => {
        await patch(ctx, id, { ...(state.kind === 'awake' || state.kind === 'saving' ? awakeAdded(row, state.since) : {}), ...revoked });
        await provide(ctx, 'destroyBox', id);
        return { kind: 'destroying' as const, since: Date.now() };
      },
      destroyed: async (ctx, { id }) => {
        await patch(ctx, id, { ...revoked, ...noBox });
        return { kind: 'gone' as const, at: Date.now() };
      },
      fail: async (ctx, { id, event }) => {
        await patch(ctx, id, revoked);
        return { kind: 'failed' as const, at: Date.now(), error: event.error.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, ERROR_CHARS) || 'The box failed.' };
      },
      bootTimeout: async (ctx, { id }) => {
        await patch(ctx, id, revoked);
        return { kind: 'failed' as const, at: Date.now(), error: 'No box checked in within 10 minutes.' };
      },
    },
  },
);

// No key and no boot token work for the thread after this step.
const revoked = { boxKeyHash: undefined, keyAttempt: undefined, bootTokenHash: undefined, bootExpiresAt: undefined, bootAttempt: undefined } as const;
const noBox = { providerBoxId: undefined, providerAttempt: undefined } as const;

// Attempt ordering, the one rule every event naming an attempt goes by
// (Codex's fourth review, 18 Nov 2026). Each boot token is one attempt at a
// box (boxes.ts storeBootToken numbers them); the row knows the newest it
// has minted (boxAttempt) and whose its token, key and provider box are.
// An event naming attempt N touches only what's N's or older (lostBox), and
// one naming an attempt older than the newest changes neither the state
// nor the provider box (the notStale guard). CREATED for the newest attempt
// records its provider id in any state, and only starts a box that hasn't
// traded its token yet (newBox); RESUMED is only the key holder's, while no
// newer attempt was minted (resumable). One naming none is taken to be about
// the newest (a loss: every attempt so far).
export function newestAttempt(row: Pick<Box, 'boxAttempt' | 'bootAttempt' | 'keyAttempt' | 'providerAttempt'>): number {
  return Math.max(row.boxAttempt ?? 0, row.bootAttempt ?? 0, row.keyAttempt ?? 0, row.providerAttempt ?? 0);
}
export function stale(row: Pick<Box, 'boxAttempt' | 'bootAttempt' | 'keyAttempt' | 'providerAttempt'>, attempt: number | undefined): boolean {
  return attempt !== undefined && attempt < newestAttempt(row);
}
const attemptOf = (event: unknown): number | undefined => (event as { attempt?: number }).attempt;

// What goes when attempt `attempt`'s box is lost: its key, its unused boot
// token and the provider's id for it, and any older attempt's. Without an
// attempt, all of them.
function lostBox(row: Box, attempt: number | undefined): Partial<Box> {
  const gone = (a: number | undefined) => attempt === undefined || (a ?? 0) <= attempt;
  return {
    ...(gone(row.keyAttempt) ? { boxKeyHash: undefined, keyAttempt: undefined } : {}),
    ...(gone(row.bootAttempt) ? { bootTokenHash: undefined, bootExpiresAt: undefined, bootAttempt: undefined } : {}),
    ...(gone(row.providerAttempt) ? noBox : {}),
  };
}

type Db = { db: unknown };

// The service's action for a step that needs the provider, at once.
async function provide(ctx: { scheduler: { runAfter(ms: number, fn: never, args: never): Promise<unknown> } }, action: 'createBox' | 'wakeBox' | 'sleepBox' | 'destroyBox', id: unknown): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.boxService[action] as never, { boxId: id as Id<'boxes'> } as never);
}

// The row's own fields, never its machine's: the guarded db checks that.
async function patch(ctx: Db, id: unknown, fields: Partial<Box>): Promise<void> {
  await (ctx.db as { patch(id: unknown, value: object): Promise<void> }).patch(id, fields);
}

// The awake time since `since`, added to the day's (UTC) count.
export function awakeAdded(row: Pick<Box, 'awakeToday'>, since: number, now = Date.now()): Pick<Box, 'awakeToday'> {
  const day = new Date(now).toISOString().slice(0, 10);
  const ms = Math.max(0, now - since);
  return { awakeToday: { day, ms: (row.awakeToday?.day === day ? row.awakeToday.ms : 0) + ms } };
}
