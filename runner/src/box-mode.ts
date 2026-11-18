// Box mode (docs/virtual-runners.md, decision 1; docs/protocol.md, "Box
// mode"): the whole runner, inside one provider machine (a Fly Machine) for
// one thread on a virtual runner. The provider starts it with only
// THREADBEAR_SYNC_URL and THREADBEAR_BOX_BOOT (a boot token, single use, 10
// minutes) in its environment, and THREADBEAR_MACHINE_ID_ENV naming the
// variable that holds the machine's own id. Before anything else the runner
// trades the boot token (boxes:exchange) for its box key, runner id, thread
// id, the login's cloud token, the thread's key and the repo, then clones
// the repo or restores the thread's last save (box-save.ts).
//
// Box mode is a convenience, not a boundary: the agent has a shell, and every
// limit that matters is the backend's (box keys, convex/runnerAccess.ts).
// What it turns off is listed in boxEnv and main.ts's `box` checks.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.ts';
import { atomicWriteFileSync, isDirectory } from './fsutil.ts';
import { safeEntryPath } from './move-pack.ts';
import { cloneRepo } from './move-git.ts';
import { isThreadIdShape } from './thread-id.ts';
import { TOKEN_FILE } from './year-token.ts';
import { git, realpath } from './worktrees.ts';
import { credentialUrlProblem } from './secure-url.ts';
import { openSave, restoreSave, SAVE_MAX_BYTES } from './box-save.ts';
import type { Logger } from './log.ts';

export const BOOT_ENV = 'THREADBEAR_BOX_BOOT';
// The variable holding the variable's name: the service sets it from the
// provider's machineIdEnv (convex/boxProviders/types.ts). A box started
// without it is taken to be on Fly.
export const MACHINE_ID_ENV = 'THREADBEAR_MACHINE_ID_ENV';
export const FALLBACK_MACHINE_ID_ENV = 'FLY_MACHINE_ID';
export const BOX_FILE = 'box.json';
// As the backend takes one (convex/lib.ts MACHINE_ID).
const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BOX_KEY = /^tbb_[0-9a-f]{64}$/;
const RUNNER_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A setup token as year-token.ts reads one: anything else would never reach the CLI.
const CLAUDE_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

export type BoxBoot = { bootToken: string; syncUrl: string; machineId?: string };
export type BoxRepo = { origin: string; subfolder: string; baseBranch: string };
export type BoxSaveRef = { url: string; at: number; bytes: number };
export type Exchanged = { boxKey: string; runnerId: string; threadId: string; claudeToken: string; threadKey: string; repo: BoxRepo; save: BoxSaveRef | null; login?: string };

// What the box keeps in its data dir's secrets (0600): enough to start
// again after its runner restarts, as the boot token works only once.
export type BoxSecrets = {
  version: 1;
  bootHash: string;
  syncUrl: string;
  machineId?: string;
  boxKey: string;
  runnerId: string;
  threadId: string;
  threadKey: string;
  repo: BoxRepo;
  login?: string;
  save: BoxSaveRef | null;
  // Once the thread's folder is ready (cloned, or restored from the save).
  prepared?: { checkout: string; cwd: string; restored: boolean };
};

export class BoxBootRefused extends Error {}

/** The boot, if this process was started as a box: undefined for any other runner. */
export function readBoxBoot(env: NodeJS.ProcessEnv): BoxBoot | undefined {
  const bootToken = env[BOOT_ENV]?.trim();
  if (!bootToken) return undefined;
  const syncUrl = env.THREADBEAR_SYNC_URL?.trim();
  if (!syncUrl) throw new BoxBootRefused(`${BOOT_ENV} is set but THREADBEAR_SYNC_URL isn't, so the box has no backend to boot from.`);
  const named = env[MACHINE_ID_ENV]?.trim();
  const id = env[named && ENV_NAME.test(named) ? named : FALLBACK_MACHINE_ID_ENV]?.trim();
  return { bootToken, syncUrl, ...(id && MACHINE_ID.test(id) ? { machineId: id } : {}) };
}

/**
 * The boot token out of this process's environment, so nothing the runner
 * starts (Claude Code, its shells, a worktree's setup) inherits it, and box
 * mode's limits through the variables the runner already reads: no
 * following main, no CLI updates (a new release is a new image), no Sentry,
 * no Mac screen. IS_SANDBOX: Claude Code runs as root in a box, which it
 * refuses with --dangerously-skip-permissions unless told it's in one.
 */
export function enterBoxEnv(env: NodeJS.ProcessEnv): void {
  delete env[BOOT_ENV];
  delete env.THREADBARE_BOX_BOOT;
  env.IS_SANDBOX = '1';
  env.THREADBEAR_FOLLOW_MAIN = '0';
  env.THREADBEAR_CLI_UPDATES = 'off';
  env.THREADBEAR_SENTRY = 'off';
  env.THREADBEAR_MAC_SCREEN = 'off';
  // A box is nothing without its sync.
  delete env.THREADBEAR_SYNC;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const boxFile = (home: string) => path.join(paths.secrets(home), BOX_FILE);

export function readBoxSecrets(home: string): BoxSecrets | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(boxFile(home), 'utf8')) as BoxSecrets;
    return s?.version === 1 && typeof s.boxKey === 'string' && typeof s.bootHash === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(file, text, 0o600);
  fs.chmodSync(file, 0o600);
}

