// For everyone (experiment `feed`, docs/protocol/threads.md, "For everyone"):
// one question to Claude, Codex, Gemini and Grok at once. The thread Mike
// starts (or one he already has) is the lead; each other lab answers in a
// member thread of its own, and every answer goes back to the lead, whose
// reply sums up where they stand. The Feed draws the lead's card with the
// members' answers in its fold.
//
// Why: Mike ran panels by hand with the delegate skill, and on 22 Nov 2026
// asked for them in the Feed as drawn in mockup r3-c-status ("Mike · for
// everyone").
//
// Part of the Runner (runner.ts); each method's `this` is the Runner.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import { ErrorCode, RpcError, type EffortLevel, type EveryoneMissing, type EveryonePanel, type Provider, type ThreadSummary } from '../protocol.ts';
import type { EveryoneAnswer, ThreadRecord } from '../store.ts';
import { experimentOn } from '../experiments.ts';
import { providerName } from '../providers.ts';
import { reviewPicker } from './lab-review.ts';
import { safeEnd } from '../safe-cut.ts';
import { requestLine } from '../runner.ts';

export const EVERYONE_EXPERIMENT = 'feed';
// The labs a question goes to, in the order the card names them.
export const EVERYONE_LABS: readonly Provider[] = ['claude', 'codex', 'antigravity', 'grok'];
// A member answers a question; it doesn't need a lab's deepest thinking,
// and four at once at max would eat Mike's week.
export const EVERYONE_EFFORT: EffortLevel = 'medium';
// How much of a member's answer the lead is handed; its thread has all of it.
export const EVERYONE_REPLY_CHARS = 4_000;

