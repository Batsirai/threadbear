// Replies from threads this Mac started on other runners, passed back to the
// thread that started them (docs/protocol.md, "Asking another runner",
// "Reporting back").
//
// The main Mac's create_thread with a runner starts the thread there through
// the relay. A runner on a runner key (the Pixel, the cloud) can't message
// this Mac's threads, so the started thread's send_message to its starter
// said "No thread" and its report never came (20 Nov 2026). This Mac can
// read that thread, so it looks at it on a timer of its own (the sidebar's
// list is watched only while an app is connected) and, for each turn there
// that has ended, sends the reply it ended with to the starter, as an
// agent's message. The started thread is told so in its first line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteFileSync } from './fsutil.ts';
import { AGENT_MESSAGE_PREFIX } from './protocol.ts';

type Rec = {
  threadId: string;
  runnerName: string;
  starter: string;
  at: number;
  // When its row was last there, by this Mac's clock.
  seenAt?: number;
  // Its row's lastActivityAt as last read, and when (this Mac's clock) it
  // last changed: a thread busy lately is looked at every tick.
  activity?: string;
  changedAt?: number;
  nextAt?: number;
  // The last turn passed on, and the turn waiting to be (its id, newest
  // seq and reply), passed on once a second look finds it the same: the row can say
  // the turn ended before its last reply reaches the backend.
  sentTurn?: string;
  pending?: string;
  // When replies were passed on lately, to cap them.
  sends?: number[];
};

export type FarEvent = { type: string; seq: number; turnId?: string; text?: string; outcome?: string };

export type FarReportsDeps = {
  file: string;
  // That thread's row (status, lastActivityAt), or null when the backend
  // has none.
  row: (threadId: string) => Promise<{ status: string; lastActivityAt?: string } | null>;
  // Its newest events, through the relay.
  events: (threadId: string) => Promise<FarEvent[]>;
  title: (threadId: string) => string | undefined;
  // Whether the starter is one of this runner's threads.
  has: (starter: string) => boolean;
  deliver: (starter: string, text: string) => void;
  // False on a draining runner, whose replacement does this.
  active: () => boolean;
  log: { warn: (msg: string, data?: Record<string, unknown>) => void };
  now: () => number;
};

export const TICK_MS = 15_000;
// A thread quiet this long is looked at every five minutes, not every tick.
const HOT_MS = 30 * 60_000;
const COLD_MS = 5 * 60_000;
// Gone from the backend, or quiet, this long and it's forgotten.
const FORGET_MS = 30 * 24 * 3600_000;
// A tampered runner can end turns as fast as it likes; each wakes the
// starter, so a day's replies are capped.
const MAX_PER_DAY = 40;
const MAX_REPLY = 20_000;
const RUNNING = new Set(['running', 'starting', 'waiting']);

// Words from the other runner, in the header's quotes: nothing that could
// end the quotes or the brackets, on one line.
const plain = (s: string, max: number) => s.replace(/[\s"[\]()]+/g, ' ').trim().slice(0, max).trim();

export function farReportText(p: { title: string; threadId: string; runnerName: string; reply: string }): string {
  const title = plain(p.title, 80) || 'Untitled';
  const runner = plain(p.runnerName, 40) || 'another runner';
  const reply = p.reply.length > MAX_REPLY ? `${p.reply.slice(0, MAX_REPLY)}\n\n[cut: read_thread ${p.threadId} has the rest]` : p.reply;
  return `${AGENT_MESSAGE_PREFIX}"${title}" (${p.threadId.slice(0, 8)})]\n\nFrom ${runner}, where this thread started it. Its reply as its turn ended, passed on by this Mac's runner (thread ${p.threadId}):\n\n${reply}`;
}

// The newest ended turn in a page of a thread's events, with its reply:
// the agent's text after its last tool call (a plan it proposed counts),
// else its last text at all.
export function lastTurnReply(events: FarEvent[]): { turnId: string; reply: string } | undefined {
  const end = events.findLastIndex((e) => e.type === 'turn.completed');
  const done = events[end];
  if (!done?.turnId) return undefined;
  const texts: string[] = [];
  let last: string | undefined;
  let afterTools = true;
  for (let i = end - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.type === 'turn.started' && e.turnId === done.turnId) || e.type === 'turn.completed') break;
    if (e.type === 'tool.call') afterTools = false;
    if ((e.type === 'assistant.text' || e.type === 'plan.proposed') && e.text?.trim()) {
      last ??= e.text;
      if (afterTools) texts.unshift(e.text);
    }
  }
  const reply = texts.join('\n\n') || last || (done.outcome === 'failed' ? '(Its turn failed before it replied. Open it on that Mac to see why.)' : '(Its turn ended with no reply.)');
  return { turnId: done.turnId, reply };
}