export function writeBoxSecrets(home: string, s: BoxSecrets): void {
  writePrivate(boxFile(home), JSON.stringify(s, null, 2) + '\n');
}

// What the exchange gave, checked: it's the backend's word, but each value
// lands in a file name, a git argument or a credential.
function checkExchanged(v: unknown): Exchanged {
  const g = v as Partial<Exchanged> | null;
  const bad = (what: string) => new BoxBootRefused(`The boot exchange gave a ${what} this runner can't use.`);
  if (!g || typeof g !== 'object') throw bad('reply');
  if (typeof g.boxKey !== 'string' || !BOX_KEY.test(g.boxKey)) throw bad('box key');
  if (typeof g.runnerId !== 'string' || !RUNNER_ID.test(g.runnerId)) throw bad('runner id');
  if (!isThreadIdShape(g.threadId)) throw bad('thread id');
  if (typeof g.claudeToken !== 'string' || !CLAUDE_TOKEN.test(g.claudeToken)) throw bad('Claude token (not a setup token)');
  if (typeof g.threadKey !== 'string' || Buffer.from(g.threadKey, 'base64').length !== 32) throw bad('thread key');
  const r = g.repo;
  if (!r || typeof r.origin !== 'string' || !r.origin) throw bad('repo');
  if (typeof r.subfolder !== 'string' || (r.subfolder !== '' && !safeEntryPath(r.subfolder.replace(/\/+$/, '')))) throw bad('subfolder');
  if (typeof r.baseBranch !== 'string' || !BRANCH.test(r.baseBranch)) throw bad('base branch');
  const save = g.save;
  if (save !== null && (!save || typeof save.url !== 'string' || typeof save.bytes !== 'number')) throw bad('save');
  return {
    boxKey: g.boxKey,
    runnerId: g.runnerId,
    threadId: g.threadId,
    claudeToken: g.claudeToken,
    threadKey: g.threadKey,
    repo: { origin: r.origin, subfolder: r.subfolder.replace(/\/+$/, ''), baseBranch: r.baseBranch },
    save: save ? { url: save.url, at: Number(save.at) || 0, bytes: save.bytes } : null,
    ...(typeof g.login === 'string' && g.login ? { login: g.login } : {}),
  };
}

export type ActionPost = (kind: 'action' | 'mutation' | 'query', fn: string, args: Record<string, unknown>) => Promise<unknown>;

const kindOf = (e: unknown): unknown => (e as { data?: { kind?: unknown } } | null)?.data?.kind;

/**
 * boxes:exchange, tried again while it might still work: the network, a
 * deployment that can't unseal yet (`config`), a login with no cloud token
 * yet (`noCloudToken`) or a token set again meanwhile (`conflict`) all leave
 * the boot token as it was. A refusal (`auth`: used, expired or unknown)
 * never changes, and nor does past the boot token's 10 minutes.
 */
export async function exchangeBoot(o: { boot: BoxBoot; post: ActionPost; log: Logger; sleep?: (ms: number) => Promise<void>; now?: () => number; giveUpAfterMs?: number }): Promise<Exchanged> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (o.giveUpAfterMs ?? 10 * 60_000);
  let wait = 2_000;
  for (;;) {
    try {
      return checkExchanged(await o.post('action', 'boxes:exchange', { bootToken: o.boot.bootToken, ...(o.boot.machineId ? { machineId: o.boot.machineId } : {}) }));
    } catch (e) {
      if (e instanceof BoxBootRefused) throw e;
      const kind = kindOf(e);
      const said = String((e as Error)?.message ?? e);
      if (kind === 'auth' || kind === 'badArgs' || kind === 'forbidden') throw new BoxBootRefused(`The backend refused the box's boot token: ${said}`);
      if (now() + wait > until) throw new BoxBootRefused(`The box couldn't trade its boot token in time: ${said}`);
      o.log.warn('box: boot exchange failed, trying again', { kind: typeof kind === 'string' ? kind : undefined, error: said });
      await sleep(wait);
      wait = Math.min(wait * 2, 15_000);
    }
  }
}

/**
 * The box's first step. A runner that starts again on the same machine
 * (its process restarted) finds its secrets from the first start, under
 * the same boot token, and uses them: the token works only once.
 * Otherwise the exchange, then the box key, runner id, thread id, thread
 * key and repo into the data dir's secrets (box.json, and convex-key as
 * any runner's key), and the login's token into claude-main's
 * threadbear-token.json, which the runner already passes to that login's
 * CLI (year-token.ts). Each 0600.
 */
