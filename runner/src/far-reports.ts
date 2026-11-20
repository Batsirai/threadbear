// Replies from threads this Mac started on other runners, passed back to the
// thread that started them (docs/protocol.md, "Asking another runner",
// "Reporting back").
//
// The main Mac's create_thread with a runner starts the thread there through
// the relay. A runner on a runner key (the Pixel, the cloud) can't message
// this Mac's threads, so the started thread's send_message to its starter
// said "No thread" and its report never came (20 Nov 2026). This Mac can
// read that thread's rows in the backend, so it looks at them on a timer of
// its own (the sidebar's list is watched only while an app is connected,
// and the relay knows a thread only once that list has it) and, for each
// turn there that has ended, sends the reply it ended with to the starter,
// as an agent's message. The started thread is told so in its first line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteFileSync } from './fsutil.ts';
import { AGENT_MESSAGE_PREFIX } from './protocol.ts';

type Rec = {
  threadId: string;
  runnerName: string;
  starter: string;
  at: number;
  // When its row was last there, and when its starter was last here, by
  // this Mac's clock.
  seenAt?: number;
  starterAt?: number;
  // Its row's lastActivityAt as last read, and when (this Mac's clock) it
  // last changed: a thread busy lately is looked at every tick.
  activity?: string;
  changedAt?: number;
  nextAt?: number;
  // The last turn passed on, and a hash of the reply that went with it: if
  // its rows change later (its last reply reached the backend late) the
  // new reply follows.
  sentTurn?: string;
  sentHash?: string;
  // The newest turn's reply as last seen, sent once a second look finds it
  // the same: the row can say the turn ended before its last reply arrives.
  pending?: string;
  // When replies were passed on lately, to cap them.
  sends?: number[];
};

// A message row as the backend keeps it (relay.ts RelayRow).
export type FarRow = { seq: number; role: string; text: string; turn?: string; summary?: boolean; plan?: boolean };

export type FarReportsDeps = {
  file: string;
  // That thread's row, or null when the backend has none.
  row: (threadId: string) => Promise<{ status: string; lastActivityAt?: string; title?: string } | null>;
  // Its newest message rows, oldest first.
  rows: (threadId: string) => Promise<FarRow[]>;
  // Whether the starter is one of this runner's threads.
  has: (starter: string) => boolean;
  deliver: (starter: string, text: string) => void;
  // False while sync is off, and on a draining runner, whose replacement
  // does this.
  active: () => boolean;
  log: { warn: (msg: string, data?: Record<string, unknown>) => void };
  now: () => number;
};

