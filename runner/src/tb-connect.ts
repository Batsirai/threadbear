// How tb reaches the runner. Inside a thread that's with the thread's own key
// (docs/protocol/connection.md, "A thread's own key"), never the token. Outside one, or
// pointed at another runner's data dir (a dev runner, whose token it reads and
// whose threads it doesn't belong to), it's that data dir's token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { psTable } from './proc.ts';
import { DEFAULT_PORT, defaultHome, paths, readRunnerJson, readToken, runnerUrl, type Config } from './config.ts';
import os from 'node:os';
import { procTable } from './peer.ts';
import { ErrorCode } from './protocol.ts';
import { RunnerClient, type RunnerClientOptions } from './client.ts';
import { isThreadId, isThreadKey, threadKey } from './rpc-auth.ts';

// Links followed: THREADBEAR_HOME through a link is still this runner.
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const sameDir = (a: string, b: string) => real(a) === real(b);

export type TbCredential = { token: string; threadId?: string };

export function tbCredential(home: string, env: NodeJS.ProcessEnv = process.env): TbCredential {
  const key = env.THREADBEAR_THREAD_KEY;
  const threadId = env.THREADBEAR_THREAD_ID;
  if (isThreadKey(key) && threadId && sameDir(env.THREADBEAR_RUNNER_HOME ?? home, home)) return { token: key, threadId };
  return { token: readToken(home) };
}

const options = (c: TbCredential, opts: RunnerClientOptions): RunnerClientOptions => ({ ...opts, ...(c.threadId ? { threadId: c.threadId } : {}) });

export function connectTb(cfg: Config, url: string = runnerUrl(cfg), opts: RunnerClientOptions = {}): Promise<RunnerClient> {
  const c = tbCredential(cfg.home);
  return RunnerClient.connect(url, c.token, options(c, opts));
}

// For a caller that drives `opened` itself, with its own timeout.
export function newTbClient(cfg: Config, url: string = runnerUrl(cfg), opts: RunnerClientOptions = {}): RunnerClient {
  const c = tbCredential(cfg.home);
  return new RunnerClient(url, c.token, options(c, opts));
}

// Who is running this tb, going by its own environment and its parents'
// (Daybreak finding 174): under a thread's CLI (every thread key found on
// the way up, each with the thread ids beside it), under none, or can't
// tell. A thread's shell can wipe its own environment but not its CLI's, so
// the walk reads each parent's. Every look uses a fixed program or /proc,
// never PATH, and one that fails makes the answer `unresolved`, never "under
// none". Windows can't read another process's environment: unresolved.
// `unresolved` keeps the keys found before the look failed: tb's own
// environment's at least.
export type TbCaller = { kind: 'thread'; keys: ThreadKeyFound[] } | { kind: 'owner' } | { kind: 'unresolved'; why: string; keys: ThreadKeyFound[] };
type ThreadKeyFound = { key: string; ids: string[] };

export type CallerDeps = {
  table?: () => Promise<{ pid: number; ppid: number; pgid?: number; sid?: number }[]>;
  self?: number;
  // A process's environment as text: Linux's /proc entries, a Mac's `ps eww`
  // line. Throws if it can't be read.
  envOf?: (pid: number) => string;
  platform?: NodeJS.Platform;
  ppid?: number;
};

const KEY_IN_TEXT = /(?:^|[\s\0])THREADBEAR_THREAD_KEY=([0-9a-f]{64})(?=[\s\0]|$)/g;
const ID_IN_TEXT = /(?:^|[\s\0])THREADBEAR_THREAD_ID=([\w:.-]{1,128})(?=[\s\0]|$)/g;

