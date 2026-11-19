// The slow parts of patch trust, run in a worker thread so they don't hold
// up the runner's main thread (trust-worker.ts is the worker's side).
//
// On 19 Nov the live runner's main thread was 70 to 83% busy and app
// requests waited up to 12 s (tb profile). Each thread's patch list is read
// every 15 s, and every turn's end makes it read again, and most of the time
// went on two synchronous looks: what a folder's Claude Code settings,
// agents and skills run (claude-trust.ts claudeCommands, a git listing or a
// walk of up to 20,000 folders: 1.5 s for ~/dev/me/misc, which isn't a git
// checkout and had 23 threads), and what a home patch run from each thread's
// folder reaches (unhashed-scan.ts). The same code runs here, so the answers
// are the same; only the thread it runs on changes.
//
// Two lanes, each a worker of its own: `urgent` for the look a message
// waits on before its CLI starts, `background` for the patch list. The
// background lane shares a look already under way for the same folder;
// the urgent one never does, as a pull just before the message may have
// brought hooks the earlier look missed.
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { claudeCommands, type ClaudeCommands } from './claude-trust.ts';
import { codeOfUnhashedPatch, type UnsureWhy } from './unhashed-scan.ts';

export type TrustRequest = { id: number } & (
  | { kind: 'claudeCommands'; cwd: string; home: string; grants: boolean }
  | { kind: 'editsAsk'; file: string; from: string; now: number }
);
export type TrustReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
type Ask = TrustRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export type EditsAsk = { all: boolean; why?: UnsureWhy };
export type Lane = 'urgent' | 'background';

// A look that takes longer than this (a hung disk, a fifo) is given up on
// and its worker replaced.
export const TRUST_CALL_TIMEOUT_MS = 120_000;

// The same call on this thread: when no worker can be had.
function inline(ask: Ask): unknown {
  if (ask.kind === 'claudeCommands') return claudeCommands(ask.cwd, ask.home, { grants: ask.grants });
  const scan = codeOfUnhashedPatch(ask.file, ask.from, ask.now);
  return { all: scan.all, ...(scan.why ? { why: scan.why } : {}) };
}

class WorkerFailed extends Error {}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class OneWorker {
  private worker?: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private timeoutMs: number;
  private script: URL;
  constructor(timeoutMs: number, script: URL) {
    this.timeoutMs = timeoutMs;
    this.script = script;
  }

  call(ask: Ask): Promise<unknown> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Whatever it's stuck on, the calls queued behind it would wait too.
        this.fail(worker, new Error(`Looking at ${ask.kind === 'claudeCommands' ? ask.cwd : ask.file} took over ${Math.round(this.timeoutMs / 1000)} s.`));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      // Held open while it has work: an unreferenced worker's reply never
      // comes if nothing else keeps the process going.
      if (this.pending.size === 1) worker.ref();
      worker.postMessage({ ...ask, id } satisfies TrustRequest);
    });
  }

  close(): void {
    if (this.worker) this.fail(this.worker, new WorkerFailed('closed'));
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    // The runner's environment as it is at each call (HOME, a test's change).
    const worker = new Worker(this.script, { env: SHARE_ENV });
    // Never what keeps the runner (or a test) from exiting.
    worker.unref();
    worker.on('message', (r: TrustReply) => {
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (this.pending.size === 0) worker.unref();
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error));
    });
    worker.on('error', (e) => this.fail(worker, new WorkerFailed(String(e))));
    worker.on('exit', () => this.fail(worker, new WorkerFailed('the trust worker exited')));
    this.worker = worker;
    return worker;
  }

  private fail(worker: Worker, e: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    void worker.terminate().catch(() => undefined);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  }
}

export class TrustOffThread {
  private lanes: Record<Lane, OneWorker>;
  private shared = new Map<string, Promise<unknown>>();
  // script: the worker's code (tests give one that never answers).
  constructor(o: { timeoutMs?: number; script?: URL } = {}) {
    const ms = o.timeoutMs ?? TRUST_CALL_TIMEOUT_MS;
    const script = o.script ?? new URL('./trust-worker.ts', import.meta.url);
    this.lanes = { urgent: new OneWorker(ms, script), background: new OneWorker(ms, script) };
  }

  claudeCommands(cwd: string, home: string, grants: boolean, lane: Lane): Promise<ClaudeCommands | undefined> {
    return this.ask({ kind: 'claudeCommands', cwd, home, grants }, lane) as Promise<ClaudeCommands | undefined>;
  }

  editsAsk(file: string, from: string, now: number): Promise<EditsAsk> {
    return this.ask({ kind: 'editsAsk', file, from, now }, 'background') as Promise<EditsAsk>;
  }

  // Calls from now on don't share a look begun before (forgetFolders: what
  // it read may be from before the change).
  forget(): void {
    this.shared.clear();
  }

  close(): void {
    this.lanes.urgent.close();
    this.lanes.background.close();
  }

  private ask(ask: Ask, lane: Lane): Promise<unknown> {
    if (lane === 'urgent') return this.run(ask, lane);
    // `now` only bounds how old a cached scan may be: not part of the key.
    const key = JSON.stringify(ask.kind === 'editsAsk' ? [ask.kind, ask.file, ask.from] : ask);
    const going = this.shared.get(key);
    if (going) return going;
    const p = this.run(ask, lane).finally(() => {
      if (this.shared.get(key) === p) this.shared.delete(key);
    });
    this.shared.set(key, p);
    return p;
  }

  private async run(ask: Ask, lane: Lane): Promise<unknown> {
    try {
      return await this.lanes[lane].call(ask);
    } catch (e) {
      // No worker to be had: as before, on this thread.
      if (e instanceof WorkerFailed) return inline(ask);
      throw e;
    }
  }
}

