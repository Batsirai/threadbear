// A thread's CLI: none, a spare started ahead of it, starting, live, or
// closing, as one state type with every move in `moveCli`. Before 21 Nov
// 2026 this was eleven loose fields on the Runtime, written by hand at
// twenty sites in runner.ts and its parts (startSession, onExited,
// releaseSession and its finally, the output handler, update's settings
// changes, delete, letGo, shutdown, warm start), each step that waited on
// a CLI checking by hand that it was still the one it was for.
//
// The Runtime keeps those fields: readers that just want one (rt.session to
// send to it, rt.closing to wait for it, rt.tasks for the summary) stay on
// the field. `cliOf` reads them as a Cli, `cliFields` writes one back, and
// every write goes through `cliRuntime(rt, event)`, the only writer, which
// cli-session.test.ts holds the rest of runner/src to (Runner.cli calls it
// and logs what it says). It lives in memory only: nothing here is stored,
// sent or handed over (a handover lets the CLI go first, letGo).
//
// The states, by the fields (docs/protocol/updates.md, "A thread's CLI",
// draws them):
//
//   none      no CLI. The next message starts one (deliver, startSession).
//   spare     no CLI of its own yet, but the one warm start began for it,
//             claimed when threads.create made it (runner/warm-start.ts):
//             its first start takes it if it still fits, else stops it.
//   starting  a CLI started (session set) that hasn't said its version yet:
//             a failed start is reported to E's CLI updates from here.
//   live      it has (Claude says it in its init, Codex and ACP at spawn).
//   closing   asked to go (releaseSession): `done` settles once it has; a
//             turn waits for it before starting another, so there are never
//             two CLIs on one session. Its session stays until it exits.
//
// What every state carries (`marks`): the generation, which goes up at each
// start and at each drop and never down, so anything a CLI reports after it
// stopped being this thread's goes nowhere; whether the latest start resumed
// and has said its version; whether a fresh start has been tried since a
// session last said it was there (retriedFresh, across CLIs); whether this
// generation's exit was asked for (released, releasedGen === generation: an
// older releasedGen means nothing, as every reader checks the generation
// first, so it reads and writes as none); and the two reasons to leave once
// idle, `leave` (releaseWhenIdle: another login, folder or setting, /clear, a
// token, Plan's grants, a snooze or archive) and `versionMove` (a CLI update).
// Both only mean something on a starting or live CLI; elsewhere they are
// kept as the old writes left them (no reader looks: every one checks
// rt.session first, and the next start clears them).
//
// Events, where they come from, and how each moves (any state not named
// keeps its kind; ! marks a move the code never makes, kept as the old
// writes did and logged by Runner.cli as unexpected):
//
//   event       from                               none     spare    starting  live      closing
//   claim       threads.create took the spare      spare    spare!   +stray!   +stray!   +stray!
//   spareGone   the claim's timer: never started   -        none     -         -         -
//   begin       startSession, first: gen up,       none     spare    starting! live!     closing!
//               resumed, started/leave/versionMove off
//   takeSpare   startSession: taken or stopped     none     none     -         -         -
//   spawned     startSession: the CLI is running   starting starting! starting! starting! closing!
//   init *      its session output: there          retriedFresh off, in every state
//   version *   its cliVersion output              live     live     live      live      closing
//   tasks *     its background work list           (tasks, in every state)
//   exited *    its exit (onExited)                none!    spare!   none      none      closing (session gone)
//   retryFresh  onExited, resuming once            (retriedFresh on)
//   leave       a setting it can't take, etc.      (leave on, in every state; *
//               when it's a refusal that came back)
//   stay        a message or review answer brings  (leave off, in every state)
//               a put-away thread back
//   versionMove releaseIdle: a CLI update          !        !        (on or off)         !
//   release     releaseSession                     leave off          closing   closing   - (leave off if exited)
//   closed      that release's end settled         !        !        !         !         none (or live! if another came)
//   drop        delete (forgets the session),      (gen up; delete: starting/live → none)
//               letGo, shutdown
//   stopTasks   shutdown, once the work is noted   (tasks emptied)
//
//   * carries the generation it is for: one for an older CLI is refused
//     ('stale') and changes nothing, in this one place. The output events
//     land in none too while a spare's held output replays as it's taken,
//     between begin and spawned, which is why they're not marked there.
//   +stray: kept beside the CLI as found (`marks.stray`), until takeSpare
//   or spareGone clears it.
//
// What the code keeps true, which cli-session.test.ts's walks check:
// at most one CLI per thread (spawned only from none or spare, and a turn
// waits out closing before it starts one); the generation never goes
// down; nothing from an older generation moves the state; release never
// leaves the background work it stopped on the books.
//
// What isn't an event: the CLI's output a turn reads (text, tool calls,
// approvals), which the generation filters in startSession's sink before
// it gets here; the CLI's version and start time (cliVersion,
// startVersion), the provider it runs (sessionProvider), the folder
// settings it started with (claudeSkipped, claudeHeldGrants) and where its
// transcript came from (carried), all set at start and read beside it;
// the spare the runner keeps for the next new thread (Runner.spare), which
// is no thread's until claimed; whether the thread itself is gone
// (rt.deleted, which is the thread's, not its CLI's).
import type { AgentSession, BackgroundTask } from './adapters/types.ts';
import type { Spare } from './runner/warm-start.ts';

