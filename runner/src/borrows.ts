// Takes back worktrees borrowed with borrow-worktree.sh and never given back
// (docs/thread-worktrees.md, "Borrows nobody gives back").
//
// On 17 Nov 2026 all 50 slots of Mike's threadbear-threads were taken: 25
// were on thread/borrow-* branches from the six days before, landed and
// left (threads that borrow, land and never run --give-back, and a
// sync-main killed mid-check), and the next sync-main couldn't borrow one,
// so main wasn't pushed. Asking every borrower to remember hasn't worked,
// so the runner takes them back, hourly, once that's safe.
//
// A borrow is a checkout in the repo's <repo>-threads folder that isn't
// locked and is on a thread/borrow-* branch, or detached (a spare claimed
// and never set up, a borrow given back half way), and that no thread's
// record holds. It goes back when its borrower has gone and nothing in it
// would be lost:
//
// - The borrower, from the `threadbear-borrow` file borrow-worktree.sh
//   writes beside git's own: a process (sync-main's) that has ended, a
//   thread that's archived, or, with neither recorded or the thread not
//   one of this runner's, a day with nothing done there (git's HEAD log).
//   A thread still open keeps its borrow however long it's quiet.
// - Nothing lost: no rebase, merge or the like half done, no changes or
//   untracked files, HEAD all on main, and no process working in it (its
//   current folder inside). Detached ones always need the quiet day too.
//   A scratch borrow (sync-main's, whose script throws its work away) is
//   the exception: once its process has gone, what it left is aborted and
//   reset to main first.
//
// Then, like --give-back: detached, its borrow branch deleted, and locked as
// a spare, or removed when the repo has MAX_SPARES already. Borrow branches
// nobody has checked out and that are all on main are deleted too.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { git, listCheckouts, MAIN, MAX_SPARES, realpath, SPARE } from './worktrees.ts';

export const BORROW_FILE = 'threadbear-borrow';
export const BORROW_PREFIX = 'thread/borrow-';
// How long a borrow nobody's said is still theirs sits unused before it
// goes back. A day: a thread that borrowed and is still working commits,
// rebases or lands well inside that.
export const BORROW_IDLE_MS = 24 * 3_600_000;
// Git's own markers of something half done in a checkout.
const HALF_DONE = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_LOG'];

export type Borrower = { thread?: string; pid?: number; scratch?: boolean; at?: number };

export function readBorrower(admin: string): Borrower | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(admin, BORROW_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const b: Borrower = {};
  for (const line of text.split('\n')) {
    const [k, v = ''] = line.split(/=(.*)/s, 2).map((s) => s.trim());
    if (!v) continue;
    if (k === 'thread') b.thread = v;
    else if (k === 'pid' && /^\d+$/.test(v)) b.pid = Number(v);
    else if (k === 'scratch') b.scratch = v === '1';
    else if (k === 'at' && /^\d+$/.test(v)) b.at = Number(v) * 1000;
  }
  return b;
}

export type SweepOptions = {
  now?: number;
  // The thread's state on this runner: 'unknown' for an id it doesn't have.
  thread: (id: string) => 'open' | 'archived' | 'unknown';
  // Folders threads use (realpaths): their worktrees and current folders.
  // A borrow with one of them in it is never touched.
  held: Set<string>;
  pidAlive?: (pid: number) => boolean;
  // Every process's current folder; undefined when that can't be read, and
  // then nothing is taken back.
  cwds?: () => Promise<string[] | undefined>;
};

export type Reclaimed = { path: string; branch?: string; to: 'spare' | 'removed'; why: string; thread?: string };
export type SweepResult = { reclaimed: Reclaimed[]; branches: string[]; skipped: { path: string; why: string }[] };

