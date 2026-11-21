// How much a thread below Full access may put in the runner's inbox through
// media.import (Daybreak finding 157). The call is open to every thread's key
// so `tb send --image` works from an Ask thread, but each import is a write
// (and maybe a conversion), so it's metered: refused before any copying once
// the thread, or all such threads together, have used the day's allowance, or
// while that thread already has one running. The file is opened once, and
// that one open file is what's measured, keyed and copied, so it can't be
// swapped or grown in between. A converted picture counts at its real size.
// The same file imported again by the same thread (same file, size and change
// time) gives back the copy it already made, for nothing.
//
// What such a thread then sends or starts a thread with may only be pictures
// it imported itself, each once (take): otherwise threads.send could copy any
// file into a thread's media, unmetered, as often as it liked.
//
// Full-access threads and the runner's own token aren't metered: they can
// already write anything on the Mac. The counts are kept in memory, so a
// runner restart starts them afresh; nothing below Full can restart it.
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, RpcError, type ImageRef } from './protocol.ts';
import { importOpened, openForImport } from './media.ts';

const DAY_MS = 86_400_000;

export type ImportLimits = { files: number; bytes: number };

export const PER_THREAD: ImportLimits = { files: 100, bytes: 512 * 1024 * 1024 };
export const ALL_THREADS: ImportLimits = { files: 400, bytes: 2 * 1024 * 1024 * 1024 };
// Imports running at once, across the threads metered here.
const MAX_RUNNING = 2;
// Sources remembered for giving back an earlier copy.
const MAX_REMEMBERED = 256;
// Pictures one message or new thread may carry from such a thread.
export const MAX_IMAGES_PER_SEND = 10;

type Spent = { threadId: string; at: number; bytes: number };

const bad = (message: string) => new RpcError(ErrorCode.badParams, message);

export class ImportQuota {
  private spent: Spent[] = [];
  private running = new Set<string>();
  private copies = new Map<string, ImageRef>();
  // Inbox files a metered thread imported and hasn't sent yet: path -> thread.
  private made = new Map<string, string>();
  private readonly now: () => number;
  private readonly perThread: ImportLimits;
  private readonly all: ImportLimits;

  constructor(opts: { now?: () => number; perThread?: ImportLimits; all?: ImportLimits } = {}) {
    this.now = opts.now ?? Date.now;
    this.perThread = opts.perThread ?? PER_THREAD;
    this.all = opts.all ?? ALL_THREADS;
  }

  // Imports `src` into `dir` for `threadId` if the allowance has room,
  // counting it whether or not it succeeds (a failed conversion still cost
  // the work). Throws -32602, having copied nothing, otherwise.
  async run(threadId: string, src: string, dir: string): Promise<ImageRef> {
    const opened = await openForImport(src).catch((e: Error) => {
      throw bad(e.message);
    });
    try {
      const { st } = opened;
      // Per thread, so one thread can't leave a copy another is handed.
      const key = `${threadId}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      const earlier = this.copies.get(key);
      if (earlier && this.made.get(path.resolve(earlier.path)) === threadId && fs.existsSync(earlier.path)) return { ...earlier };
      if (this.running.has(threadId)) throw bad('This thread is already adding a picture; wait for it to finish');
      if (this.running.size >= MAX_RUNNING) throw bad('Too many threads are adding pictures right now; try again in a moment');
      const cutoff = this.now() - DAY_MS;
      this.spent = this.spent.filter((s) => s.at > cutoff);
      const mine = this.spent.filter((s) => s.threadId === threadId);
      const sum = (xs: Spent[]) => xs.reduce((n, s) => n + s.bytes, 0);
      const roomMine = this.perThread.bytes - sum(mine);
      const roomAll = this.all.bytes - sum(this.spent);
      if (mine.length + 1 > this.perThread.files || st.size > roomMine) {
        throw bad(`This thread has added its pictures for today (${this.perThread.files} files or ${Math.round(this.perThread.bytes / 1024 / 1024)} MB a day below Full access); try again later`);
      }
      if (this.spent.length + 1 > this.all.files || st.size > roomAll) {
        throw bad('Threads below Full access have added their pictures for today; try again later');
      }
      const entry: Spent = { threadId, at: this.now(), bytes: st.size };
      this.spent.push(entry);
      this.running.add(threadId);
      try {
        const ref = await importOpened(dir, opened, { maxOut: Math.min(roomMine, roomAll) }).catch((e: Error) => {
          throw bad(e.message);
        });
        // A converted picture counts at whichever is bigger.
        entry.bytes = Math.max(entry.bytes, (await fs.promises.stat(ref.path)).size);
        this.made.set(path.resolve(ref.path), threadId);
        this.copies.set(key, { ...ref });
        if (this.copies.size > MAX_REMEMBERED) this.copies.delete(this.copies.keys().next().value!);
        return ref;
      } finally {
        this.running.delete(threadId);
      }
    } finally {
      await opened.fh.close();
    }
  }

  // The pictures a metered thread's message or new thread carries: each must
  // be one it imported and hasn't sent, and it's used up here. Throws -32602
  // otherwise, taking none.
  take(threadId: string, images: unknown): void {
    if (images === undefined || images === null) return;
    if (!Array.isArray(images)) throw bad('images must be an array');
    if (images.length > MAX_IMAGES_PER_SEND) throw bad(`At most ${MAX_IMAGES_PER_SEND} pictures at once from a thread below Full access`);
    const paths = images.map((img) => {
      const p = img && typeof img === 'object' && typeof (img as ImageRef).path === 'string' ? path.resolve((img as ImageRef).path) : undefined;
      if (!p || this.made.get(p) !== threadId) throw bad(`A thread below Full access sends only pictures it added with media.import (tb send --image), each once: ${p ? path.basename(p) : 'a picture'}`);
      return p;
    });
    if (new Set(paths).size !== paths.length) throw bad('The same picture twice in one message');
    for (const p of paths) this.forget(p);
  }

  // An import whose caller had gone by the time it finished: nobody has its
  // path, so it goes now rather than in a week (it stays counted).
  discard(ref: ImageRef): void {
    const p = path.resolve(ref.path);
    this.forget(p);
    fs.rmSync(p, { force: true });
  }

  private forget(p: string): void {
    this.made.delete(p);
    for (const [k, ref] of this.copies) if (path.resolve(ref.path) === p) this.copies.delete(k);
  }
}