export const TICK_MS = 15_000;
// A thread quiet this long is looked at every five minutes, not every tick.
const HOT_MS = 30 * 60_000;
const COLD_MS = 5 * 60_000;
// Gone from the backend, or quiet, this long and it's forgotten; a starter
// gone from here (deleted) a day.
const FORGET_MS = 30 * 24 * 3600_000;
const STARTER_GONE_MS = 24 * 3600_000;
// A tampered runner can end turns as fast as it likes; each wakes the
// starter, so a day's replies are capped.
const MAX_PER_DAY = 40;
const MAX_REPLY = 20_000;
const RUNNING = new Set(['running', 'starting', 'waiting']);

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Words from the other runner, in the header's quotes: nothing that could
// end the quotes or the brackets, on one line.
const plain = (s: string, max: number) => s.replace(/[\s"[\]()]+/g, ' ').trim().slice(0, max).trim();

export function farReportText(p: { title: string; threadId: string; runnerName: string; reply: string; again?: boolean }): string {
  const title = plain(p.title, 80) || 'Untitled';
  const runner = plain(p.runnerName, 40) || 'another runner';
  const reply = p.reply.length > MAX_REPLY ? `${p.reply.slice(0, MAX_REPLY)}\n\n[cut: read_thread ${p.threadId} has the rest]` : p.reply;
  const what = p.again ? 'Its reply as its turn ended, again: more of it reached the backend after the first was passed on.' : 'Its reply as its turn ended,';
  return `${AGENT_MESSAGE_PREFIX}"${title}" (${p.threadId.slice(0, 8)})]\n\nFrom ${runner}, where this thread started it. ${what} passed on by this Mac's runner (thread ${p.threadId}):\n\n${reply}`;
}

// A turn's reply from its rows: its last words, walking back past the tool
// calls after them (end_turn's), and the plan it proposed. A summary of
// them (end_turn's bullets) only stands in when there's nothing else.
export function replyOf(rows: FarRow[], turn: string): string {
  const mine = rows.filter((r) => r.turn === turn);
  const said: string[] = [];
  const summary: string[] = [];
  for (const r of [...mine].reverse()) {
    if (r.role === 'tool') {
      if (said.length) break;
      continue;
    }
    if (r.role !== 'assistant' || !r.text.trim()) continue;
    if (r.summary) summary.unshift(r.text);
    else said.unshift(r.text);
  }
  return (said.length ? said : summary).join('\n\n') || '(Its turn ended with no reply.)';
}

// The turns in a page of rows, oldest first.
export function turnsOf(rows: FarRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.turn && out[out.length - 1] !== r.turn && !out.includes(r.turn)) out.push(r.turn);
  return out;
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

  // Read again before each write, so what another process (a handover's
  // other runner) wrote meanwhile stays.
  private write(rec: Rec | undefined, dropped?: string): void {
    const recs = this.read();
    if (rec) recs.set(rec.threadId, rec);
    if (dropped) recs.delete(dropped);
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
    this.write({ ...p, at: this.deps.now() });
  }

  watching(): string[] {
    return [...this.read().keys()];
  }

  /** Looks at each watched thread that's due. */
  async tick(): Promise<void> {
    if (this.ticking || !this.deps.active()) return;
    this.ticking = true;
    try {
      for (const id of this.read().keys()) {
        // Each as the file has it now, and saved as soon as it's looked at.
        const rec = this.read().get(id);
        if (!rec || (rec.nextAt ?? 0) > this.deps.now()) continue;
        try {
          if (await this.look(rec)) this.write(rec);
          else this.write(undefined, rec.threadId);
        } catch (e) {
          // Looked at again next tick.
          this.deps.log.warn("couldn't pass on another runner's reply", { threadId: rec.threadId, starter: rec.starter, error: String((e as Error)?.message ?? e) });
        }
        if (!this.deps.active()) return;
      }
    } finally {
      this.ticking = false;
    }
  }

  // False once it's to be forgotten.
  private async look(rec: Rec): Promise<boolean> {
    const now = this.deps.now();
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
    // Its starter on the other runner of a handover comes here soon; one
    // gone a day was deleted.
    if (this.deps.has(rec.starter)) rec.starterAt = now;
    else return now - (rec.starterAt ?? rec.at) <= STARTER_GONE_MS;
    const rows = await this.deps.rows(rec.threadId);
    const turns = turnsOf(rows);
    // While it runs, its newest turn isn't done.
    const done = running ? turns.slice(0, -1) : turns;
    const from = rec.sentTurn ? turns.indexOf(rec.sentTurn) : -1;
    // The turns after the last one passed on (only the newest, if that one
    // is out of this page), and the last one again if it's still the newest
    // and its reply changed.
    let todo = rec.sentTurn && from < 0 ? done.slice(-1) : done.slice(from + 1);
    if (from >= 0 && from === turns.length - 1 && !running && hash(replyOf(rows, rec.sentTurn!)) !== rec.sentHash) todo = [rec.sentTurn!, ...todo];
    if (!todo.length) {
      rec.pending = undefined;
      return true;
    }
    for (const turn of todo) {
      const reply = replyOf(rows, turn);
      // The newest turn, ended only by its row's status, goes once a second
      // look finds it the same. One another turn followed has ended.
      if (turn === turns[turns.length - 1]) {
        const key = `${turn}:${hash(reply)}`;
        if (rec.pending !== key) {
          rec.pending = key;
          rec.nextAt = 0;
          return true;
        }
        rec.pending = undefined;
      }
      // Passed on meanwhile by the other runner of a handover.
      const there = this.read().get(rec.threadId);
      if (there && (there.sentTurn !== rec.sentTurn || there.sentHash !== rec.sentHash)) return true;
      if (!this.deps.active()) return true;
      rec.sends = (rec.sends ?? []).filter((t) => now - t < 24 * 3600_000);
      if (rec.sends.length >= MAX_PER_DAY) this.deps.log.warn('not passing on another reply from that thread today', { threadId: rec.threadId, starter: rec.starter });
      else {
        this.deps.deliver(rec.starter, farReportText({ title: row.title ?? 'a thread', threadId: rec.threadId, runnerName: rec.runnerName, reply, again: turn === rec.sentTurn }));
        rec.sends.push(now);
      }
      rec.sentTurn = turn;
      rec.sentHash = hash(reply);
      this.write(rec);
    }
    return true;
  }
}
