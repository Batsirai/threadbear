// How much a thread below Full access may put in the runner's inbox through
// media.import (Daybreak finding 157). The call is open to every thread's key
// so `tb send --image` works from an Ask thread, but each import is a write
// (and maybe a conversion), so it's metered: refused before any work once the
// thread, or all such threads together, have used the day's allowance, or
// while that thread already has one running. The same file imported again
// by the same thread (same file, size and change time) gives back the copy it
// already made, for nothing. Full-access threads and the runner's own token
// aren't metered: they can already write anything on the Mac.
//
// The counts are kept in memory, so a runner restart starts them afresh;
// nothing below Full can restart the runner.
import fs from 'node:fs';
import { ErrorCode, RpcError, type ImageRef } from './protocol.ts';

const DAY_MS = 86_400_000;

export type ImportLimits = { files: number; bytes: number };

export const PER_THREAD: ImportLimits = { files: 100, bytes: 512 * 1024 * 1024 };
export const ALL_THREADS: ImportLimits = { files: 400, bytes: 2 * 1024 * 1024 * 1024 };
// Imports running at once, across the threads metered here.
const MAX_RUNNING = 4;
// Sources remembered for giving back an earlier copy.
const MAX_REMEMBERED = 256;

type Spent = { threadId: string; at: number; bytes: number };

export class ImportQuota {
  private spent: Spent[] = [];
  private running = new Set<string>();
  private copies = new Map<string, ImageRef>();
  private readonly now: () => number;
  private readonly perThread: ImportLimits;
  private readonly all: ImportLimits;

  constructor(opts: { now?: () => number; perThread?: ImportLimits; all?: ImportLimits } = {}) {
    this.now = opts.now ?? Date.now;
    this.perThread = opts.perThread ?? PER_THREAD;
    this.all = opts.all ?? ALL_THREADS;
  }

  // Runs `work` for `threadId` if the allowance has room for a file of
  // `src`'s size, counting it whether or not it succeeds (a failed conversion
  // still cost the work). Throws -32602 before calling `work` otherwise.
  async run(threadId: string, src: string, work: () => Promise<ImageRef>): Promise<ImageRef> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(src);
    } catch {
      throw new RpcError(ErrorCode.badParams, `File not found: ${src}`);
    }
    // Per thread, so one thread can't leave a copy another is handed.
    const key = `${threadId}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    const earlier = this.copies.get(key);
    if (earlier && fs.existsSync(earlier.path)) return { ...earlier };
    if (this.running.has(threadId)) throw new RpcError(ErrorCode.badParams, 'This thread is already adding a picture; wait for it to finish');
    if (this.running.size >= MAX_RUNNING) throw new RpcError(ErrorCode.badParams, 'Too many threads are adding pictures right now; try again in a moment');
    const cutoff = this.now() - DAY_MS;
    this.spent = this.spent.filter((s) => s.at > cutoff);
    const mine = this.spent.filter((s) => s.threadId === threadId);
    const sum = (xs: Spent[]) => xs.reduce((n, s) => n + s.bytes, 0);
    const bytes = st.isFile() ? st.size : 0;
    if (mine.length + 1 > this.perThread.files || sum(mine) + bytes > this.perThread.bytes) {
      throw new RpcError(ErrorCode.badParams, `This thread has added its pictures for today (${this.perThread.files} files or ${Math.round(this.perThread.bytes / 1024 / 1024)} MB a day below Full access); try again later`);
    }
    if (this.spent.length + 1 > this.all.files || sum(this.spent) + bytes > this.all.bytes) {
      throw new RpcError(ErrorCode.badParams, 'Threads below Full access have added their pictures for today; try again later');
    }
    this.spent.push({ threadId, at: this.now(), bytes });
    this.running.add(threadId);
    try {
      const ref = await work();
      this.copies.set(key, { ...ref });
      if (this.copies.size > MAX_REMEMBERED) this.copies.delete(this.copies.keys().next().value!);
      return ref;
    } finally {
      this.running.delete(threadId);
    }
  }
}