export class FarReports {
  private deps: FarReportsDeps;
  private ticking = false;

  constructor(deps: FarReportsDeps) {
    this.deps = deps;
  }

  private read(): Map<string, Rec> {
    const recs = new Map<string, Rec>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, 'utf8')) as unknown;
      if (Array.isArray(raw)) for (const r of raw as Rec[]) if (typeof r?.threadId === 'string' && typeof r.starter === 'string') recs.set(r.threadId, r);
    } catch {
      // None yet.
    }
    return recs;
  }

  // Read again before each write, so a record another process (a handover's
  // other runner) added meanwhile stays.
  private write(changed: Rec[], dropped: string[] = []): void {
    const recs = this.read();
    for (const r of changed) recs.set(r.threadId, r);
    for (const id of dropped) recs.delete(id);
    try {
      atomicWriteFileSync(this.deps.file, JSON.stringify([...recs.values()]));
    } catch (e) {
      this.deps.log.warn("couldn't save far-reports.json", { error: String((e as Error)?.message ?? e) });
    }
  }

  add(p: { threadId: string; runnerName: string; starter: string }): void {
    // A thread already watched keeps its starter: another runner naming one
    // of its threads as new again can't send its replies elsewhere.
    if (this.read().has(p.threadId)) return;
    this.write([{ ...p, at: this.deps.now() }]);
  }

  watching(): string[] {
    return [...this.read().keys()];
  }

  /** Looks at each watched thread that's due. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.active()) return;
    this.ticking = true;
    try {
      const changed: Rec[] = [];
      const dropped: string[] = [];
      for (const rec of this.read().values()) {
        const now = this.deps.now();
        if ((rec.nextAt ?? 0) > now) continue;
        try {
          if (await this.look(rec, now)) changed.push(rec);
          else dropped.push(rec.threadId);
        } catch (e) {
          // Looked at again next tick.
          changed.push(rec);
          this.deps.log.warn("couldn't pass on another runner's reply", { threadId: rec.threadId, starter: rec.starter, error: String((e as Error)?.message ?? e) });
        }
      }
      if (changed.length || dropped.length) this.write(changed, dropped);
    } finally {
      this.ticking = false;
    }
  }

  // False once it's to be forgotten.
  private async look(rec: Rec, now: number): Promise<boolean> {
    const row = await this.deps.row(rec.threadId);
    if (!row) return now - (rec.seenAt ?? rec.at) <= FORGET_MS;
    rec.seenAt = now;
    if (row.lastActivityAt !== rec.activity) {
      rec.activity = row.lastActivityAt;
      rec.changedAt = now;
    }
    const quiet = now - (rec.changedAt ?? rec.at);
    if (quiet > FORGET_MS) return false;
    const running = RUNNING.has(row.status);
    rec.nextAt = running || rec.pending || quiet < HOT_MS ? 0 : now + COLD_MS;
    if (running) {
      rec.pending = undefined;
      return true;
    }
    // Its starter on the other runner of a handover: it comes here soon.
    if (!this.deps.has(rec.starter)) return true;
    const events = await this.deps.events(rec.threadId);
    const turn = lastTurnReply(events);
    if (!turn || turn.turnId === rec.sentTurn) {
      rec.pending = undefined;
      return true;
    }
    const key = `${turn.turnId}:${events[events.length - 1]?.seq ?? 0}:${crypto.createHash('sha256').update(turn.reply).digest('hex').slice(0, 12)}`;
    if (rec.pending !== key) {
      rec.pending = key;
      rec.nextAt = 0;
      return true;
    }
    rec.sends = (rec.sends ?? []).filter((t) => now - t < 24 * 3600_000);
    if (rec.sends.length >= MAX_PER_DAY) this.deps.log.warn('not passing on another reply from that thread today', { threadId: rec.threadId, starter: rec.starter });
    else {
      this.deps.deliver(rec.starter, farReportText({ title: this.deps.title(rec.threadId) ?? 'a thread', threadId: rec.threadId, runnerName: rec.runnerName, reply: turn.reply }));
      rec.sends.push(now);
    }
    rec.pending = undefined;
    rec.sentTurn = turn.turnId;
    return true;
  }
}
