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
// adapter's PreToolUse hook refuses a background Bash call that looks like a
// wait, with a reason saying how. A short wait the agent will use within
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

export const WAIT_LOOP_REASON = [
  "This looks like a background wait. While it runs, this thread can't be hibernated: hibernating stops background jobs, so Mike is asked to choose between killing it and leaving the thread awake.",
  `If it waits on something outside this turn (a merge or landing, CI, a deploy, another thread, a person, a time), don't run it. Call schedule_message with \`check\` set to a command that prints only once it's ready (cron "*/5 * * * *", or a \`when\`), saying in the message what to do then and to delete the schedule; then end_turn with snooze. The thread hibernates and wakes when the check prints.`,
  `If it's a short wait you'll use within this turn (a server starting, a build you need next), add \`${SHORT_WAIT_MARK}\` at the end of the command and run it again.`,
].join(' ');

// sleep's argument in seconds: 30, 1.5, 10m, 2h, 1d. Undefined when it isn't
// a plain number (sleep "$DELAY"), which counts as short.
export function sleepSeconds(arg: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
  if (!m) return undefined;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

// Whether a shell command is a wait: a while, until or for loop that sleeps,
// a long sleep by itself, or a CLI watching CI until it's done. Read loosely
// from the text, as the hook only has that: a loop that does real work and
// sleeps between rounds counts too, which is right, as it keeps the thread
// awake all the same.
export function isWaitCommand(command: string): boolean {
  // Quoted text is read as code too, so a loop inside `bash -c '...'` or
  // `nohup sh -c "..."` is caught. Text that only talks about a loop could
  // be caught with it, which costs one call and the short-wait mark.
  const code = command;
  const sleeps = /(?:^|[\s;&|(`{'"])sleep(?=\s)/;
  // A loop whose body sleeps: `while/until/for ...; do ... sleep ... done`.
  for (const m of code.matchAll(/(?:^|[\s;&|(`{'"])(?:while|until|for)\s[\s\S]*?\bdo\b([\s\S]*?)\bdone\b/g)) {
    if (sleeps.test(m[1])) return true;
  }
  // A long sleep anywhere else: `sleep 1800 && echo check` is a timer.
  for (const m of code.matchAll(/(?:^|[\s;&|(`{'"])sleep\s+([^\s;&|)'"`]+)/g)) {
    const secs = sleepSeconds(m[1]);
    if (secs !== undefined && secs >= TIMER_SECONDS) return true;
  }
  // Watching CI until it finishes.
  if (/\bgh\s+run\s+watch\b/.test(code) || /\bgh\s+pr\s+checks\b[^;&|\n]*--watch\b/.test(code)) return true;
  return false;
}

// The reason to refuse a call, or undefined when it's fine: only a Bash call
// run in the background that waits, without the short-wait mark.
export function denyWaitLoop(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool !== 'Bash' || input.run_in_background !== true) return undefined;
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.toLowerCase().includes(SHORT_WAIT_MARK)) return undefined;
  return isWaitCommand(command) ? WAIT_LOOP_REASON : undefined;
}
