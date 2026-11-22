// Words written for a thread's agent earlier, by a thread with less access
// (or by one whose access can't be known here), that reach it later: a held
// report from a thread it started (runner/nested.ts), a reply from a thread
// it started on another runner (far-reports.ts), a schedule another thread
// set up for it (schedules.ts), a waited-on thread's closing reply
// (runner/hibernation.ts). Each carries a ceiling: the most access the
// receiving thread may have when the words reach its agent, as send_message
// would have let them reach it then. If Mike has raised it above that since,
// they aren't handed to its agent: he's shown the thread instead, with a
// note, and no turn (Daybreak findings 162, 163 and 164, 22 Nov 2026; the
// waits had this since 12 Nov).
//
// The check is made where the words are handed over (sendTo, for a message
// that starts or joins a turn now) and again as a queued one is taken off
// the queue (kickQueue), so a message that waited behind a busy turn while
// Mike raised the thread is held too. Each method's `this` is the Runner;
// runner.ts puts them on its prototype.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { PermissionMode } from '../protocol.ts';
import { isPermissionMode } from '../protocol.ts';
import type { QueuedSend } from '../store.ts';
import { above, raises, type Authority } from '../threadbear-mcp.ts';

// A ceiling as saved: one that isn't a mode (a record from before, a moved
// thread's record from another Mac) counts as the least, Ask.
export function ceilingMode(v: unknown): PermissionMode {
  return isPermissionMode(v) ? (v === 'plan' ? 'ask' : v) : 'ask';
}

// The more of two modes.
export function higherMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return raises(a, b) ? a : b;
}

// The less of two modes.
export function lowerMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return raises(a, b) ? b : a;
}

export const ceilingPart = {
  // Whether words with this ceiling may go to the agent of a thread with
  // access `me`: it has no more than the ceiling, or (`from`, a thread on
  // this runner that wrote them) the writer has as much as it has now, as
  // send_message goes by (mayTellOf). Without a ceiling, only the second.
  mayPassOn(this: Runner, me: Authority, ceiling: PermissionMode | undefined, from?: string): boolean {
    if (from && this.mayTellOf(me, from)) return true;
    return ceiling !== undefined && !above(me, { mode: ceilingMode(ceiling) });
  },

  // Whether a message with this ceiling may reach `st`'s agent now. One
  // with none isn't held to one (Mike's, a thread's own, the runner's).
  underCeiling(this: Runner, st: ThreadState, ceiling: unknown): boolean {
    if (ceiling === undefined) return true;
    return !above(this.authorityNow(st.rec.id), { mode: ceilingMode(ceiling) });
  },

  // Shown to Mike instead of its agent: a note saying what wasn't passed on
  // and where to read it, and the thread in Needs you (woken, if it was
  // hibernating). No turn: he reads it, and a message from him carries on.
  withhold(this: Runner, st: ThreadState, why: string, note: string): void {
    if (st.rec.snoozedUntil && !st.rec.archivedAt) {
      this.wake(st, { why });
      this.armSnoozeTimer();
    } else {
      st.rec.forceUnread = true;
      st.rec.updatedAt = this.isoNow();
      this.markDirty(st);
    }
    this.emit(st, { type: 'system.note', text: note });
    this.log.info('held back words from a thread with less access than this one has now', { threadId: st.rec.id, why });
  },

  // A schedule's run held by its ceiling (schedules.ts, "Ceilings"): the
  // thread it was for is shown to Mike with a note, as the schedule pauses.
  scheduleHeld(this: Runner, threadId: string, title: string, note: string): void {
    const st = this.threads.get(threadId);
    if (!st || st.rt.deleted) return;
    this.withhold(st, `the schedule "${title}" came due`, `The schedule "${title}" wasn't sent to this thread's agent. ${note}`);
  },

  // A message about to be handed to `st`'s agent whose ceiling it's above
  // now: held back, with a note saying what it was.
  withholdMessage(this: Runner, st: ThreadState, q: Pick<QueuedSend, 'text' | 'origin' | 'scheduleId'>): void {
    const first = q.text.slice(0, q.text.indexOf('\n') < 0 ? q.text.length : q.text.indexOf('\n')).trim().slice(0, 200);
    const what = q.origin === 'schedule' ? `A scheduled message (${first})` : first ? `A message (${first})` : 'A message';
    this.withhold(
      st,
      'a message came for it from a thread with less access',
      `${what} wasn't passed to this thread's agent: it was written by a thread with less access than this one has now (it was raised since). Read it where it came from, and send a message here to carry on.`,
    );
  },
};

export type CeilingPart = RunnerPart<typeof ceilingPart>;