// "Codex", "Codex and Gemini", "Codex, Gemini and Grok".
export function namesLine(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// The line under the question a member is sent.
export function memberNote(others: string[]): string {
  return `(${namesLine(others)} ${others.length === 1 ? 'is' : 'are'} answering this too, each on its own. Answer in your own words, briefly, and don't change any files: you all share this folder.)`;
}

// What the lead is sent: the answers that came in, who's still to answer,
// and what to do with them.
export function leadReport(answers: EveryoneAnswer[], waiting: string[], members: string[]): string {
  const who = namesLine(answers.map((a) => a.name));
  const parts = [`For everyone: ${who} answered.`];
  for (const a of answers) parts.push(`${a.name} (thread ${a.threadId.slice(0, 8)}):\n${a.reply}`);
  parts.push(waiting.length ? `Still to answer: ${namesLine(waiting)}.` : 'Everyone has answered.');
  parts.push(
    `The user asked you and ${namesLine(members)} the same question at once; each answers in a thread of its own, and their answers come to you here. ` +
      'Start your reply with one or two short sentences on where everyone stands, as their card shows it ("3 of 4 say wait for one good release. Codex says revoke now."), ' +
      "and if they have something to decide, ask it in end_turn's asks. Don't repeat the answers, and don't say who is still working: the card shows that.",
  );
  return parts.join('\n\n');
}

export const everyonePart = {
  everyoneOn(this: Runner): boolean {
    return experimentOn(this.cfg.home, EVERYONE_EXPERIMENT);
  },

  // Asks the other labs `text` in threads of their own, with `st` as their
  // lead. Labs with no login that can take it are written down as missing.
  startEveryone(this: Runner, st: ThreadState, text: string): void {
    const { rec } = st;
    const pick = reviewPicker(this, rec);
    const signedIn = new Set(this.safeAccounts().filter((a) => !a.signedOut && !a.planEnded).map((a) => a.provider));
    const missing: NonNullable<EveryonePanel['missing']> = [];
    const picked: { provider: Provider; accountId: string }[] = [];
    for (const provider of EVERYONE_LABS) {
      if (provider === rec.provider) continue;
      const account = pick(provider);
      if (account) picked.push({ provider, accountId: account.id });
      else missing.push({ provider, name: providerName(provider), why: signedIn.has(provider) ? 'noRoom' : 'notSignedIn' });
    }
    const lead = providerName(rec.provider);
    const members: EveryonePanel['members'] = [];
    for (const { provider, accountId } of picked) {
      const others = [lead, ...picked.filter((p) => p.provider !== provider).map((p) => providerName(p.provider))];
      try {
        const { thread } = this.create({
          text: `${text}\n\n${memberNote(others)}`,
          cwd: rec.cwd,
          accountId,
          model: this.defaultModelFor(provider) ?? panelModel(this, provider),
          effort: EVERYONE_EFFORT,
          permissionMode: rec.permissionMode,
          worktree: false,
          startedBy: { kind: 'thread', label: 'For everyone', threadId: rec.id, threadTitle: rec.title, why: 'answers the same question' },
        });
        const member = this.threads.get(thread.id);
        if (member) {
          member.rec.everyoneOf = rec.id;
          this.markDirty(member);
        }
        members.push({ provider, name: providerName(provider), threadId: thread.id });
      } catch (e) {
        this.log.warn('a For everyone member failed to start', { threadId: rec.id, provider, error: e instanceof Error ? e.message : String(e) });
        missing.push({ provider, name: providerName(provider), why: 'failed' });
      }
    }
    rec.everyone = { members, ...(missing.length ? { missing } : {}) };
    this.markDirty(st);
    const lines = [members.length ? `Asked ${namesLine(members.map((m) => m.name))} too, each in a thread of its own.` : 'No other lab could be asked.'];
    for (const m of missing) lines.push(missingLine(m.name, m.why));
    this.emit(st, { type: 'system.note', text: lines.join(' ') });
    this.log.info('for everyone', { threadId: rec.id, members: members.map((m) => m.threadId), missing: missing.map((m) => m.provider) });
  },

  // threads.askOthers: the thread's first message of Mike's, to the other labs.
  askOthers(this: Runner, threadId: string): ThreadSummary {
    if (!this.everyoneOn()) throw new RpcError(ErrorCode.badParams, 'Asking the others is part of the feed experiment, which is off.');
    const st = this.mustGet(threadId);
    const { rec } = st;
    if (rec.everyone) throw new RpcError(ErrorCode.badParams, 'The others have been asked already.');
    if (rec.everyoneOf) throw new RpcError(ErrorCode.badParams, 'This thread is answering for everyone already.');
    const text = firstAsk(this, rec);
    if (!text) throw new RpcError(ErrorCode.badParams, "There's no message of yours in this thread to ask the others.");
    this.startEveryone(st, text);
    return this.summary(st);
  },

  // A member's turn completed: its answer goes to the lead, merged with one
  // still waiting in the lead's queue so answers that come together cost
  // the lead one turn. Not to a lead that's archived or hibernating.
  tellLead(this: Runner, st: ThreadState, lastText: string | undefined): void {
    const lead = st.rec.everyoneOf ? this.threads.get(st.rec.everyoneOf) : undefined;
    if (!lead || lead.rt.deleted || this.bucket(lead.rec) !== 'inbox') return;
    let reply = lastText?.trim() ?? '';
    if (reply.length > EVERYONE_REPLY_CHARS) reply = reply.slice(0, safeEnd(reply, EVERYONE_REPLY_CHARS)) + '…';
    if (!reply) return;
    // Started with the lead's mode: if Mike has raised the lead since, and
    // not this one with it, its answer is his to read (runner/ceiling.ts).
    const me = this.authorityNow(lead.rec.id);
    if (!this.mayPassOn(me, undefined, st.rec.id)) {
      this.withhold(lead, `${providerName(st.rec.provider)} answered`, `The answer from "${st.rec.title}" wasn't passed to this thread's agent: this thread has more access now than that one. Read it there, and send a message here to carry on.`);
      return;
    }
    const panel = lead.rec.everyone;
    const name = panel?.members.find((m) => m.threadId === st.rec.id)?.name ?? providerName(st.rec.provider);
    const answer: EveryoneAnswer = { threadId: st.rec.id, name, reply };
    const queued = lead.rec.queue.find((q) => q.origin === 'runner' && q.everyoneAnswers?.length);
    // Each answer kept from before is checked again against the lead as it
    // is now: one from a member Mike didn't raise with it is his to read.
    const earlier = queued ? queued.everyoneAnswers!.filter((a) => a.threadId !== answer.threadId) : [];
    const dropped = earlier.filter((a) => !this.mayPassOn(me, undefined, a.threadId));
    if (dropped.length) this.withhold(lead, `${providerName(st.rec.provider)} answered`, `The answer${dropped.length === 1 ? '' : 's'} from ${dropped.map((a) => `"${a.name}"`).join(', ')} ${dropped.length === 1 ? "wasn't" : "weren't"} passed to this thread's agent: this thread has more access now than ${dropped.length === 1 ? 'that one' : 'those'}. Read ${dropped.length === 1 ? 'it' : 'them'} there, and send a message here to carry on.`);
    const answers = [...earlier.filter((a) => !dropped.includes(a)), answer];
    const waiting = (panel?.members ?? [])
      .filter((m) => !answers.some((a) => a.threadId === m.threadId))
      .filter((m) => {
        const t = this.threads.get(m.threadId);
        return t && !t.rt.deleted && (t.rt.turn || t.rec.queue.length);
      })
      .map((m) => m.name);
    const text = leadReport(answers, waiting, (panel?.members ?? []).map((m) => m.name));
    const wakeReason = `${namesLine(answers.map((a) => a.name))} answered`;
    if (queued) {
      queued.everyoneAnswers = answers;
      queued.text = text;
      queued.wakeReason = wakeReason;
      queued.ceiling = me.mode === 'plan' ? 'ask' : me.mode;
      this.markDirty(lead);
      return;
    }
    this.sendTo(lead, text, [], { origin: 'runner', queue: true, wakeReason, everyoneAnswers: answers, ceiling: me.mode === 'plan' ? 'ask' : me.mode });
  },
};

export function missingLine(name: string, why: EveryoneMissing): string {
  if (why === 'notSignedIn') return `${name} isn't signed in on this Mac, so it's left out.`;
  if (why === 'noRoom') return `${name} has no login with room for this folder, so it's left out.`;
  return `${name}'s thread couldn't start, so it's left out.`;
}

// The model Mike's review lists name for a lab (Settings > General > Code
// review), when the runner has no default model for it: the one he picked
// for Gemini or Grok there is the one he wants them on.
function panelModel(runner: Runner, provider: Provider): string | undefined {
  const lists = [...(runner.cfg.labPanel ?? []), ...(runner.cfg.labReviewers ?? [])];
  return lists.find((r) => r.provider === provider && r.model)?.model;
}

// Mike's first message to the thread, in full.
function firstAsk(runner: Runner, rec: ThreadRecord): string | undefined {
  const log = runner.store.log(rec.id);
  for (const e of log.read(1, Math.min(300, log.lastSeq))) {
    if (e.type === 'user.message' && requestLine(e, rec.reviews)) return e.text.trim();
  }
  return undefined;
}

export type EveryonePart = RunnerPart<typeof everyonePart>;