// What the fields are on a Runtime (runner.ts), less everything else.
export type CliFields = {
  session?: AgentSession;
  spare?: Spare;
  generation: number;
  closing?: Promise<void>;
  releasedGen?: number;
  resumed: boolean;
  retriedFresh: boolean;
  started?: boolean;
  releaseWhenIdle: boolean;
  versionMove?: boolean;
  tasks: BackgroundTask[];
};

export const CLI_FIELDS = [
  'session', 'spare', 'generation', 'closing', 'releasedGen', 'resumed', 'retriedFresh', 'started', 'releaseWhenIdle', 'versionMove', 'tasks',
] as const satisfies readonly (keyof CliFields)[];
export type CliField = (typeof CLI_FIELDS)[number];

export type CliMarks = {
  gen: number;
  resumed: boolean;
  retriedFresh: boolean;
  started?: true;
  released?: true;
  leave?: true;
  versionMove?: true;
  // A spare kept beside a CLI it should have made way for (never written).
  stray?: Spare;
};

type Common = { tasks: BackgroundTask[]; marks: CliMarks };

export type Cli =
  | ({ kind: 'none' } & Common)
  | ({ kind: 'spare'; spare: Spare } & Common)
  | ({ kind: 'starting'; session: AgentSession } & Common)
  | ({ kind: 'live'; session: AgentSession } & Common)
  // session: until it exits (onExited), or its release settles.
  | ({ kind: 'closing'; session?: AgentSession; done: Promise<void> } & Common);

export type CliEvent =
  | { kind: 'claim'; spare: Spare }
  | { kind: 'spareGone'; spare: Spare }
  | { kind: 'begin'; resume: boolean }
  | { kind: 'takeSpare' }
  | { kind: 'spawned'; session: AgentSession }
  | { kind: 'init'; gen: number }
  | { kind: 'version'; gen: number; atWanted: boolean }
  | { kind: 'tasks'; gen: number; tasks: BackgroundTask[] }
  | { kind: 'exited'; gen: number }
  | { kind: 'retryFresh' }
  // `gen`: from a step that waited on the CLI (a setting it refused), the
  // generation it was asked of: a later CLI started with the setting.
  | { kind: 'leave'; gen?: number }
  | { kind: 'stay' }
  | { kind: 'versionMove'; move: boolean }
  // `done`: settles once the CLI has gone (the runner settles it after closed).
  | { kind: 'release'; done: Promise<void> }
  | { kind: 'closed'; session: AgentSession }
  | { kind: 'drop'; forget: boolean }
  // Shutdown: the background work goes with the CLIs (apart from drop, as
  // the note about it reads the list first).
  | { kind: 'stopTasks' };

// What a move hands back for the runner to act on.
export type CliOut = {
  // begin: the new generation, for the sink.
  gen?: number;
  // takeSpare: the spare it took off the thread.
  spare?: Spare;
  // version: the first time this CLI said it.
  first?: boolean;
  // exited: whether its exit was asked for, and whether it had said its version.
  released?: boolean;
  started?: boolean;
  // release: the CLI to end, and the background work stopped with it.
  end?: { session: AgentSession; hard: boolean; stopped: BackgroundTask[] };
  // drop with forget: the CLI to stop.
  forgot?: AgentSession;
};

export type CliMove = { ok: true; state: Cli; out: CliOut; unexpected?: string } | { ok: false; reason: string };

export const STALE = 'stale';

// ---- Reading and writing the fields ----