export async function bootBox(o: { boot: BoxBoot; home: string; claudeDir: string; post: ActionPost; log: Logger; sleep?: (ms: number) => Promise<void>; now?: () => number; giveUpAfterMs?: number }): Promise<BoxSecrets> {
  const bootHash = sha256(o.boot.bootToken);
  const kept = readBoxSecrets(o.home);
  if (kept?.bootHash === bootHash) {
    o.log.info('box: started again on the key it already has', { runnerId: kept.runnerId, threadId: kept.threadId });
    return kept;
  }
  const got = await exchangeBoot(o);
  const secrets: BoxSecrets = {
    version: 1,
    bootHash,
    syncUrl: o.boot.syncUrl,
    ...(o.boot.machineId ? { machineId: o.boot.machineId } : {}),
    boxKey: got.boxKey,
    runnerId: got.runnerId,
    threadId: got.threadId,
    threadKey: got.threadKey,
    repo: got.repo,
    ...(got.login ? { login: got.login } : {}),
    save: got.save,
  };
  writeBoxSecrets(o.home, secrets);
  writePrivate(path.join(paths.secrets(o.home), 'convex-key'), got.boxKey + '\n');
  writePrivate(path.join(o.claudeDir, TOKEN_FILE), JSON.stringify({ token: got.claudeToken, madeAt: new Date().toISOString() }) + '\n');
  o.log.info('box: traded its boot token', { runnerId: got.runnerId, threadId: got.threadId, machineId: o.boot.machineId, restoring: Boolean(got.save) });
  return secrets;
}

// The repo's folder name, from its origin ("threadbear" from
// https://github.com/mikecann/threadbear.git).
export function repoFolderName(origin: string): string {
  const last = origin.replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const name = last.replace(/\.git$/, '');
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.') ? name : 'repo';
}

export type Cloner = (url: string, to: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
export type Downloader = (url: string) => Promise<Buffer>;

// The last save, from file storage: https (or this machine), no redirects,
// no bigger than one upload can be.
export async function downloadSave(url: string, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  const problem = credentialUrlProblem(url);
  if (problem) throw new Error(`The save's URL ${problem}.`);
  const res = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`Couldn't download the thread's save: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > SAVE_MAX_BYTES) throw new Error("The thread's save is bigger than one can be.");
  return bytes;
}

/**
 * The thread's folder: the repo cloned into `workRoot` on its base branch
 * (and, with no save, that's all: the thread's `create` makes its worktree
 * as a new thread in that repo would, the repo's own patch trusted as the
 * runner's own checkout is), or the last save restored on top of the clone.
 * Done once per box: a runner that starts again finds it done.
 */
// `again`: done by an earlier start of this runner on the same machine.
export async function prepareBoxFolder(o: { secrets: BoxSecrets; home: string; claudeDir: string; workRoot: string; log: Logger; clone?: Cloner; download?: Downloader }): Promise<{ checkout: string; cwd: string; restored: boolean; again?: true }> {
  const s = o.secrets;
  if (s.prepared && isDirectory(s.prepared.cwd)) return { ...s.prepared, again: true };
  const checkout = path.join(o.workRoot, repoFolderName(s.repo.origin));
  // What a start that didn't finish left: made again from the start.
  fs.rmSync(checkout, { recursive: true, force: true });
  fs.rmSync(`${checkout}-threads`, { recursive: true, force: true });
  fs.rmSync(paths.thread(o.home, s.threadId), { recursive: true, force: true });
  fs.mkdirSync(o.workRoot, { recursive: true });
  const cloned = await (o.clone ?? cloneRepo)(s.repo.origin, checkout);
  if (!cloned.ok) throw new Error(cloned.reason);
  const top = realpath(checkout);
  const on = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!on.ok || on.stdout.trim() !== s.repo.baseBranch) {
    const sw = await git(top, ['checkout', '--quiet', s.repo.baseBranch, '--']);
    if (!sw.ok) throw new Error(`Couldn't check out ${s.repo.baseBranch} in ${s.repo.origin}: ${sw.stderr.trim().split('\n')[0] ?? 'git failed'}`);
  }
  let cwd = s.repo.subfolder ? path.join(top, ...s.repo.subfolder.split('/')) : top;
  let restored = false;
  if (s.save) {
    const sealed = await (o.download ?? downloadSave)(s.save.url);
    const packed = openSave(Buffer.from(s.threadKey, 'base64'), s.threadId, sealed);
    ({ cwd } = await restoreSave({ home: o.home, claudeDir: o.claudeDir, threadId: s.threadId, checkout: top, packed }));
    restored = true;
    o.log.info('box: restored the thread from its save', { threadId: s.threadId, savedAt: s.save.at, bytes: s.save.bytes, cwd });
  } else {
    if (!isDirectory(cwd)) throw new Error(`${s.repo.subfolder} isn't a folder in ${s.repo.origin}.`);
    o.log.info('box: cloned the repo', { origin: s.repo.origin, checkout: top });
  }
  s.prepared = { checkout: top, cwd, restored };
  writeBoxSecrets(o.home, s);
  return s.prepared;
}
