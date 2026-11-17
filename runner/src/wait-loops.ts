// Background wait loops, caught as the agent starts one (docs/protocol.md,
// "Background wait loops"). An agent waiting on something outside its turn
// (a merge to land, CI, another thread, a time) tends to start a background
// shell that sleeps until it's there, then end its turn. The CLI wakes it
// when the shell exits, so it works, but the thread can't be hibernated
// meanwhile: hibernating stops the CLI's background jobs, so Threadbear asks
// first and Mike is stuck with it awake (17 Nov: "Wait until this Mac's main
// has Ian's commit" sat 40 minutes, and Hibernate asked to kill it). The
// stuck-job check (stuck-jobs.ts) only sees one after 30 quiet minutes.
//
// A scheduled message with a check is the way to wait: Threadbear runs the
// check every few minutes with no agent, wakes the thread when it prints
// something, and the thread can hibernate in between. So the Claude
// adapter's PreToolUse hook refuses a Bash call that looks like a wait that
// would outlast the turn in the background, with a reason saying how. A short wait the agent will use within
// its turn (a dev server coming up, a build it needs next) is fine: it says
// so with SHORT_WAIT_MARK on the command and the call goes through.
//
// Codex's shell has no hook to refuse a call with, so Codex threads aren't
// checked.

// What an agent adds to a command it means as a short wait inside its turn.
// A shell comment, so it changes nothing when the command runs.
export const SHORT_WAIT_MARK = '# short wait';

// A sleep this long or longer by itself (not in a loop) is a timer to wake
// the agent later, which a scheduled message does better.
export const TIMER_SECONDS = 60;

// A loop in the foreground that sleeps this long between looks is a long
// wait too: the CLI moves a command that hits its timeout to the background
// (the SDK's timedOutAfterMs), where it's the same job (Codex's review,
// 18 Nov). A shorter one is a server coming up.
export const FOREGROUND_POLL_SECONDS = 30;

export const WAIT_LOOP_REASON = [
  "This looks like a wait that would outlast the turn as a background job. While one runs, this thread can't be hibernated: hibernating stops background jobs, so Mike is asked to choose between killing it and leaving the thread awake.",
  // A one-off (`when`) whose check prints nothing is skipped and done for
  // good, so the wait would be dropped (Codex's review, 18 Nov): cron only.
  `If it waits on something outside this turn (a merge or landing, CI, a deploy, another thread, a person, a time), don't run it. Call schedule_message with cron "*/5 * * * *" and \`check\` set to a command that prints only once it's ready, saying in the message what to do then and to delete the schedule; then end_turn with snooze. The thread hibernates and the check wakes it.`,
  `If it's a short wait you'll use within this turn (a server starting, a build you need next), add \`${SHORT_WAIT_MARK}\` at the end of the command and run it again.`,
].join(' ');

// sleep's argument in seconds: 30, 1.5, 10m, 2h, 1d. Undefined when it isn't
// a plain number (sleep "$DELAY").
export function sleepSeconds(arg: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
  if (!m) return undefined;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

// What a command does that looks like waiting, read loosely from its text
// with linear scans only (a nested lazy regex took 300 ms on 10 KB of
// unclosed `while x; do`, on the runner's event loop: Codex's review).
// loopSleep: the longest sleep at or after the first while/until/for, so
// `while sleep 5; do …` and a sleep after a nested loop's `done` count (0
// for one whose length can't be read, -1 with no loop or no sleep in it).
// longestSleep: the longest sleep anywhere. watch: a CLI watching CI.
export type WaitShape = { loopSleep: number; longestSleep: number; watch: boolean };

// Where a shell command can start. A quote isn't one, so text inside a
// string (title="sleep forever") isn't read as a command, except right after
// `-c`, where the string is the script (bash -c 'until …').
const START = String.raw`(?:^|[\s;&|(\x60{]|-c\s+['"])`;
const LOOP_RE = new RegExp(`${START}(?:while|until|for)\\s`);
const SLEEP_RE = new RegExp(`${START}sleep\\s+([^\\s;&|)'"\\x60]+)`, 'g');

export function waitShape(command: string): WaitShape {
  const loopAt = command.search(LOOP_RE);
  let loopSleep = -1;
  let longestSleep = -1;
  for (const m of command.matchAll(SLEEP_RE)) {
    const secs = sleepSeconds(m[1]) ?? 0;
    longestSleep = Math.max(longestSleep, secs);
    if (loopAt >= 0 && m.index >= loopAt) loopSleep = Math.max(loopSleep, secs);
  }
  const watch = /\bgh\s+run\s+watch\b/.test(command) || /\bgh\s+pr\s+checks\b[^;&|\n]*--watch\b/.test(command);
  return { loopSleep, longestSleep, watch };
}

// Whether a command would wait past the turn: in the background, any loop
// that sleeps, a sleep of a minute or more (a timer), or a CI watch; in the
// foreground, a loop that sleeps FOREGROUND_POLL_SECONDS or more between looks.
export function isWaitCommand(command: string, background = true): boolean {
  const w = waitShape(command);
  if (!background) return w.loopSleep >= FOREGROUND_POLL_SECONDS;
  return w.loopSleep >= 0 || w.longestSleep >= TIMER_SECONDS || w.watch;
}

// The reason to refuse a call, or undefined when it's fine: only a Bash call
// that waits (isWaitCommand), without the short-wait mark.
export function denyWaitLoop(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool !== 'Bash') return undefined;
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.toLowerCase().includes(SHORT_WAIT_MARK)) return undefined;
  return isWaitCommand(command, input.run_in_background === true) ? WAIT_LOOP_REASON : undefined;
}
