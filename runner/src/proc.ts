import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './log.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { IS_WINDOWS } from './platform.ts';
import { parseProcesses, powershellPath, win32Helper } from './win32-helper.ts';
import crypto from 'node:crypto';

// A process group, with its leader's start time so a recycled pid is never
// mistaken for it. lstart is '' when the leader had already exited when the
// group was noted. started is its clock-proof start on Linux (see Started).
type Group = { pgid: number; lstart: string } & Started;
// threadId: the thread (or a job's label) the process was started for, which
// the RPC server asks about (peer.ts).
// job: on Windows, the Job Object the CLI and everything it starts are in
// (JobControl), by name.
type Entry = { pid: number; command: string; startedAt: string; lstart?: string; started?: string; groups?: Group[]; threadId?: string; job?: string };

// Windows' stand-in for a CLI's process group: a Job Object, made by the
// runner's helper (win32-helper.ps1) as the CLI starts. Ending it ends
// every process still in it, whatever became of their parents, which
// taskkill /T can't find once a parent has gone. Tests pass a stand-in.
export type JobControl = { assign(pid: number, name: string): Promise<unknown>; end(name: string): Promise<unknown> };

export const helperJobs: JobControl = {
  assign: (pid, name) => win32Helper().ask('jobAssign', { pid, name }),
  end: (name) => win32Helper().ask('jobEnd', { name }),
};

export function newJobName(): string {
  return `Local\\threadbear-job-${crypto.randomBytes(16).toString('hex')}`;
}

const SCAN_MS = 5000;

// Every CLI the runner starts gets its own process group (detached), so the
// CLI and anything it spawned in that group (MCP servers) can be stopped
// together. Tool commands are different: the CLI runs each Bash command in
// a process group of its own, so while CLIs are live the runner also notes
// which groups their descendants are in. Everything is recorded in
// run/children.json. If a CLI dies without cleaning up, or the runner dies,
// those groups are stopped too, and only those.
export class ProcessRegistry {
  private file: string;
  private log: Logger;
  private entries = new Map<number, Entry>();
  private scanTimer?: NodeJS.Timeout;
  private scanning = false;

  // `name` is children.json for the runner that owns the data dir. A
  // draining runner (docs/protocol.md, "Handovers") moves its list to
  // children-<pid>.json, so the new runner's sweep leaves its CLIs alone,
  // and sweeps that file only if it dies.
  constructor(runDir: string, log: Logger, name = 'children.json') {
    this.file = path.join(runDir, name);
    this.log = log;
  }

  // Moves the list to another file in the same folder.
  moveTo(name: string): void {
    const old = this.file;
    this.file = path.join(path.dirname(old), name);
    this.save();
    try {
      fs.rmSync(old, { force: true });
    } catch {
      // the new runner's sweep finds an old copy empty of anything alive
    }
  }