export function cliOf(rt: CliFields): Cli {
  const marks: CliMarks = {
    gen: rt.generation,
    resumed: rt.resumed,
    retriedFresh: rt.retriedFresh,
    ...(rt.started ? { started: true as const } : {}),
    ...(rt.releasedGen !== undefined && rt.releasedGen === rt.generation ? { released: true as const } : {}),
    ...(rt.releaseWhenIdle ? { leave: true as const } : {}),
    ...(rt.versionMove ? { versionMove: true as const } : {}),
  };
  const tasks = rt.tasks;
  if (rt.closing) return { kind: 'closing', ...(rt.session ? { session: rt.session } : {}), done: rt.closing, tasks, marks: withStray(marks, rt.spare) };
  if (rt.session) return { kind: rt.started ? 'live' : 'starting', session: rt.session, tasks, marks: withStray(marks, rt.spare) };
  if (rt.spare) return { kind: 'spare', spare: rt.spare, tasks, marks };
  return { kind: 'none', tasks, marks };
}

export function cliFields(s: Cli): { [K in CliField]: CliFields[K] | undefined } {
  const m = s.marks;
  return {
    session: s.kind === 'starting' || s.kind === 'live' || s.kind === 'closing' ? s.session : undefined,
    spare: s.kind === 'spare' ? s.spare : m.stray,
    generation: m.gen,
    closing: s.kind === 'closing' ? s.done : undefined,
    releasedGen: m.released ? m.gen : undefined,
    resumed: m.resumed,
    retriedFresh: m.retriedFresh,
    started: m.started,
    releaseWhenIdle: Boolean(m.leave),
    versionMove: m.versionMove,
    tasks: s.tasks,
  };
}

// ---- Moves ----