export async function tbCaller(env: NodeJS.ProcessEnv = process.env, deps: CallerDeps = {}): Promise<TbCaller> {
  const keys: ThreadKeyFound[] = [];
  if (isThreadKey(env.THREADBEAR_THREAD_KEY)) keys.push({ key: env.THREADBEAR_THREAD_KEY, ids: env.THREADBEAR_THREAD_ID ? [env.THREADBEAR_THREAD_ID] : [] });
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32' && !deps.envOf) return { kind: 'unresolved', why: "Windows can't show another process's environment", keys };
  const envOf = deps.envOf ?? (platform === 'linux' ? linuxEnv : psEnv);
  try {
    const rows: { pid: number; ppid: number; pgid?: number; sid?: number }[] = await (deps.table ?? (platform === 'linux' ? () => procTable() : psTable))();
    const parents = new Map(rows.map((r) => [r.pid, r.ppid]));
    const seen = new Set<number>();
    const look = (p: number) => {
      if (!parents.has(p)) throw new Error(`process ${p} isn't in the process table`);
      seen.add(p);
      const text = envOf(p);
      const ids = [...text.matchAll(ID_IN_TEXT)].map((m) => m[1]);
      for (const m of text.matchAll(KEY_IN_TEXT)) keys.push({ key: m[1], ids });
    };
    for (let p: number | undefined = deps.ppid ?? process.ppid; p !== undefined && p > 1 && !seen.has(p); p = parents.get(p)) look(p);
    // A process that left its parents behind (backgrounded, its shell gone)
    // keeps its process group, and on Linux its session: a thread's tool
    // command's and its CLI's (Gemini's second review). Their leaders are
    // looked at too; one that's gone is no answer. Only a process that sets
    // up a group and session of its own gets past this, as with the runner's
    // own look (SECURITY.md).
    const self = deps.self ?? process.pid;
    const me = rows.find((r) => r.pid === self);
    if (!me) throw new Error(`this process (${self}) isn't in the process table`);
    for (const leader of [me.pgid, me.sid]) if (leader !== undefined && leader > 1 && leader !== self && !seen.has(leader)) look(leader);
  } catch (e) {
    return { kind: 'unresolved', why: String((e as Error)?.message ?? e), keys };
  }
  return keys.length ? { kind: 'thread', keys } : { kind: 'owner' };
}

// A Mac's: /bin/ps, never one found on PATH. A process of another user
// shows no environment, as none of a thread's processes are.
function psEnv(pid: number): string {
  const out = execFileSync('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!out.trim()) throw new Error(`ps showed nothing for process ${pid}`);
  return out;
}

// Linux's, exactly as the process got it. One of another user's can't be
// read, and isn't a thread's: those run as this user.
function linuxEnv(pid: number): string {
  try {
    return '\0' + fs.readFileSync(`/proc/${pid}/environ`, 'latin1') + '\0';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if ((code === 'EACCES' || code === 'EPERM') && fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) return '';
    throw e;
  }
}

// Whether this data dir's secrets are its own: the folder and everything in
// it (to three levels) neither a symlink nor a file with another hard link.
// A stand-in data dir can't then hold the real token or Convex key without
// reading them, so a runner that proves this token is the real one, not
// one a thread started on a copy that links to them (Codex's review of
// finding 174). Threadbear never links its secrets itself.
export function ownSecrets(home: string): boolean {
  const walk = (p: string, depth: number): boolean => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      // No secrets folder at all: nothing in it to borrow.
      return depth === 0 && (e as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) return st.nlink === 1;
    if (!st.isDirectory()) return false;
    if (depth >= 3) return true;
    let names: string[];
    try {
      names = fs.readdirSync(p);
    } catch {
      return false;
    }
    return names.every((n) => walk(path.join(p, n), depth + 1));
  };
  return walk(paths.secrets(home), 0);
}

const sameKey = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type OwnerOnlyDeps = CallerDeps & { connect?: (url: string, token: string) => Promise<RunnerClient> };

// The data dir a runner keeps by default for this user: from the account's
// own home (the password database), not $HOME, which the caller sets.
function realDefaultHome(): string {
  return real(defaultHome(os.userInfo().homedir));
}

