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
  // One look per kind of thread (grants or not), one after the other.
  | { kind: 'claudeCommands'; cwd: string; home: string; grants: boolean[] }
  | { kind: 'editsAsk'; file: string; from: string; now: number }
);
// `ready`: sent once, when the worker's code has loaded.
export type TrustReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } | { ready: true };
type Ask = TrustRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export type EditsAsk = { all: boolean; why?: UnsureWhy };
export type Lane = 'urgent' | 'background';

// A look that takes longer than this once it has started (a hung disk, a
// FIFO) is given up on and its worker replaced.
export const TRUST_CALL_TIMEOUT_MS = 120_000;

// The same call on this thread: when no worker can be started here at all.
function inline(ask: Ask): unknown {
  if (ask.kind === 'claudeCommands') return ask.grants.map((grants) => claudeCommands(ask.cwd, ask.home, { grants }));
  const scan = codeOfUnhashedPatch(ask.file, ask.from, ask.now);
  return { all: scan.all, ...(scan.why ? { why: scan.why } : {}) };
}

type Call = { ask: Ask; resolve: (v: unknown) => void; reject: (e: Error) => void };

// What a call looks at: the folder, or the patch file.
function whatOf(ask: Ask): string {
  return ask.kind === 'claudeCommands' ? ask.cwd : ask.file;
}

// One worker, given one call at a time from a queue here, so a call's time
// limit runs from when it starts and a call that hangs or crashes the
// worker fails alone: the calls behind it go to a new worker.
class OneWorker {
  private worker?: Worker;
  // Whether this worker's code has loaded (it says so): one that never
  // does means workers can't run here, and the calls run on this thread as
  // they did before.
  private ready = false;
  private queue: Call[] = [];
  private current?: { call: Call; id: number; timer: NodeJS.Timeout };
  private nextId = 1;
  private closed = false;
  // Workers given up on mid-look, by what they were looking at, until they
  // exit. One stuck in a read the OS won't let go of (a FIFO, a hung mount)
  // never does, so further looks there fail at once rather than leave
  // another stuck worker each time (Codex's review).
  private stuck = new Map<string, Worker>();
  private timeoutMs: number;
  private script: URL;
  constructor(timeoutMs: number, script: URL) {
    this.timeoutMs = timeoutMs;
    this.script = script;
  }

  call(ask: Ask): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The trust worker is closed.'));
    const stuck = this.stuckOn(ask);
    if (stuck) return Promise.reject(stuck);
    return new Promise((resolve, reject) => {
      this.queue.push({ ask, resolve, reject });
      this.next();
    });
  }

  close(): void {
    this.closed = true;
    const calls = [...(this.current ? [this.current.call] : []), ...this.queue];
    this.queue = [];
    this.drop();
    for (const c of calls) c.reject(new Error('The trust worker is closed.'));
  }

  private next(): void {
    if (this.current || !this.queue.length || this.closed) return;
    const worker = this.start();
    // Held open while it has work: an unreferenced worker's reply never
    // comes if nothing else keeps the process going.
    worker.ref();
    // Nothing goes to it until its code has loaded and it says so, so a
    // worker that stops before then never had a call that could be why.
    if (!this.ready) return;
    const call = this.queue.shift()!;
    // Queued before a look there got stuck.
    const stuck = this.stuckOn(call.ask);
    if (stuck) {
      call.reject(stuck);
      this.next();
      return;
    }
    const id = this.nextId++;
    const what = whatOf(call.ask);
    const timer = setTimeout(() => {
      this.stuck.set(what, worker);
      worker.once('exit', () => {
        if (this.stuck.get(what) === worker) this.stuck.delete(what);
      });
      this.failCurrent(new Error(`Looking at ${what} took over ${Math.round(this.timeoutMs / 1000)} s.`));
    }, this.timeoutMs);
    timer.unref();
    this.current = { call, id, timer };
    worker.postMessage({ ...call.ask, id } satisfies TrustRequest);
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    // The runner's environment as it is at each call (HOME, a test's change).
    const worker = new Worker(this.script, { env: SHARE_ENV });
    worker.unref();
    // A worker that hasn't loaded in this long counts as one that can't.
    const loading = setTimeout(() => {
      if (this.worker === worker && !this.ready) this.crashed(new Error("the trust worker didn't load"));
    }, this.timeoutMs);
    loading.unref();
    worker.on('message', (r: TrustReply) => {
      if ('ready' in r) {
        clearTimeout(loading);
        if (this.worker !== worker) return;
        this.ready = true;
        this.next();
        return;
      }
      const cur = this.current;
      if (this.worker !== worker || !cur || cur.id !== r.id) return;
      clearTimeout(cur.timer);
      this.current = undefined;
      worker.unref();
      if (r.ok) cur.call.resolve(r.value);
      else cur.call.reject(new Error(r.error));
      this.next();
    });
    worker.on('error', (e: unknown) => {
      if (this.worker === worker) this.crashed(e instanceof Error ? e : new Error(String(e)));
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.crashed(new Error('the trust worker exited'));
    });
    this.worker = worker;
    return worker;
  }

  // A worker that never loaded (and so never had a call): everything
  // waiting runs on this thread, as it did before there were workers. One
  // that loaded and then died (a crash, out of memory) fails only the call
  // it was on, which would likely do the same on this thread; the rest go
  // to a new worker.
  private crashed(e: Error): void {
    if (!this.ready) {
      const calls = [...this.queue];
      this.queue = [];
      this.drop();
      for (const c of calls) {
        try {
          c.resolve(inline(c.ask));
        } catch (err) {
          c.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return;
    }
    this.failCurrent(new Error(`The trust worker stopped: ${e.message}`));
  }

  // The call under way fails; its worker goes, and the next call gets a new one.
  private stuckOn(ask: Ask): Error | undefined {
    const what = whatOf(ask);
    return this.stuck.has(what) ? new Error(`An earlier look at ${what} is still stuck, so it can't be looked at yet.`) : undefined;
  }

  private failCurrent(e: Error): void {
    const cur = this.current;
    this.current = undefined;
    if (cur) clearTimeout(cur.timer);
    this.drop();
    cur?.call.reject(e);
    this.next();
  }

  private drop(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    if (worker) void worker.terminate().catch(() => undefined);
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

  // What the folder's Claude Code settings run for each kind of thread
  // (grants or not), looked at one after the other.
  claudeCommands(cwd: string, home: string, grants: boolean[], lane: Lane): Promise<(ClaudeCommands | undefined)[]> {
    return this.ask({ kind: 'claudeCommands', cwd, home, grants }, lane) as Promise<(ClaudeCommands | undefined)[]>;
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

  private run(ask: Ask, lane: Lane): Promise<unknown> {
    return this.lanes[lane].call(ask);
  }

}

