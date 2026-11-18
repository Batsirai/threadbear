// Box mode's categorical quiesce (box-save.ts, Codex's third review of
// slice 3): in a box the runner owns the whole machine, so before a
// stopping save copies anything, every other process the box has started
// is killed: the CLI's leftovers, a worktree setup's background children,
// a teardown, anything an agent left running. What's spared: the runner,
// its ancestors (the image's entrypoint), PID 1, and whatever was already
// running when the box booted (the provider's own helpers, such as Fly's
// init and its SSH server). Never on a normal runner: main.ts makes one
// only in box mode, and it reads Linux's /proc (a box is a Linux machine).
import fs from 'node:fs';
import path from 'node:path';

export type Proc = { pid: number; ppid: number; start: string; zombie: boolean };

// Every process, from /proc/<pid>/stat: its parent, its start time (in
// clock ticks since boot, which tells a reused pid from the first) and
// whether it's already a zombie (dead, waiting to be reaped).
export function listProcs(root = '/proc'): Proc[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    throw new Error(`can't list the box's processes (${String((e as Error).message ?? e)})`);
  }
  const out: Proc[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(path.join(root, n, 'stat'), 'utf8');
    } catch {
      continue; // gone meanwhile
    }
    // "pid (comm) state ppid ...": comm can hold spaces and parens, so the
    // fields are read after its last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    const start = rest[19] ?? '';
    if (!Number.isInteger(ppid)) continue;
    out.push({ pid: Number(n), ppid, start, zombie: rest[0] === 'Z' || rest[0] === 'X' });
  }
  return out;
}

const key = (p: Proc) => `${p.pid}:${p.start}`;

export class BoxProcesses {
  private readonly self: number;
  private readonly list: () => Proc[];
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private before = new Set<string>();

  constructor(o: { self?: number; list?: () => Proc[]; kill?: (pid: number, signal: NodeJS.Signals) => void; sleep?: (ms: number) => Promise<void> } = {}) {
    this.self = o.self ?? process.pid;
    this.list = o.list ?? (() => listProcs());
    this.kill = o.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // What was running as the box booted, before the runner started anything:
  // the provider's, spared for good.
  boot(): void {
    this.before = new Set(this.list().map(key));
  }

  // The processes a stopping save kills: everything but the runner, its
  // ancestors, PID 1, what was there at boot, and the dead.
  private others(procs: Proc[]): Proc[] {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const spared = new Set<number>([1, this.self]);
    // Its ancestors, up to PID 1.
    for (let p = byPid.get(this.self); p && !spared.has(p.ppid); p = byPid.get(p.ppid)) spared.add(p.ppid);
    return procs.filter((p) => !spared.has(p.pid) && !this.before.has(key(p)) && !p.zombie);
  }

  /**
   * Kills every other process the box has started, and looks again until
   * none is left (a process forking as it dies, a new one started): throws
   * if some won't go. Returns how many it killed.
   */
  async stopOthers(tries = 20): Promise<number> {
    let killed = 0;
    for (let i = 0; i < tries; i++) {
      const left = this.others(this.list());
      if (!left.length) return killed;
      for (const p of left) {
        try {
          this.kill(p.pid, 'SIGKILL');
          killed++;
        } catch {
          // gone already
        }
      }
      await this.sleep(50);
    }
    const still = this.others(this.list());
    if (!still.length) return killed;
    throw new Error(`${still.length} of the box's processes wouldn't stop (${still.slice(0, 5).map((p) => p.pid).join(', ')}), so nothing was saved.`);
  }
}
