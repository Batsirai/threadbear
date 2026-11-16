// Compact when cold (experiment coldCompact): a long Claude thread woken
// after its prompt cache has expired compacts first, then runs the turn.
//
// Why (the weekly step back, 15 Nov 2026, thread 9369030d): Opus turns that
// started more than an hour after a thread past 200k tokens last ran cost
// $7.71 each against $2.41 warm, as the CLI writes the whole context back
// to the cache (about 464k tokens on average). Compaction's usual cost is
// that it throws a warm cache away; once the cache has gone that cost is
// nothing, and every model call after it reads a short context instead of
// the whole conversation. Mike: "compact only if it's a long thread and
// it's woken after the cache has expired". A warm thread is never touched.
//
// How: deliver() hands the turn's message to compactFirst, which sends
// "/compact <what to keep>" to the CLI and holds the message. The CLI's
// result for the compaction comes to compactDone (the 'result' case in
// onOutput), which says so in the transcript and sends the message. Both
// are one turn, so the thread shows one turn with a quiet line in it.
// Each method's `this` is the Runner; runner.ts puts them on its prototype.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { QueuedSend } from '../store.ts';
import type { TurnResult } from '../adapters/types.ts';
import { experimentOn } from '../experiments.ts';

export const COLD_COMPACT = 'coldCompact';

// The thread's context (its last model call's, rec.contextTokens) from
// which a cold wake compacts. Below it, a cold turn costs about what a warm
// one does (the step back's table: $1.67 against $1.18), so there's little
// to win and a summary to lose.
// THREADBEAR_COLD_COMPACT_MIN_TOKENS overrides it, for trying it on a dev
// runner with a small thread.
export const COLD_COMPACT_MIN_TOKENS = envNumber('THREADBEAR_COLD_COMPACT_MIN_TOKENS') ?? 200_000;

// How long since the thread's last model call before its cache counts as
// gone. Claude Code on a subscription login asks for the hour-long cache;
// the step back's numbers agree (a turn 5 to 60 minutes after the last
// wrote about 24k tokens back, one after an hour about 464k). The margin
// keeps a thread that is maybe still warm out: compacting a warm one costs
// money and memory for nothing, which is the one thing this mustn't do.
// THREADBEAR_COLD_COMPACT_IDLE_MS overrides the two together (dev runners).
export const CACHE_LIFETIME_MS = envNumber('THREADBEAR_COLD_COMPACT_IDLE_MS') ?? 60 * 60_000;
export const COLD_MARGIN_MS = envNumber('THREADBEAR_COLD_COMPACT_IDLE_MS') !== undefined ? 0 : 10 * 60_000;

function envNumber(name: string): number | undefined {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : undefined;
}

// What the summary must keep. Mike's steadiest complaint is an agent that no
// longer knows what was decided ("I thought we..."), and compaction is how
// that happens inside one thread. Sent with /compact only, so it costs no
// standing context.
export const COLD_COMPACT_INSTRUCTIONS =
  'This thread was idle long enough for its cache to expire, so it is being compacted before the next message. ' +
  'Keep, in the user\'s own words where you can: what was decided and why; what the user asked for that is not done yet; ' +
  'anything still running or being waited on (background jobs, other threads by title and id, schedules and check-ins); ' +
  'the files, branches, commits, PRs and links involved; and every correction or preference the user gave about how to do the work here.';

export type Precompact = {
  gen: number; // the CLI it was sent to; a fresh one never ran it
  tokens: number;
  idleMs: number;
  costBefore?: number; // sessionCostTotal when it was sent
  noted?: boolean; // the CLI's own "Compacted" line was reworded
  send: () => void; // the turn's message, held until the compaction is done
};

// Why this message should compact first, or undefined. Pure, for the tests.
export function coldWake(
  rec: { provider: string; contextTokens?: number; sessionUsed?: boolean; resumeAt?: unknown; handoff?: unknown },
  msg: Pick<QueuedSend, 'text' | 'editOf'>,
  lastModelMs: number | undefined,
  nowMs: number,
): { tokens: number; idleMs: number } | undefined {
  // Codex records no cost for most turns, so there's nothing to judge it
  // by yet; Claude only.
  if (rec.provider !== 'claude') return undefined;
  // A new session (a handoff) has no conversation to compact, an edit
  // rewinds it, and a slash command is the user's own (deliver's caller
  // already sends those bare).
  if (!rec.sessionUsed || rec.resumeAt || rec.handoff || msg.editOf !== undefined || msg.text.trimStart().startsWith('/')) return undefined;
  const tokens = rec.contextTokens ?? 0;
  if (tokens < COLD_COMPACT_MIN_TOKENS) return undefined;
  // Not knowing when it last ran means not knowing it's cold.
  if (lastModelMs === undefined || !Number.isFinite(lastModelMs)) return undefined;
  const idleMs = nowMs - lastModelMs;
  if (idleMs < CACHE_LIFETIME_MS + COLD_MARGIN_MS) return undefined;
  return { tokens, idleMs };
}