export function moveCli(s: Cli, e: CliEvent): CliMove {
  const m = s.marks;
  switch (e.kind) {
    case 'claim':
      if (s.kind === 'none') return ok({ kind: 'spare', spare: e.spare, tasks: s.tasks, marks: m });
      if (s.kind === 'spare') return ok({ ...s, spare: e.spare }, {}, 'a second spare claimed for one thread');
      return ok({ ...s, marks: { ...m, stray: e.spare } }, {}, `a spare claimed for a thread with a CLI (${s.kind})`);
    case 'spareGone':
      if (s.kind === 'spare' && s.spare === e.spare) return ok({ kind: 'none', tasks: s.tasks, marks: m });
      if (m.stray === e.spare) return ok({ ...s, marks: without(m, 'stray') });
      return ok(s);
    case 'begin': {
      const gen = m.gen + 1;
      const marks: CliMarks = { ...without(m, 'started', 'released', 'leave', 'versionMove'), gen, resumed: e.resume };
      return ok({ ...s, marks }, { gen }, s.kind === 'none' || s.kind === 'spare' ? undefined : `a CLI started while one was ${s.kind}`);
    }
    case 'takeSpare':
      if (s.kind === 'spare') return ok({ kind: 'none', tasks: s.tasks, marks: m }, { spare: s.spare });
      if (m.stray) return ok({ ...s, marks: without(m, 'stray') }, { spare: m.stray });
      return ok(s);
    case 'spawned': {
      const why = s.kind === 'spare' ? 'a CLI started beside its spare' : s.kind === 'none' ? undefined : `a second CLI started while one was ${s.kind}`;
      const marks = s.kind === 'spare' ? { ...m, stray: s.spare } : m;
      if (s.kind === 'closing') return ok({ ...s, session: e.session }, {}, why);
      return ok({ kind: m.started ? 'live' : 'starting', session: e.session, tasks: s.tasks, marks }, {}, why);
    }
    case 'init':
      if (e.gen !== m.gen) return no(STALE);
      return ok({ ...s, marks: { ...m, retriedFresh: false } });
    case 'version': {
      if (e.gen !== m.gen) return no(STALE);
      const marks: CliMarks = { ...(e.atWanted ? without(m, 'versionMove') : m), started: true };
      const next: Cli = s.kind === 'starting' ? { kind: 'live', session: s.session, tasks: s.tasks, marks } : { ...s, marks };
      return ok(next, { first: !m.started });
    }
    case 'tasks':
      if (e.gen !== m.gen) return no(STALE);
      return ok({ ...s, tasks: e.tasks });
    case 'exited': {
      if (e.gen !== m.gen) return no(STALE);
      const out: CliOut = { released: Boolean(m.released), started: Boolean(m.started) };
      const marks = without(m, 'released');
      const tasks = s.tasks.length ? [] : s.tasks;
      const why = s.kind === 'none' || s.kind === 'spare' ? 'an exit heard after its release had settled' : undefined;
      if (s.kind === 'closing') return ok({ kind: 'closing', done: s.done, tasks, marks }, out);
      if (s.kind === 'spare') return ok({ ...s, tasks, marks }, out, why);
      return ok(gone(tasks, marks), out, why);
    }
    case 'retryFresh':
      return ok({ ...s, marks: { ...m, retriedFresh: true } });
    case 'leave':
      if (e.gen !== undefined && e.gen !== m.gen) return no(STALE);
      return ok({ ...s, marks: { ...m, leave: true } });
    case 'stay':
      return ok({ ...s, marks: without(m, 'leave') });
    case 'versionMove': {
      const marks = e.move ? { ...m, versionMove: true as const } : without(m, 'versionMove');
      return ok({ ...s, marks }, {}, s.kind === 'starting' || s.kind === 'live' ? undefined : `a version move for a CLI ${s.kind}`);
    }
    case 'release':
      if (s.kind === 'none' || s.kind === 'spare') return ok({ ...s, marks: without(m, 'leave') });
      if (s.kind === 'closing') return s.session ? ok(s) : ok({ ...s, marks: without(m, 'leave') });
      return ok(
        { kind: 'closing', session: s.session, done: e.done, tasks: s.tasks.length ? [] : s.tasks, marks: { ...without(m, 'leave'), released: true } },
        { end: { session: s.session, hard: s.tasks.length > 0, stopped: s.tasks } },
      );
    case 'closed': {
      const why = s.kind === 'closing' ? undefined : `a release settled with the CLI ${s.kind}`;
      if (s.kind === 'spare' || s.kind === 'none') return ok(s, {}, why);
      const session = s.session === e.session ? undefined : s.session;
      if (!session) return ok(gone(s.tasks, m), {}, why);
      return ok({ kind: m.started ? 'live' : 'starting', session, tasks: s.tasks, marks: m }, {}, why ?? 'a release settled with another CLI started');
    }
    case 'drop': {
      const marks: CliMarks = { ...without(m, 'released'), gen: m.gen + 1 };
      if (!e.forget || s.kind === 'none' || s.kind === 'spare') return ok({ ...s, marks });
      if (s.kind === 'closing') return ok({ kind: 'closing', done: s.done, tasks: s.tasks, marks }, s.session ? { forgot: s.session } : {});
      return ok(gone(s.tasks, marks), { forgot: s.session });
    }
    case 'stopTasks':
      return ok(s.tasks.length ? { ...s, tasks: [] } : s);
    default:
      return unreachable(e);
  }
}

// The only writer of the fields: moves, then writes back those that changed.
export function cliRuntime(rt: CliFields, e: CliEvent): CliMove {
  const res = moveCli(cliOf(rt), e);
  if (!res.ok) return res;
  const fields = cliFields(res.state);
  const out = rt as Record<string, unknown>;
  for (const k of CLI_FIELDS) {
    const v = fields[k];
    if (v === undefined) {
      if (k in out && out[k] !== undefined) delete out[k];
    } else if (out[k] !== v) out[k] = v;
  }
  return res;
}

// ---- Helpers ----

// No CLI any more: a spare kept beside it comes back as the state.
function gone(tasks: BackgroundTask[], marks: CliMarks): Cli {
  if (marks.stray) return { kind: 'spare', spare: marks.stray, tasks, marks: without(marks, 'stray') };
  return { kind: 'none', tasks, marks };
}

function withStray(marks: CliMarks, spare: Spare | undefined): CliMarks {
  return spare ? { ...marks, stray: spare } : marks;
}

function without<K extends keyof CliMarks>(marks: CliMarks, ...keys: K[]): CliMarks {
  if (!keys.some((k) => k in marks)) return marks;
  const out = { ...marks };
  for (const k of keys) delete out[k];
  return out;
}

function ok(state: Cli, out: CliOut = {}, unexpected?: string): CliMove {
  return unexpected ? { ok: true, state, out, unexpected } : { ok: true, state, out };
}

function no(reason: string): CliMove {
  return { ok: false, reason };
}

function unreachable(x: never): never {
  throw new Error(`Unknown CLI event: ${JSON.stringify(x)}`);
}