export async function sweepBorrows(mainCheckout: string, opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { reclaimed: [], branches: [], skipped: [] };
  const now = opts.now ?? Date.now();
  const alive = opts.pidAlive ?? pidAlive;
  const threads = realpath(path.join(path.dirname(mainCheckout), `${path.basename(mainCheckout)}-threads`));
  const checkouts = await listCheckouts(mainCheckout);
  if (!checkouts || !checkouts.some((c) => c.branch === MAIN)) return result;
  const inThreads = (p: string) => path.dirname(realpath(p)) === threads;
  let spares = checkouts.filter((c) => c.locked === SPARE && inThreads(c.path)).length;

  const candidates = checkouts.filter(
    (c) => c.locked === undefined && inThreads(c.path) && (!c.branch || c.branch.startsWith(BORROW_PREFIX)) && !holds(opts.held, realpath(c.path)),
  );
  let cwds: string[] | undefined;
  if (candidates.length) {
    cwds = await (opts.cwds ?? processCwds)();
    if (!cwds) return result;
  }
  for (const c of candidates) {
    const skip = (why: string) => void result.skipped.push({ path: c.path, why });
    const admin = (await git(c.path, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    if (!admin || !fs.existsSync(admin)) continue;
    const who = readBorrower(admin) ?? {};
    const idle = now - lastUsed(admin) >= BORROW_IDLE_MS;
    let why: string | undefined;
    let scratch = false;
    if (who.pid !== undefined && !alive(who.pid)) {
      why = 'the script that borrowed it has ended';
      scratch = who.scratch === true;
    } else if (who.pid !== undefined) {
      if (idle) why = 'unused for a day';
    } else if (who.thread && opts.thread(who.thread) === 'archived') {
      why = 'the thread that borrowed it is archived';
    } else if (who.thread && opts.thread(who.thread) === 'open') {
      continue;
    } else if (idle) {
      why = 'unused for a day';
    }
    if (!why) continue;
    if (!c.branch && !idle && !scratch) continue;
    if (holds(cwds!, realpath(c.path))) {
      skip('a process is working in it');
      continue;
    }
    const head = readHead(admin);
    if (scratch) {
      // Its script's work, thrown away as the script itself would have.
      for (const args of [['rebase', '--abort'], ['merge', '--abort'], ['cherry-pick', '--abort']]) await git(c.path, args);
      if (!(await git(c.path, ['reset', '-q', '--hard', MAIN])).ok) {
        skip("git couldn't reset it");
        continue;
      }
      await git(c.path, ['clean', '-fdq']);
    }
    if (HALF_DONE.some((f) => fs.existsSync(path.join(admin, f)))) {
      skip('something is half done there (a rebase, a merge)');
      continue;
    }
    const status = await git(c.path, ['status', '--porcelain', '--untracked-files=all']);
    if (!status.ok || status.stdout.trim()) {
      skip(status.ok ? 'it has changes or untracked files' : "git couldn't read it");
      continue;
    }
    const tip = (await git(c.path, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!tip || !(await git(mainCheckout, ['merge-base', '--is-ancestor', tip, MAIN])).ok) {
      skip(`it has commits that aren't on ${MAIN}`);
      continue;
    }
    // Read again just before the detach: still on the commit and branch
    // (or none) just checked.
    if (!scratch && readHead(admin) !== head) {
      skip('its HEAD changed while it was looked at');
      continue;
    }
    const branch = c.branch;
    if (branch && !(await git(c.path, ['checkout', '-q', '--detach'])).ok) {
      skip("git couldn't detach it");
      continue;
    }
    if (branch) await git(mainCheckout, ['branch', '-q', '-D', branch]);
    let to: Reclaimed['to'];
    if (spares < MAX_SPARES && (await git(mainCheckout, ['worktree', 'lock', '--reason', SPARE, c.path])).ok) {
      fs.rmSync(path.join(admin, BORROW_FILE), { force: true });
      spares++;
      to = 'spare';
    } else if ((await git(mainCheckout, ['worktree', 'remove', c.path])).ok) {
      to = 'removed';
    } else {
      skip("git couldn't lock or remove it");
      continue;
    }
    result.reclaimed.push({ path: c.path, ...(branch ? { branch } : {}), to, why, ...(who.thread ? { thread: who.thread } : {}) });
  }

  // Borrow branches left behind with no checkout (their folder was reused
  // or removed by hand), all on main.
  const out = await listCheckouts(mainCheckout);
  const checkedOut = new Set((out ?? []).map((c) => c.branch).filter(Boolean));
  const refs = await git(mainCheckout, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BORROW_PREFIX}*`]);
  if (out && refs.ok) {
    for (const b of refs.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (checkedOut.has(b)) continue;
      if (!(await git(mainCheckout, ['merge-base', '--is-ancestor', b, MAIN])).ok) continue;
      if ((await git(mainCheckout, ['branch', '-q', '-D', b])).ok) result.branches.push(b);
    }
  }
  return result;
}

function holds(folders: Iterable<string>, dir: string): boolean {
  for (const f of folders) if (f === dir || f.startsWith(dir + path.sep)) return true;
  return false;
}

// When anything last happened in the checkout: git appends to its HEAD log
// on every commit, checkout, reset and rebase step. Not the index, which a
// plain `git status` (this sweep's own) rewrites.
function lastUsed(admin: string): number {
  let last = 0;
  for (const f of [path.join(admin, 'logs', 'HEAD'), path.join(admin, 'HEAD'), path.join(admin, BORROW_FILE)]) {
    try {
      last = Math.max(last, fs.statSync(f).mtimeMs);
    } catch {
      // Not there.
    }
  }
  return last;
}

function readHead(admin: string): string | undefined {
  try {
    return fs.readFileSync(path.join(admin, 'HEAD'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: there, but someone else's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Every process's current folder (this user's, which is whose would be
// working in a borrow). /proc on Linux; lsof elsewhere.
export function processCwds(): Promise<string[] | undefined> {
  if (process.platform === 'linux') {
    try {
      const out: string[] = [];
      for (const p of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(p)) continue;
        try {
          out.push(fs.readlinkSync(`/proc/${p}/cwd`));
        } catch {
          // Gone, or not ours.
        }
      }
      return Promise.resolve(out);
    } catch {
      return Promise.resolve(undefined);
    }
  }
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('lsof', ['-n', '-P', '-d', 'cwd', '-Fn'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      // lsof exits 1 when some process couldn't be read; its output still counts.
      if (err && !stdout) return resolve(undefined);
      resolve(String(stdout).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)));
    });
  });
}