export function idleWords(ms: number): string {
  const h = ms / 3_600_000;
  const n = h < 1.5 ? Math.round(ms / 60_000) : h < 36 ? Math.round(h) : Math.round(h / 24);
  const unit = h < 1.5 ? 'minute' : h < 36 ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;

export const coldCompactPart = {
  // When the thread last called the model: lastModelAt, or for a thread
  // that hasn't run since that was added, its last finished turn.
  lastModelMs(this: Runner, st: ThreadState): number | undefined {
    const { rec } = st;
    if (rec.lastModelAt) return Date.parse(rec.lastModelAt);
    if (!rec.lastTurnCompletedSeq) return undefined;
    const e = this.store.log(rec.id).read(rec.lastTurnCompletedSeq, rec.lastTurnCompletedSeq)[0];
    return e?.type === 'turn.completed' ? Date.parse(e.ts) : undefined;
  },

  // Called by deliver with the message about to go to a live CLI. True if
  // it sent a compaction instead and holds the message (send) for after.
  compactFirst(this: Runner, st: ThreadState, msg: QueuedSend, send: () => void): boolean {
    const { rec, rt } = st;
    const turn = rt.turn;
    if (!turn || !rt.session || turn.precompact || turn.command) return false;
    const cold = coldWake(rec, msg, this.lastModelMs(st), this.clock.now());
    if (!cold || !experimentOn(this.cfg.home, COLD_COMPACT)) return false;
    turn.precompact = { gen: rt.generation, ...cold, costBefore: rec.sessionCostTotal, send };
    // Nothing goes into the CLI while it compacts: a message sent meanwhile
    // waits for the next turn, as for a /compact typed by hand.
    turn.noSteer = true;
    this.log.info('compacting a cold thread first', { threadId: rec.id, tokens: cold.tokens, idleMin: Math.round(cold.idleMs / 60_000) });
    rt.session.send({ id: `${msg.turnId}:compact`, text: `/compact ${COLD_COMPACT_INSTRUCTIONS}`, images: [] });
    return true;
  },

  // What the transcript says once it has compacted (the CLI's own
  // "Compacted the conversation" line, reworded in onOutput).
  coldNote(this: Runner, pre: Precompact): string {
    return `Compacted the conversation first: it was ${k(pre.tokens)} tokens and idle for ${idleWords(pre.idleMs)}, so its cache had expired.`;
  },

  // The CLI's result while a compaction was pending: the compaction's.
  // Sends the held message, or ends the turn if Stop was pressed.
  compactDone(this: Runner, st: ThreadState, r: TurnResult): void {
    const { rec, rt } = st;
    const turn = rt.turn!;
    const pre = turn.precompact!;
    turn.precompact = undefined;
    turn.noSteer = false;
    const cost = r.totalCostUsd !== undefined && pre.costBefore !== undefined && r.totalCostUsd >= pre.costBefore ? r.totalCostUsd - pre.costBefore : undefined;
    this.log.info('cold compaction done', { threadId: rec.id, outcome: r.outcome, tokens: pre.tokens, ...(cost !== undefined ? { costUsd: Math.round(cost * 1e4) / 1e4 } : {}), ...(r.error ? { error: r.error } : {}) });
    if (turn.interruptRequested) {
      // The message never reached the CLI: kept for the next one as any
      // stopped message is.
      this.saveInterruptedMessages(st, { ...r, unreceived: [turn.turnId] });
      turn.messages = [];
      this.completeTurn(st, { ...r, outcome: 'interrupted' });
      return;
    }
    if (r.outcome === 'completed') {
      if (!pre.noted) this.emit(st, { type: 'system.note', text: this.coldNote(pre) }, turn.turnId);
    } else {
      this.emit(st, { type: 'system.note', text: `Couldn't compact the conversation first, so this turn reads all of it${r.error ? `: ${r.error}` : '.'}` }, turn.turnId);
    }
    pre.send();
  },
};

export type ColdCompactPart = RunnerPart<typeof coldCompactPart>;
