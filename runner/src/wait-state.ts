// What a thread is waiting on: one state per thread, worked out here and sent
// on its summary (`waitState`), so every app draws the same section, badge and
// card instead of each working it out from a dozen fields
// (docs/protocol/threads.md, "Wait state"). Before this the rule was written
// by hand in the runner, the Mac, the iPhone, Android and the website, and
// each new thing a thread could wait on (a job, other threads, landing, an
// app restart) reached only the Mac (the 22 Nov weekly step back).
//
// The states and the moves between them are listed once, below. A thread's
// state is derived from its record, never stored, so a move the table
// doesn't allow isn't refused: the runner logs it (`checkMove`), and a test
// keeps the table and the rule in step.

export type WaitState =
  | 'working'
  | 'job'
  | 'onThreads'
  | 'landing'
  | 'appRestart'
  | 'sending'
  | 'card'
  | 'review'
  | 'needsYou'
  | 'limit'
  | 'done'
  | 'scheduled'
  | 'hibernating'
  | 'archived';

export type Section = 'inbox' | 'running' | 'hibernating' | 'archived';

type StateInfo = { section: Section; description: string };

export const WAIT_STATES: Record<WaitState, StateInfo> = {
  working: { section: 'running', description: 'A turn is running or starting.' },
  job: { section: 'running', description: 'No turn, but a background job (a shell job, sub-agent or workflow) is still going, and the last turn asks nothing of Mike that it is not still waiting on.' },
  onThreads: { section: 'running', description: "Its own agent put it away to hear back from other threads (end_turn's waitFor) that haven't finished yet." },
  landing: { section: 'running', description: "Its own agent put it away until something it watches for (a landing, CI going green) while its commits aren't on main yet." },
  appRestart: { section: 'running', description: "Its own agent put it away until Mike's app restarts onto what it landed (wait_for_app_restart)." },
  sending: { section: 'running', description: "An app's own guess while a message Mike sent is on its way and the runner hasn't started the turn. The runner never sends it." },
  card: { section: 'inbox', description: 'Its turn is stuck on a card only Mike can answer (a permission, a question, ask_secret). It runs out, so it goes first in every order.' },
  review: { section: 'inbox', description: 'The turn is over and a design review (show_options) waits on his pick.' },
  needsYou: { section: 'inbox', description: "The last turn asked Mike for something he hasn't done yet, or ended without saying and he hasn't read it, or it's marked unread." },
  limit: { section: 'inbox', description: "Its login ran out of usage; it carries on by itself when the limit resets." },
  done: { section: 'inbox', description: 'Finished with nothing for Mike (said nothing, or read). Follow-ups and open loose ends keep it here; the inbox guess may one day send it straight to Archived.' },
  scheduled: { section: 'hibernating', description: 'Idle with nothing for Mike, and a schedule will message it.' },
  hibernating: { section: 'hibernating', description: 'Put away until a time, the runner restarting, a release, or something in words, by Mike or by its agent, and not waiting on its own work.' },
  archived: { section: 'archived', description: 'Archived, by Mike (or one day the inbox guess). Any message brings it back.' },
};

// Where each move comes from, as the runner or an app sees it happen.
type Move = { from: WaitState[] | '*'; to: WaitState; on: string };

const IDLE: WaitState[] = ['needsYou', 'done', 'limit', 'scheduled', 'hibernating', 'review', 'job', 'onThreads', 'landing', 'appRestart'];
const PUT_AWAY: WaitState[] = ['onThreads', 'landing', 'appRestart', 'hibernating'];

export const WAIT_MOVES: Move[] = [
  { from: [...IDLE, 'card'], to: 'sending', on: 'Mike sends a message (an app guesses this until the runner says otherwise)' },
  { from: [...IDLE, 'sending', 'card'], to: 'working', on: 'a turn starts: a message, a schedule firing, a job finishing, a wake, the limit resetting' },
  { from: ['working'], to: 'card', on: 'the turn asks a permission or question, or ask_secret' },
  { from: ['card'], to: 'working', on: 'Mike answers the card' },
  { from: ['working', 'card'], to: 'needsYou', on: 'the turn ends asking Mike for something, or ends without saying' },
  { from: ['working', 'card'], to: 'done', on: 'the turn ends with needs "nothing", or fails or is stopped' },
  { from: ['working'], to: 'review', on: 'the turn ends with a design review waiting' },
  { from: ['working'], to: 'job', on: 'the turn ends with a background job still going' },
  { from: ['working'], to: 'limit', on: 'the turn hits its login\'s usage limit' },
  { from: ['working', 'job'], to: 'onThreads', on: 'end_turn waits for other threads' },
  { from: ['working', 'job'], to: 'landing', on: 'end_turn hibernates until something it watches for, with commits not on main' },
  { from: ['working', 'job'], to: 'appRestart', on: 'end_turn waits for the app to restart onto what it landed' },
  { from: ['working', 'job', 'needsYou', 'done', 'review', 'limit', 'scheduled'], to: 'hibernating', on: 'Mike or its agent hibernates it' },
  { from: ['working', 'job', 'done'], to: 'scheduled', on: 'a schedule is booked to message it' },
  { from: ['job'], to: 'needsYou', on: 'the job ends and its card asks Mike for something' },
  { from: ['job'], to: 'done', on: 'the job ends with nothing for Mike' },
  { from: ['needsYou'], to: 'done', on: 'Mike reads it, or ticks every ask' },
  { from: ['done'], to: 'needsYou', on: 'Mike marks it unread' },
  { from: ['review'], to: 'needsYou', on: 'the review is answered' },
  { from: ['review'], to: 'done', on: 'the review is answered or dismissed' },
  { from: ['scheduled'], to: 'done', on: 'the schedule is paused, finished or deleted' },
  { from: ['landing'], to: 'hibernating', on: 'its commits reach main and it stays asleep until its wake' },
  { from: PUT_AWAY, to: 'needsYou', on: 'it wakes by itself (marked unread) or the snooze ends' },
  { from: PUT_AWAY, to: 'done', on: 'Mike wakes it and it has nothing for him' },
  { from: ['onThreads', 'appRestart', 'hibernating'], to: 'card', on: 'a card stays open while it hibernates and then wakes' },
  // The inbox guess (runner/src/experiments/inboxGuess.md): if Mike lets its
  // "didn't need to see this" verdict act, a done thread with no follow-ups
  // and no open loose ends goes straight here. `autoArchive` below is the one
  // place to change.
  { from: '*', to: 'archived', on: 'Mike archives it, or the inbox guess does (not yet)' },
  { from: ['archived'], to: 'needsYou', on: 'Mike unarchives it' },
  { from: ['archived'], to: 'done', on: 'Mike unarchives it' },
  { from: ['archived'], to: 'working', on: 'a message unarchives it' },
  { from: ['archived'], to: 'hibernating', on: 'unarchived while still hibernating' },
  { from: ['archived'], to: 'scheduled', on: 'unarchived with a schedule booked' },
];