  // Removes the list (a draining runner that has finished).
  removeFile(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // gone
    }
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.file, JSON.stringify([...this.entries.values()], null, 1));
    } catch (e) {
      this.log.warn('could not save children.json', { error: String(e) });
    }
  }

  add(pid: number, command: string, threadId?: string): void {
    // Taken before the probe, which can take a while: the process was started
    // moments ago, so on Windows this stands in for its start time if
    // PowerShell can't give the real one (approxStartTime).
    const spawnedAt = Date.now();
    const info = processInfo(pid);
    const start = info ? startOf(info) : IS_WINDOWS ? { lstart: approxStartTime(spawnedAt) } : {};
    // Never the runner itself (tests register their own process).
    const job = this.jobs && pid !== process.pid ? newJobName() : undefined;
    this.entries.set(pid, { pid, command, startedAt: new Date().toISOString(), ...start, groups: [], ...(threadId ? { threadId } : {}), ...(job ? { job } : {}) });
    this.save();
    // Straight away, while the runner still holds the child (so the pid is
    // still this CLI's): what it starts from then on goes in the job too.
    if (job) this.jobs!.assign(pid, job).catch((e) => this.log.warn("could not put a CLI in a job of its own; taskkill /T still stops it", { pid, error: String(e) }));
    this.scanTimer ??= setInterval(() => void this.scan(), SCAN_MS).unref();
  }

  remove(pid: number): void {
    const job = this.entries.get(pid)?.job;
    if (this.entries.delete(pid)) this.save();
    // The CLI has exited: whatever it left running goes with its job, as its
    // process group does on a Mac.
    if (job) this.endJob(job, pid);
    if (this.entries.size === 0 && this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  pids(): number[] {
    return [...this.entries.keys()];
  }

  // The thread whose CLI ran a tool command in this process group (noted by
  // scan), or whose CLI leads it. For a process that's lost its parents.
  threadOfGroup(pgid: number): string | undefined {
    for (const e of this.entries.values()) {
      if (e.threadId && (e.pid === pgid || e.groups?.some((g) => g.pgid === pgid))) return e.threadId;
    }
    return undefined;
  }

  // The thread a live CLI was started for: this runner's own (gone from the
  // map when it exits), or one a draining runner still has (its list is kept
  // beside this one, where a recycled pid wouldn't have the same start time).
  // created (Windows, a FILETIME from the peer lookup's snapshot) is when the
  // process with this pid started: a CLI that has exited, its pid taken by
  // another thread's new CLI before the lookup reads this, mustn't count for
  // the new one (Codex's review, 18 Nov 2026).
  // A CLI's entry whose start doesn't match throws StaleProcess rather than
  // saying "no thread": the lookup then closes the connection, where "no
  // thread" would leave the credential presented to decide (Codex's third
  // review).
  async threadOfPid(pid: number, created?: bigint): Promise<string | undefined> {
    const own = this.entries.get(pid);
    if (own) {
      const exact = await this.confirmStart(own, created);
      if (exact === false) throw new StaleProcess(pid);
      if (typeof exact === 'string') {
        own.lstart = exact;
        this.save();
      }
      return own.threadId;
    }
    let names: string[];
    try {
      names = fs.readdirSync(path.dirname(this.file)).filter((n) => /^children-\d+\.json$/.test(n));
    } catch {
      return undefined;
    }
    for (const n of names) {
      const entries = readJsonSync<Entry[]>(path.join(path.dirname(this.file), n));
      const e = Array.isArray(entries) ? entries.find((x) => x?.pid === pid) : undefined;
      if (!e?.threadId) continue;
      if (created) {
        if ((await this.confirmStart(e, created)) !== false) return e.threadId;
        throw new StaleProcess(pid);
      } else if (!(e.lstart || e.started) || sameStart(e, processInfo(pid))) return e.threadId;
    }
    return undefined;
  }

  // Whether a recorded CLI is the process that started at `created`: true,
  // false, or the exact start to record in place of an estimate. An
  // estimate (the probe failed when it started) can't tell two processes
  // ten seconds apart (Codex's fourth review), so the pid's start is read
  // again now: it counts only if that exact reading is the snapshot's
  // process and fits the estimate. A reading that fails is a no. Rare (a
  // failed probe), and the reading is the same one add() makes.
  // How confirmStart reads a start again: the helper's process list on
  // Windows, never a blocking PowerShell (Codex's fifth review: a hung
  // probe held the whole runner up to 10 s for each connection). Tests pass
  // a stand-in.
  readStart: (pid: number) => Promise<string | undefined> = readStartNow;
  // Reads in flight, and exact starts confirmed, by pid and estimate: any
  // number of connections share one read, and a draining runner's entry
  // (whose file isn't this runner's to rewrite) is read once.
  private confirming = new Map<string, Promise<string | undefined>>();
  private confirmed = new Map<string, string>();

  private async confirmStart(e: { pid?: number; lstart?: string }, created: bigint | undefined): Promise<boolean | string> {
    if (!created || !e.lstart?.startsWith('~') || !e.pid) return startedAt(e, created);
    const key = `${e.pid}:${e.lstart}`;
    let now = this.confirmed.get(key);
    if (!now) {
      let reading = this.confirming.get(key);
      if (!reading) {
        reading = this.readStart(e.pid).finally(() => this.confirming.delete(key));
        this.confirming.set(key, reading);
      }
      now = await reading.catch(() => undefined);
    }
    if (!now || !/^\d+$/.test(now)) return false;
    if (!startedAt({ lstart: now }, created) || !sameStartTime(e.lstart, now)) return false;
    this.confirmed.set(key, now);
    return now;
  }

  // Groups the CLI's tool commands ran in that are still running.
  toolGroups(pid: number): number[] {
    return (this.entries.get(pid)?.groups ?? []).filter((g) => sameGroup(g)).map((g) => g.pgid);
  }

  // Notes the process groups of every live CLI's descendants.
  async scan(): Promise<void> {
    // Windows has no process groups to note (a Job Object helper is the
    // planned way to catch a crashed CLI's tool commands).
    if (IS_WINDOWS || this.scanning || this.entries.size === 0) return;
    this.scanning = true;
    try {
      const table = await psTable();
      const kids = new Map<number, number[]>();
      const pgidOf = new Map<number, number>();
      for (const r of table) {
        pgidOf.set(r.pid, r.pgid);
        const list = kids.get(r.ppid) ?? [];
        list.push(r.pid);
        kids.set(r.ppid, list);
      }
      const found = new Map<Entry, Set<number>>();
      for (const e of this.entries.values()) {
        const known = new Set((e.groups ?? []).map((g) => g.pgid));
        const fresh = new Set<number>();
        const stack = [...(kids.get(e.pid) ?? [])];
        const seen = new Set<number>();
        while (stack.length) {
          const p = stack.pop()!;
          if (seen.has(p)) continue;
          seen.add(p);
          const pg = pgidOf.get(p);
          if (pg && pg !== e.pid && pg > 1 && !known.has(pg)) fresh.add(pg);
          stack.push(...(kids.get(p) ?? []));
        }
        if (fresh.size) found.set(e, fresh);
      }
      if (found.size === 0) return;
      for (const [e, pgids] of found) {
        if (!this.entries.has(e.pid)) continue; // exited while ps ran
        for (const pgid of pgids) {
          e.groups ??= [];
          const info = processInfo(pgid);
          e.groups.push({ pgid, ...(info ? startOf(info) : { lstart: '' }) });
        }
      }
      this.save();
    } catch (e) {
      this.log.debug('process scan failed', { error: String(e) });
    } finally {
      this.scanning = false;
    }
  }

  // Stops groups recorded by a previous runner that are still alive and
  // waits until they're gone, so a resumed session never runs beside the
  // CLI it replaces. A group is only touched if its leader is the process
  // that was recorded (same start time), or the leader has exited and the
  // group lives on (a pid isn't reused while its group exists).
  // The jobs (Windows) of CLIs that are gone. A job's name is the runner's,
  // random, so ending one can only reach what's in it, never a reused pid.
  jobs?: JobControl = IS_WINDOWS ? helperJobs : undefined;

  private endJob(name: string, pid?: number): Promise<void> {
    return (this.jobs ?? helperJobs).end(name).then(
      () => undefined,
      (e) => this.log.warn("could not end a CLI's job", { pid, error: String(e) }),
    );
  }

  async sweepOrphans(graceMs = 3000): Promise<number> {
    const previous = readJsonSync<Entry[]>(this.file) ?? [];
    // What the previous runner's CLIs left, whatever became of the CLIs.
    await Promise.all(previous.filter((e) => typeof e?.job === 'string').map((e) => this.endJob(e.job!, e.pid)));
    const targets: number[] = [];
    for (const e of previous) {
      if (!e || typeof e.pid !== 'number') continue;
      if (sameGroup({ pgid: e.pid, lstart: e.lstart ?? '', started: e.started }, e.lstart || e.started ? undefined : path.basename(e.command ?? ''))) targets.push(e.pid);
      for (const g of e.groups ?? []) if (sameGroup(g)) targets.push(g.pgid);
    }
    for (const pgid of targets) {
      this.log.warn('stopping a process group left over from a previous runner', { pgid });
      killGroup(pgid, 'SIGTERM');
    }
    await waitGone(targets, graceMs);
    const stubborn = targets.filter((p) => groupAlive(p));
    for (const pgid of stubborn) killGroup(pgid, 'SIGKILL');
    await waitGone(stubborn, 2000);
    this.entries.clear();
    this.save();
    return targets.length;
  }

  // SIGTERM every live group, wait up to graceMs, then SIGKILL stragglers.
  async killAll(graceMs = 3000): Promise<void> {
    const pids = this.pids();
    await Promise.all([...this.entries.values()].filter((e) => e.job).map((e) => this.endJob(e.job!, e.pid)));
    const groups = pids.flatMap((pid) => [pid, ...this.toolGroups(pid)]);
    for (const pgid of groups) killGroup(pgid, 'SIGTERM');
    await waitGone(groups, graceMs);
    for (const pgid of groups) if (groupAlive(pgid)) killGroup(pgid, 'SIGKILL');
    this.entries.clear();
    this.save();
  }
}

async function waitGone(pgids: number[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pgids.some((p) => groupAlive(p))) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (IS_WINDOWS) return killTreeWindows(pgid);
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

// Whether the SIGKILL that follows a SIGTERM a few seconds on should still go
// out. On a Mac it goes if the group is still there. On Windows a pid can be
// reused as soon as its process is gone, and the kill would end whatever has
// it now, so it goes only while the process hasn't been seen to exit.
export function followUpKillDue(pid: number, exited: boolean): boolean {
  return (!IS_WINDOWS || !exited) && groupAlive(pid);
}

export function hasExited(child: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(IS_WINDOWS ? pgid : -pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Windows ends a process and everything it started in one go. There's no
// gentler signal for a console program: SIGTERM is a hard kill there too.
// Only a pid the runner started and still has recorded reaches this.
function killTreeWindows(pid: number): boolean {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// True if the group is alive and still the one that was recorded.
function sameGroup(g: Group, commandHint?: string): boolean {
  if (!g || typeof g.pgid !== 'number' || g.pgid <= 1 || !groupAlive(g.pgid)) return false;
  const leader = processInfo(g.pgid);
  // A pid is reused on Windows, and nothing holds it as a group does on a
  // Mac: unless the start time recorded matches, it isn't ours to stop.
  if (IS_WINDOWS) return Boolean(leader && g.lstart && sameStartTime(g.lstart, leader.lstart));
  if (!leader) return true; // leader gone; the group's members are the original ones
  if (leader.pgid !== g.pgid) return false;
  if (g.lstart || g.started) return sameStart(g, leader);
  // Old records with no start time fall back to the command name.
  return Boolean(commandHint) && leader.command.includes(commandHint!);
}

const C_LOCALE = { ...process.env, LC_ALL: 'C' };

// A process's identity is its pid and when it started, kept in records
// (run/runner.pid, children*.json) that outlive the runner. lstart is ps's
// start time, fixed at fork on macOS. On Linux ps works lstart out as the
// kernel's boot time plus the process's age, and the boot time moves whenever
// the clock is stepped (a WSL runner's moved 75 s in 15 minutes, 17 Nov), so
// a live process could stop matching its own record: a live lock holder
// looked dead, a recorded CLI looked recycled. There, started is the boot's
// id and /proc's start time in clock ticks since boot, which never move; the
// boot id stops a record from before a reboot matching a new process.
// Records keep lstart as well, as older releases (a rollback, a handover's
// other runner) read only that.
export type Started = { started?: string };
export type ProcessInfo = { pgid: number; lstart: string; command: string } & Started;

export function processInfo(pid: number): ProcessInfo | null {
  if (IS_WINDOWS) return processInfoWindows(pid);
  try {
    for (let tries = 1; ; tries++) {
      // Read /proc either side of ps: two different starts mean the pid was
      // reused meanwhile, so one process's start would pair with another's
      // group and command; read again. One side missing isn't that (it
      // exited just after ps, or /proc couldn't say), so keep the other
      // rather than answer "gone": sameGroup takes a gone leader as its
      // group being the recorded one, which a stale record mustn't get.
      const before = linuxStart(pid);
      const out = execFileSync('/bin/ps', ['-o', 'pgid=,lstart=,command=', '-p', String(pid)], { encoding: 'utf8', env: C_LOCALE }).trim();
      const after = linuxStart(pid);
      if (before && after && before !== after && tries < 3) continue;
      // lstart is five fields in the C locale: "Mon Oct 26 15:04:05 2026".
      const m = /^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(out);
      if (!m) return null;
      const info = { pgid: Number(m[1]), lstart: m[2].replace(/\s+/g, ' '), command: m[3] };
      if (before && after && before !== after) return null; // a pid recycled three times over
      const started = before ?? after;
      return started ? { ...info, started } : info;
    }
  } catch {
    return null;
  }
}

// The start time (as a 100 ns count since 1601, which is exact and has no
// time zone) and program of a process, from PowerShell. A quarter of a second
// or so, paid once for each CLI the runner starts.
function processInfoWindows(pid: number): { pgid: number; lstart: string; command: string } | null {
  try {
    const out = execFileSync(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop; "$($p.StartTime.ToFileTimeUtc()) $($p.ProcessName)"`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const m = /^(\d+) (.*)$/.exec(out);
    return m ? { pgid: pid, lstart: m[1], command: m[2] } : null;
  } catch {
    return null;
  }
}

// Windows only. When PowerShell can't be run (policy, AppLocker, or the probe
// timing out under load) a start time is worked out in this process instead:
// the same 100 ns count since 1601, with a "~" in front to say it is an
// estimate. The clock behind it isn't the one the system stamped the process
// with (node starts counting a little after the process does), so an estimate
// matches a real start time within START_SLACK rather than exactly. A real
// reading is never matched loosely. A reused pid has a start time seconds to
// days away from the one recorded, so it still doesn't match.
const FILETIME_AT_UNIX_EPOCH_MS = 11_644_473_600_000n;
const START_SLACK = 100_000_000n; // 10 s in 100 ns units

export function approxStartTime(unixMs: number): string {
  return '~' + ((BigInt(Math.round(unixMs)) + FILETIME_AT_UNIX_EPOCH_MS) * 10_000n).toString();
}

// This process's own start time, from node's uptime clock.
export function ownStartTime(): string {
  return approxStartTime(Date.now() - process.uptime() * 1000);
}

// True if a start time recorded earlier is the one just read.
// Whether a recorded CLI is the process that started at `created` (a
// FILETIME, from Windows' process list, whose times are a microsecond
// coarser than Get-Process's, so they match to within one). No time to go
// by on either side: the pid stands, as it did before.
// A process's exact start now, as a FILETIME string: from the helper on
// Windows (the only place estimates are made), undefined when it can't say.
async function readStartNow(pid: number): Promise<string | undefined> {
  if (process.platform !== 'win32') return processInfo(pid)?.lstart;
  const row = parseProcesses(await win32Helper().ask('processes')).find((p) => p.pid === pid);
  return row && row.created > 0n ? String(row.created) : undefined;
}

export class StaleProcess extends Error {
  constructor(pid: number) {
    super(`process ${pid} isn't the CLI registered with its id any more`);
  }
}

export function startedAt(recorded: { lstart?: string }, created: bigint | undefined): boolean {
  if (!created || !recorded.lstart) return true;
  const exact = /^(\d+)$/.exec(recorded.lstart);
  const est = /^~(\d+)$/.exec(recorded.lstart);
  const at = exact?.[1] ?? est?.[1];
  if (!at) return true;
  const gap = BigInt(at) - created;
  return (gap < 0n ? -gap : gap) <= (exact ? 10n : START_SLACK);
}

export function sameStartTime(recorded: string, read: string): boolean {
  if (recorded === read) return true;
  const est = /^~(\d+)$/.exec(recorded);
  if (!est || !/^\d+$/.test(read)) return false;
  const gap = BigInt(est[1]) - BigInt(read);
  return (gap < 0n ? -gap : gap) <= START_SLACK;
}

// True if a process with this pid exists, whoever it belongs to. Sends no
// signal: on Windows as elsewhere, signal 0 only checks.
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// What a record keeps of a process's start.
export function startOf(info: ProcessInfo): { lstart: string } & Started {
  return info.started ? { lstart: info.lstart, started: info.started } : { lstart: info.lstart };
}

// Whether a record's start is this process's. A record with started is
// checked on that alone; one an older runner wrote has only lstart. If /proc
// couldn't say either side of ps (it shouldn't, for our own processes), a
// record with started falls back to lstart, which is how it always was.
export function sameStart(recorded: { lstart?: string } & Started, info: ProcessInfo | null | undefined): boolean {
  if (!info) return false;
  if (recorded.started && info.started) return recorded.started === info.started;
  return Boolean(recorded.lstart) && sameStartTime(recorded.lstart!, info.lstart);
}

let bootId: string | undefined;
// "<boot id>:<start ticks>" on Linux, undefined elsewhere or if /proc can't
// say. Ticks are field 22 of /proc/<pid>/stat; the command name (field 2, in
// brackets) can hold spaces and brackets, so count from the last ')'.
function linuxStart(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    bootId ??= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return bootId && ticks && /^\d+$/.test(ticks) ? `${bootId}:${ticks}` : undefined;
  } catch {
    return undefined;
  }
}

export function psTable(): Promise<{ pid: number; ppid: number; pgid: number }[]> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const rows: { pid: number; ppid: number; pgid: number }[] = [];
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
      }
      resolve(rows);
    });
  });
}

