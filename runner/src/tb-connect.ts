// How tb reaches the runner. Inside a thread that's with the thread's own key
// (docs/protocol/connection.md, "A thread's own key"), never the token. Outside one, or
// pointed at another runner's data dir (a dev runner, whose token it reads and
// whose threads it doesn't belong to), it's that data dir's token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { psTable } from './proc.ts';
import { readToken, runnerUrl, type Config } from './config.ts';
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
export type TbCaller = { kind: 'thread'; keys: { key: string; ids: string[] }[] } | { kind: 'owner' } | { kind: 'unresolved'; why: string };

export type CallerDeps = {
  table?: () => Promise<{ pid: number; ppid: number }[]>;
  // A process's environment as text: Linux's /proc entries, a Mac's `ps eww`
  // line. Throws if it can't be read.
  envOf?: (pid: number) => string;
  platform?: NodeJS.Platform;
  ppid?: number;
};

const KEY_IN_TEXT = /(?:^|[\s\0])THREADBEAR_THREAD_KEY=([0-9a-f]{64})(?=[\s\0]|$)/g;
const ID_IN_TEXT = /(?:^|[\s\0])THREADBEAR_THREAD_ID=([\w:.-]{1,128})(?=[\s\0]|$)/g;

export async function tbCaller(env: NodeJS.ProcessEnv = process.env, deps: CallerDeps = {}): Promise<TbCaller> {
  const keys: { key: string; ids: string[] }[] = [];
  if (isThreadKey(env.THREADBEAR_THREAD_KEY)) keys.push({ key: env.THREADBEAR_THREAD_KEY, ids: env.THREADBEAR_THREAD_ID ? [env.THREADBEAR_THREAD_ID] : [] });
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32' && !deps.envOf) return { kind: 'unresolved', why: "Windows can't show another process's environment" };
  const envOf = deps.envOf ?? (platform === 'linux' ? linuxEnv : psEnv);
  try {
    const parents = new Map((await (deps.table ?? psTable)()).map((r) => [r.pid, r.ppid]));
    const seen = new Set<number>();
    for (let p: number | undefined = deps.ppid ?? process.ppid; p !== undefined && p > 1 && !seen.has(p); p = parents.get(p)) {
      if (!parents.has(p)) throw new Error(`process ${p} isn't in the process table`);
      seen.add(p);
      const text = envOf(p);
      const ids = [...text.matchAll(ID_IN_TEXT)].map((m) => m[1]);
      for (const m of text.matchAll(KEY_IN_TEXT)) keys.push({ key: m[1], ids });
    }
  } catch (e) {
    return { kind: 'unresolved', why: String((e as Error)?.message ?? e) };
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

const sameKey = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type OwnerOnlyDeps = CallerDeps & { connect?: (url: string, token: string) => Promise<RunnerClient> };

// Why tb's commands that use this Mac's keys straight from disk (tb runner)
// shouldn't run here, or undefined if they may: they don't go through the
// RPC, so the runner can't refuse them itself (Daybreak finding 174).
// - Can't tell who's calling: refused.
// - Under a thread: only with that thread's own runner's keys (every
//   thread key found must be one this data dir's token made, so a stand-in
//   data dir with a token of the thread's own making is no use), and only if
//   that runner, proved by the token over the challenge, says the thread is
//   on Full access. Unreachable is refused.
// - Under none (a terminal): fine, unless the runner, if it answers, says
//   this is a limited thread after all (one that left its parents behind).
// THREADBEAR_URL isn't taken: the runner is asked at its own address, and
// only the runner (or someone with its token) can prove the token there.
export async function ownerOnly(cfg: Config, env: NodeJS.ProcessEnv = process.env, deps: OwnerOnlyDeps = {}): Promise<string | undefined> {
  const who = await tbCaller(env, deps);
  if (who.kind === 'unresolved') return `This uses the runner's own keys, so it has to know it isn't in a limited thread, and it couldn't tell (${who.why}). Run it from a terminal with the runner going.`;
  let token = '';
  try {
    token = readToken(cfg.home);
  } catch {
    // No token yet: a terminal on a new runner; a thread is refused below.
  }
  const inThread = who.kind === 'thread';
  if (inThread && !(token && who.keys.every((k) => k.ids.some((id) => isThreadId(id) && sameKey(threadKey(token, id), k.key))))) {
    return "This is a thread's shell and tb isn't pointed at that thread's own runner, so it can't use a runner's keys from here.";
  }
  const cant = "This needs Full access and the runner can't be asked whether this thread has it.";
  let client: RunnerClient;
  try {
    client = await (deps.connect ?? ((url, t) => RunnerClient.connect(url, t)))(runnerUrl(cfg, {}), token);
  } catch {
    return inThread ? cant : undefined;
  }
  try {
    const whoami = await client.call<{ threadId?: string; limited?: boolean; mode?: string }>('auth.whoami');
    if (whoami.limited) return `This thread is on ${whoami.mode}, and this command uses the runner's own keys. Ask the user to run it from a terminal.`;
    // The runner must see the thread this tb is under, on Full access.
    if (inThread && !whoami.threadId) return cant;
    return undefined;
  } catch {
    // An older runner has no auth.whoami: fine from a terminal, not from a thread.
    return inThread ? cant : undefined;
  } finally {
    client.close();
  }
}