// Why tb's commands that use this Mac's keys straight from disk (tb runner)
// shouldn't run here, or undefined if they may: they don't go through the
// RPC, so the runner can't refuse them itself (Daybreak finding 174, and
// three rounds of Codex's and Gemini's reviews).
// - A terminal (no thread key in tb's environment, its parents', its process
//   group leader's or, on Linux, its session leader's): asks the runner at
//   the port in its runner.json whether it's a limited thread after all, and
//   goes ahead if it says not, or if nothing at all is listening there (the
//   runner stopped). A runner that's there and won't answer is refused.
// - Anything else (in a thread, or can't tell: a look failing, always on
//   Windows): only with the default data dir, whose secrets are its own (no
//   links), so the token and keys are the runner's own and a stand-in data
//   dir, or a file swapped into one, can't take part. That runner, proved by
//   its token, must place the connection itself and say it isn't limited;
//   no answer is refused. With a thread key found, it must also name a
//   thread, and every key must be one this token made.
// THREADBEAR_URL and THREADBEAR_PORT aren't taken: the caller sets them.
export async function ownerOnly(cfg: Config, env: NodeJS.ProcessEnv = process.env, deps: OwnerOnlyDeps & { defaultHome?: string } = {}): Promise<string | undefined> {
  const who = await tbCaller(env, deps);
  const terminal = who.kind === 'owner';
  const keys = who.kind === 'owner' ? [] : who.keys;
  const cant =
    keys.length
      ? "This needs Full access and the runner can't be asked whether this thread has it."
      : who.kind === 'unresolved'
        ? `This uses the runner's own keys, so it has to know it isn't in a limited thread. It couldn't tell (${who.why}), and the runner couldn't be asked. Run it from a terminal with the runner going.`
        : "This uses the runner's own keys, and the runner didn't answer whether this is a limited thread. Try again, or stop the runner first.";
  let token = '';
  try {
    token = readToken(cfg.home);
  } catch {
    // No token yet: a terminal on a new runner; anything else is refused below.
  }
  if (!terminal) {
    if (real(cfg.home) !== (deps.defaultHome ? real(deps.defaultHome) : realDefaultHome())) return "From a thread's shell (or where tb can't tell it isn't one), tb runner only uses the runner's own data folder, not one named with THREADBEAR_HOME.";
    if (!token || !ownSecrets(cfg.home)) return "The runner's secrets folder isn't as Threadbear made it (missing, or a link in it), so tb runner won't use it from here.";
    if (!keys.every((k) => k.ids.some((id) => isThreadId(id) && sameKey(threadKey(token, id), k.key)))) {
      return "This is a thread's shell and tb isn't pointed at that thread's own runner, so it can't use a runner's keys from here.";
    }
  }
  const url = `ws://127.0.0.1:${readRunnerJson(cfg.home).port || DEFAULT_PORT}/rpc`;
  let client: RunnerClient;
  try {
    client = await (deps.connect ?? ((u, t) => RunnerClient.connect(u, t)))(url, token);
  } catch (e) {
    return terminal && (e as NodeJS.ErrnoException)?.code === 'ECONNREFUSED' ? undefined : cant;
  }
  try {
    const whoami = await client.call<{ threadId?: string; limited?: boolean; mode?: string }>('auth.whoami');
    if (whoami.limited) return `This thread is on ${whoami.mode}, and this command uses the runner's own keys. Ask the user to run it from a terminal.`;
    // The runner must see the thread this tb is under, on Full access.
    if (keys.length && !whoami.threadId) return cant;
    return undefined;
  } catch (e) {
    // An older runner has no auth.whoami: fine from a terminal, not otherwise.
    return terminal && (e as { code?: unknown })?.code === ErrorCode.methodNotFound ? undefined : cant;
  } finally {
    client.close();
  }
}
