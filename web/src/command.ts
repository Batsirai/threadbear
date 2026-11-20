// One command the website sends a runner (a message, an answer, Allow or
// Deny, Pause, Run now, Share), from the click to its runner saying how it
// went, as one state machine: every move is in `step`, and useCommand
// (use-command.tsx) only feeds it events. The part with no React or Convex
// in it, so it can be tested alone: node --test web/src/command.test.ts
//
// idle ──send──▶ sending ──queued──▶ waiting ──report done──▶ done
//                  │                   │ └──report failed──▶ failed
//                  └──queueFailed──▶ failed
// sending and waiting go slow when nothing is heard in COMMAND_SLOW_MS,
// still listening; slow, done and failed are dismissed back to idle.
//
// The backend says pending, taken, done or failed (phone:command); a taken
// command that lapses (convex/commandMachine.ts) reads as failed.

// The runner takes a command within a second or two while it's online, so
// longer means it's asleep, offline or stuck: stop spinning and say so.
export const COMMAND_SLOW_MS = 20_000;

// What phone:command reports.
export type CommandReport = { state: 'pending' | 'taken' | 'done' | 'failed'; note?: string; threadId?: string };

// attempt counts sends, so an answer to a send that was given up on can't
// move a later one. payload is what was sent, for putting back on failure.
export type CommandState<P> =
  | { kind: 'idle'; attempt: number }
  | { kind: 'sending'; attempt: number; since: number; payload: P }
  | { kind: 'waiting'; attempt: number; id: string; since: number; taken: boolean; threadId?: string; payload: P }
  | { kind: 'slow'; attempt: number; id?: string; taken: boolean; threadId?: string; payload: P }
  | { kind: 'done'; attempt: number; id: string; threadId?: string; payload: P }
  | { kind: 'failed'; attempt: number; id?: string; error: string; payload: P };

export type CommandEvent<P> =
  // A press. `again`: the composer may send its next message once the last
  // is queued (waiting or slow with an id); a button never may.
  | { kind: 'send'; payload: P; at: number; again?: boolean }
  // The mutation answered with the command's id, or threw.
  | { kind: 'queued'; attempt: number; id: string; at: number }
  | { kind: 'queueFailed'; attempt: number; error: string }
  // phone:command's latest answer for a command.
  | { kind: 'report'; id: string; report: CommandReport; at: number }
  // The clock, for going slow.
  | { kind: 'tick'; at: number }
  | { kind: 'dismiss' };

export function idle<P>(): CommandState<P> {
  return { kind: 'idle', attempt: 0 };
}

// While the control stops taking clicks.
export function locked(s: CommandState<unknown>): boolean {
  return s.kind === 'sending' || s.kind === 'waiting' || s.kind === 'slow';
}

// While the send itself hasn't reached the backend: a composer keeps its
// text, and can't send again, until it has.
export function unqueued(s: CommandState<unknown>): boolean {
  return s.kind === 'sending' || (s.kind === 'slow' && !s.id);
}

// The one place a command moves. An event that doesn't apply where it is
// returns the same object, so a caller can tell nothing changed.
export function step<P>(s: CommandState<P>, e: CommandEvent<P>): CommandState<P> {
  switch (e.kind) {
    case 'send': {
      const free = s.kind === 'idle' || s.kind === 'done' || s.kind === 'failed' || (e.again === true && (s.kind === 'waiting' || s.kind === 'slow') && !!s.id);
      return free ? { kind: 'sending', attempt: s.attempt + 1, since: e.at, payload: e.payload } : s;
    }
    case 'queued':
      if (e.attempt !== s.attempt || !unqueued(s)) return s;
      return { kind: 'waiting', attempt: s.attempt, id: e.id, since: e.at, taken: false, payload: (s as { payload: P }).payload };
    case 'queueFailed':
      if (e.attempt !== s.attempt || !unqueued(s)) return s;
      return { kind: 'failed', attempt: s.attempt, error: e.error, payload: (s as { payload: P }).payload };
    case 'report': {
      if ((s.kind !== 'waiting' && s.kind !== 'slow') || s.id !== e.id) return s;
      const { report } = e;
      const threadId = report.threadId ?? s.threadId;
      if (report.state === 'done') return { kind: 'done', attempt: s.attempt, id: e.id, ...(threadId ? { threadId } : {}), payload: s.payload };
      if (report.state === 'failed') return { kind: 'failed', attempt: s.attempt, id: e.id, error: report.note ?? 'unknown error', payload: s.payload };
      const taken = report.state === 'taken';
      // Taken is news: the runner is awake, so the clock starts again.
      if (taken && !s.taken) return { kind: 'waiting', attempt: s.attempt, id: e.id, since: e.at, taken, ...(threadId ? { threadId } : {}), payload: s.payload };
      if (threadId !== s.threadId) return { ...s, threadId };
      return s;
    }
    case 'tick': {
      if ((s.kind !== 'sending' && s.kind !== 'waiting') || e.at - s.since < COMMAND_SLOW_MS) return s;
      if (s.kind === 'sending') return { kind: 'slow', attempt: s.attempt, taken: false, payload: s.payload };
      return { kind: 'slow', attempt: s.attempt, id: s.id, taken: s.taken, ...(s.threadId ? { threadId: s.threadId } : {}), payload: s.payload };
    }
    case 'dismiss':
      return s.kind === 'slow' || s.kind === 'done' || s.kind === 'failed' ? { kind: 'idle', attempt: s.attempt } : s;
  }
}

// When the clock should next look, or undefined when nothing is timing.
export function slowAt(s: CommandState<unknown>): number | undefined {
  return s.kind === 'sending' || s.kind === 'waiting' ? s.since + COMMAND_SLOW_MS : undefined;
}

// The line shown near the control, or null for nothing to say.
export function commandNote(s: CommandState<unknown>): { tone: 'muted' | 'failed'; text: string; dismiss: boolean } | null {
  switch (s.kind) {
    case 'waiting':
      return { tone: 'muted', text: s.taken ? 'Sent to the Mac…' : 'Waiting for the Mac to pick this up…', dismiss: false };
    case 'slow':
      return {
        tone: 'muted',
        text: !s.id ? 'Still trying to reach Threadbear’s server. Check this device is online.' : s.taken ? 'The Mac has this but hasn’t said how it went yet.' : 'The Mac hasn’t picked this up. It may be asleep or offline; it runs when the Mac is back.',
        dismiss: true,
      };
    case 'failed':
      return { tone: 'failed', text: `Didn’t work: ${s.error}`, dismiss: true };
    default:
      return null;
  }
}

// A thrown mutation's words: a ConvexError's message, else the Error's.
export function errorText(e: unknown): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === 'string' && data) return data;
  const m = (data as { message?: unknown } | undefined)?.message;
  if (typeof m === 'string' && m) return m;
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}