// spawnClaudeCodeProcess implementation for the SDK. threadId goes in the
// spawn and exit log lines, so `tb logs --thread` shows a CLI crashing.
export function groupSpawner(
  registry: ProcessRegistry,
  log: Logger,
  onStderr: (line: string) => void,
  threadId?: string,
): (opts: SpawnOptions) => SpawnedProcess {
  return (opts) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group where there are groups; on Windows a detached
      // process gets a console window, and nothing needs the separation.
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid) registry.add(pid, opts.command, threadId);
    log.info('spawned CLI', { threadId, pid, cwd: opts.cwd });
    let buf = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onStderr(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    // The SDK fires this after closing stdin and a short grace period.
    opts.signal.addEventListener(
      'abort',
      () => {
        if (!pid || child.exitCode !== null) return;
        killGroup(pid, 'SIGTERM');
        setTimeout(() => {
          if (followUpKillDue(pid, hasExited(child))) killGroup(pid, 'SIGKILL');
        }, 3000).unref();
      },
      { once: true },
    );
    child.once('exit', (code, signal) => {
      log.info('CLI exited', { threadId, pid, code, signal });
      if (!pid) return;
      // Stop anything the CLI left running in its group. Not on Windows: with
      // the CLI gone its pid may already be someone else's.
      if (!IS_WINDOWS) killGroup(pid, 'SIGTERM');
      // A CLI that ended normally has stopped its own tool commands. One
      // that crashed or was killed hasn't, and they'd run on for ever.
      if (code !== 0) {
        const left = registry.toolGroups(pid);
        if (left.length) {
          log.warn('stopping tool commands a CLI left behind', { threadId, pid, groups: left });
          for (const g of left) killGroup(g, 'SIGTERM');
          setTimeout(() => {
            for (const g of left) if (groupAlive(g)) killGroup(g, 'SIGKILL');
          }, 3000).unref();
        }
      }
      registry.remove(pid);
    });
    return child as unknown as SpawnedProcess;
  };
}