export function allowed(from: WaitState, to: WaitState): boolean {
  if (from === to) return true;
  return WAIT_MOVES.some((m) => m.to === to && (m.from === '*' || m.from.includes(from)));
}

// What the state is worked out from: the summary's own fields, and whether a
// schedule will message the thread by itself.
export type WaitInputs = {
  status: string;
  needsYou: boolean;
  needs?: 'you' | 'nothing';
  asks?: { ticked?: boolean }[];
  pendingReviews?: number;
  background?: { kind: string }[];
  snoozedUntil?: string;
  snoozedUntilRestart?: boolean;
  wakeWhen?: { topic?: string; agent?: true };
  waitingOn?: { done?: true }[];
  awaitingAppRestart?: true;
  looseEnds?: { ends: { kind: string }[] };
  waitingForRoom?: unknown;
  archivedAt?: string;
};

// The rule, in order: the first that holds is the state. It is the Mac's
// `section_of` (desktop/core/src/inbox.rs) as of 23 Nov, moved here.
export function waitStateOf(t: WaitInputs, opts: { now: number; scheduled: boolean }): WaitState {
  if (t.archivedAt) return 'archived';
  const snoozed = Boolean(t.snoozedUntilRestart) || (t.snoozedUntil !== undefined && Date.parse(t.snoozedUntil) > opts.now);
  if (snoozed) {
    if (t.waitingOn?.some((w) => !w.done)) return 'onThreads';
    if (t.awaitingAppRestart) return 'appRestart';
    if (waitingToLand(t)) return 'landing';
    return 'hibernating';
  }
  const turn = t.status === 'running' || t.status === 'starting';
  const busy = turn || t.status === 'waiting';
  const background = Boolean(t.background?.length);
  if (t.status === 'waiting') return 'card';
  if ((t.pendingReviews ?? 0) > 0 && !busy && !background) return 'review';
  if (waitingOnMike(t, busy) || (t.needsYou && !(background && !busy))) return 'needsYou';
  if (turn) return 'working';
  if (background) return 'job';
  if (t.status === 'idle' && t.needs !== 'you' && !t.waitingForRoom && opts.scheduled) return 'scheduled';
  if (t.waitingForRoom) return 'limit';
  return 'done';
}

// The last turn asked Mike for something and he hasn't done it all. Sub-agents
// still at work hold it back, as what they find can change the ask; a shell
// job doesn't, as it's often watching for Mike to do it (needs-you.md).
function waitingOnMike(t: WaitInputs, busy: boolean): boolean {
  if (t.needs !== 'you' || busy || t.background?.some((b) => b.kind === 'agent' || b.kind === 'other')) return false;
  const asks = t.asks ?? [];
  return asks.length === 0 || asks.some((a) => a.ticked !== true);
}

// Hibernating until something its own agent watches for, while its commits
// aren't on main yet. One Mike hibernated himself isn't.
function waitingToLand(t: WaitInputs): boolean {
  return Boolean(t.wakeWhen?.agent && t.wakeWhen.topic && t.looseEnds?.ends.some((e) => e.kind === 'unlanded'));
}

// Where the guess's verdict would take a done thread straight to Archived
// (runner/src/experiments/inboxGuess.md). Today it never does: the 29 Nov
// check-in decides whether it should, and this is the one line to change.
// Follow-ups or open loose ends always keep a thread in view (Mike, 18 Nov).
export function autoArchive(_state: WaitState, _guess: { verdict?: 'skip' | 'see' }, _keepsInView: boolean): boolean {
  return false;
}

// The section a thread is drawn under: Starred above the rest for a starred
// thread that isn't archived.
export function sectionOf(state: WaitState, starred: boolean): Section | 'starred' {
  if (state !== 'archived' && starred) return 'starred';
  return WAIT_STATES[state].section;
}
