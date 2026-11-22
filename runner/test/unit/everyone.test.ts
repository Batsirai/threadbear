// For everyone (experiment feed, runner/src/runner/everyone.ts): one question
// to the other labs at once, each in a member thread, their answers going
// back to the lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODEX_FLAGS, FakeAccounts, FakeAdapter, makeHarness, tmpDir, withCodex } from '../helpers/fakes.ts';
import type { Account } from '../../src/protocol.ts';
import { leadReport, memberNote, namesLine } from '../../src/runner/everyone.ts';

const END_TURN = 'mcp__threadbear__end_turn';
const GROK: Account = { id: 'grok-main', provider: 'grok', title: 'Grok · main@example.com', configDir: '/tmp/grok' };

function setup(o: { feed?: boolean; grok?: boolean } = {}) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { feed: o.feed !== false } }));
  const claude = new FakeAdapter();
  const codex = new FakeAdapter('codex', { ...CODEX_FLAGS, archives: true });
  const grok = new FakeAdapter('grok');
  const accounts = [...withCodex(), ...(o.grok === false ? [] : [GROK])];
  const h = makeHarness(home, {}, { accounts: new FakeAccounts(accounts), adapters: { claude, codex, grok } });
  const session = (id: string) => [...claude.sessions, ...codex.sessions, ...grok.sessions].filter((s) => s.opts.threadId === id).at(-1)!;
  // A turn finishing with `reply`, as end_turn then the reply.
  const answer = (id: string, reply: string) => {
    const s = session(id);
    s.init();
    s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
    s.text(`m${Math.random()}`, reply);
    s.result();
  };
  return { h, claude, codex, grok, session, answer };
}

const QUESTION = 'Should Threadbear sign releases with Touch ID only?';

function panel(t: ReturnType<typeof setup>) {
  const { thread } = t.h.runner.create({ text: QUESTION, accountId: 'claude-main' });
  t.h.runner.startEveryone(t.h.runner.mustGet(thread.id), QUESTION);
  return t.h.runner.get(thread.id);
}

test('everyone: the other labs get the question in threads of their own, and a lab with no login is named', () => {
  const t = setup();
  const lead = panel(t);
  assert.deepEqual(lead.everyone?.members.map((m) => m.name), ['Codex', 'Grok']);
  assert.deepEqual(lead.everyone?.missing, [{ provider: 'antigravity', name: 'Gemini', why: 'notSignedIn' }]);
  for (const m of lead.everyone!.members) {
    const member = t.h.runner.get(m.threadId);
    assert.equal(member.everyoneOf, lead.id);
    assert.equal(member.provider, m.provider);
    assert.equal(member.cwd, lead.cwd);
    assert.equal(member.effort, 'medium', 'not the lab at full stretch');
    assert.equal(member.startedBy?.threadId, lead.id);
    const sent = t.h.events(m.threadId).find((e) => e.type === 'user.message').text as string;
    assert.ok(sent.startsWith(QUESTION));
    assert.match(sent, /don't change any files/);
  }
  const note = t.h.events(lead.id).filter((e) => e.type === 'system.note').map((e) => e.text).join('\n');
  assert.match(note, /Asked Codex and Grok too/);
  assert.match(note, /Gemini isn't signed in on this Mac, so it's left out\./);
});

test("everyone: a member's answer goes to the lead, and two that come while it works go as one message", () => {
  const t = setup();
  const lead = panel(t);
  const [codex, grok] = lead.everyone!.members;
  // The lead is still on its own answer: both answers wait, merged.
  t.answer(codex.threadId, 'Wait for one good release.');
  t.answer(grok.threadId, 'Revoke now.');
  const queue = t.h.runner.mustGet(lead.id).rec.queue;
  assert.equal(queue.length, 1, 'one message for both');
  assert.match(queue[0].text, /^For everyone: Codex and Grok answered\./);
  assert.match(queue[0].text, /Wait for one good release\./);
  assert.match(queue[0].text, /Revoke now\./);
  assert.match(queue[0].text, /Everyone has answered\./);
  // Its turn ends: the next one starts with them, marked as the panel's.
  t.answer(lead.id, 'Wait, I think.');
  const msgs = t.h.events(lead.id).filter((e) => e.type === 'user.message');
  const report = msgs.at(-1);
  assert.equal(report.origin, 'runner');
  assert.equal(report.everyone, true);
  assert.equal(report.wakeReason, 'Codex and Grok answered');
});

test('everyone: a lead that was archived hears nothing more', () => {
  const t = setup();
  const lead = panel(t);
  t.answer(lead.id, 'Wait.');
  t.h.runner.update({ threadId: lead.id, archived: true });
  t.answer(lead.everyone!.members[0].threadId, 'Wait for one good release.');
  assert.equal(t.h.runner.mustGet(lead.id).rec.queue.length, 0);
  assert.ok(t.h.runner.get(lead.id).archivedAt, 'still archived');
});

test('everyone: Ask the others puts the first message to the other labs, once, with the experiment on', () => {
  const t = setup({ grok: false });
  const { thread } = t.h.runner.create({ text: QUESTION, accountId: 'claude-main' });
  t.answer(thread.id, 'Wait.');
  t.h.runner.send(thread.id, 'And the old key?');
  const asked = t.h.runner.askOthers(thread.id);
  assert.deepEqual(asked.everyone?.members.map((m) => m.provider), ['codex']);
  assert.deepEqual(asked.everyone?.missing?.map((m) => m.why), ['notSignedIn', 'notSignedIn']);
  const sent = t.h.events(asked.everyone!.members[0].threadId).find((e) => e.type === 'user.message').text as string;
  assert.ok(sent.startsWith(QUESTION), 'the first question, not the latest');
  assert.throws(() => t.h.runner.askOthers(thread.id), /asked already/);
  assert.throws(() => t.h.runner.askOthers(asked.everyone!.members[0].threadId), /answering for everyone already/);

  const off = setup({ feed: false });
  const { thread: other } = off.h.runner.create({ text: QUESTION, accountId: 'claude-main' });
  assert.throws(() => off.h.runner.askOthers(other.id), /feed experiment/);
});

test("everyone: the words a member and the lead are sent", () => {
  assert.equal(namesLine(['Claude', 'Codex', 'Grok']), 'Claude, Codex and Grok');
  assert.match(memberNote(['Claude']), /^\(Claude is answering this too/);
  const text = leadReport([{ threadId: 'abcdef1234', name: 'Codex', reply: 'Wait.' }], ['Grok'], ['Codex', 'Grok']);
  assert.match(text, /Codex \(thread abcdef12\):\nWait\./);
  assert.match(text, /Still to answer: Grok\./);
  assert.match(text, /The user asked you and Codex and Grok the same question/);
});
