// Replies from threads this Mac started on other runners, passed back to the
// thread that started them (docs/protocol.md, "Asking another runner",
// "Reporting back").
//
// The main Mac's create_thread with a runner starts the thread there through
// the relay. A runner on a runner key (the Pixel, the cloud) can't message
// this Mac's threads, so the started thread's send_message to its starter
// said "No thread" and its report never came (20 Nov 2026). This Mac can
// read that thread, so it watches its row in the sidebar's list and, each
// time a turn there ends, sends the reply it ended with to the starter, as
// an agent's message. The started thread is told so in its first line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteFileSync } from './fsutil.ts';
import { AGENT_MESSAGE_PREFIX } from './protocol.ts';
import type { RemoteThreads } from './thread-index.ts';

type Rec = {
  threadId: string;
  runnerName: string;
  starter: string;
  at: number;
  // The row's lastActivityAt once its turn's reply was looked at.
  looked?: string;
  // A hash of the last reply passed on, so the same one never goes twice.
  sent?: string;
};

export type FarReportsDeps = {
  file: string;
  // That thread's newest reply, through the relay: the last agent text of
  // its last turn, or undefined if the turn ended with none.
  lastReply: (threadId: string) => Promise<string | undefined>;
  // Whether the starter is one of this runner's threads.
  has: (starter: string) => boolean;
  deliver: (starter: string, text: string) => void;
  log: { warn: (msg: string, data?: Record<string, unknown>) => void };
  now: () => number;
  // Waits before reading, as the row can say the turn ended before its
  // last reply reaches the backend (relay.ts SETTLE_MS).
  settle?: (ms: number) => Promise<void>;
};

const RUNNING = new Set(['running', 'starting', 'waiting']);
const SETTLE_MS = 5000;
// A reply read this long after the turn ended is all there is.
const LATE_MS = 60_000;
// A thread gone from the list for this long is forgotten.
const FORGET_MS = 30 * 24 * 3600_000;
const MAX_REPLY = 20_000;

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function farReportText(p: { title: string; threadId: string; runnerName: string; reply: string; failed?: boolean }): string {
  const title = p.title.replace(/\s+/g, ' ').trim() || 'Untitled';
  const reply = p.reply.length > MAX_REPLY ? `${p.reply.slice(0, MAX_REPLY)}\n\n[cut: read_thread ${p.threadId} has the rest]` : p.reply;
  const how = p.failed ? 'Its turn ended with an error. Its last reply, passed on' : 'Its reply as its turn ended, passed on';
  return `${AGENT_MESSAGE_PREFIX}"${title}" (${p.threadId.slice(0, 8)}) on ${p.runnerName}, which this thread started there. ${how} by this Mac's runner.]\n\n${reply}`;
}

export class FarReports {
  private recs = new Map<string, Rec>();
  private busy = new Set<string>();
  private deps: FarReportsDeps;

  constructor(deps: FarReportsDeps) {
    this.deps = deps;
    try {
      const raw = JSON.parse(fs.readFileSync(deps.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) for (const r of raw as Rec[]) if (typeof r?.threadId === 'string' && typeof r.starter === 'string') this.recs.set(r.threadId, r);
    } catch {
      // None yet.
    }
  }

  add(p: { threadId: string; runnerName: string; starter: string }): void {
    this.recs.set(p.threadId, { ...p, at: this.deps.now() });
    this.save();
  }

  watching(): string[] {
    return [...this.recs.keys()];
  }

  /** The sidebar's list of other runners' threads, each time it changes. Settles once its checks are done. */
  seen(rt: RemoteThreads): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const rec of [...this.recs.values()]) {
      const row = rt.threads.find((t) => t.threadId === rec.threadId);
      // A starter not here (deleted, or not taken in yet in a handover)
      // waits, as does a thread not in the list; both are forgotten in time.
      if (!row || !this.deps.has(rec.starter)) {
        if (this.deps.now() - rec.at > FORGET_MS) this.drop(rec);
        continue;
      }
      if (RUNNING.has(row.status) || row.lastActivityAt === rec.looked || this.busy.has(rec.threadId)) continue;
      jobs.push(this.check(rec, row.title, row.status, row.lastActivityAt, Boolean(row.archivedAt)));
    }
    return Promise.all(jobs).then(() => undefined);
  }

  private async check(rec: Rec, title: string, status: string, activity: string, archived: boolean): Promise<void> {
    this.busy.add(rec.threadId);
    try {
      await (this.deps.settle ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(SETTLE_MS);
      const reply = await this.deps.lastReply(rec.threadId);
      const key = reply === undefined ? undefined : hash(reply);
      if (reply !== undefined && key !== rec.sent) {
        this.deps.deliver(rec.starter, farReportText({ title, threadId: rec.threadId, runnerName: rec.runnerName, reply, failed: status === 'error' }));
        rec.sent = key;
        rec.looked = activity;
      } else if (this.deps.now() - Date.parse(activity) > LATE_MS) {
        // Nothing new, and nothing more is coming for this turn. Before
        // that, the next change to the list looks again.
        rec.looked = activity;
      }
      if (archived) this.recs.delete(rec.threadId);
      this.save();
    } catch (e) {
      // Tried again at the list's next change.
      this.deps.log.warn("couldn't pass on another runner's reply", { threadId: rec.threadId, starter: rec.starter, error: String((e as Error)?.message ?? e) });
    } finally {
      this.busy.delete(rec.threadId);
    }
  }

  private drop(rec: Rec): void {
    this.recs.delete(rec.threadId);
    this.save();
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.deps.file, JSON.stringify([...this.recs.values()]));
    } catch (e) {
      this.deps.log.warn("couldn't save far-reports.json", { error: String((e as Error)?.message ?? e) });
    }
  }
}

// The last turn's reply in a page of a thread's events, as read_thread
// takes it: walking back, the first agent text before a message to it.
export function lastReplyOf(events: { type: string; text?: string }[]): string | undefined {
  for (const e of [...events].reverse()) {
    if (e.type === 'user.message') return undefined;
    if (e.type === 'assistant.text' && typeof e.text === 'string' && e.text.trim()) return e.text;
  }
  return undefined;
}
