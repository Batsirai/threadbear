// A wait in words whose latest time passes with nothing seen (wake-when.ts,
// "The latest time passing"; runner/hibernation.ts, wakeAtTime).
//
// 22 Nov 2026: a thread hibernated itself until someone emailed their test
// results. Each morning its latest time passed, it landed in the inbox with
// only "Woke up after hibernating for 17 hours." and no turn, and its agent,
// asked why it woke, couldn't say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { LATE_CHECKS_MAX, LATE_SLEEP_MAX_MS, lateCheckPrompt, lateNews, lateSleepMs, lateWhy } from '../../src/wake-when.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const END_TURN = 'mcp__threadbear__end_turn';
const SAID = 'until the supplier sends the test results';
const TOPIC = 'the supplier has sent the test results';
const TZ = 'Australia/Perth';
const SUNDAY = Date.parse('2026-11-22T01:30:00Z'); // 9:30 am in Perth

const ok = (v: unknown): ModelResult<string> => ({ ok: true, value: JSON.stringify(v), model: 'opus' });

// A thread with a first turn done, and a model that answers wake-when asks
// with `answer` (given the fake clock's now).
function setup(answer: (now: number) => { until?: string | null; topic?: string | null }) {
  const asked: GenerateParams[] = [];
  const generate = async (p: GenerateParams): Promise<ModelResult<string>> => {
    if (p.feature !== 'wake-when') return { ok: false, reason: 'off', message: 'off' };
    asked.push(p);
    return ok({ why: 'x', ...answer(h.clock.now()) });
  };
  const h = makeHarness(undefined, {}, { models: { generate } });
  const { thread } = h.runner.create({ text: "Order the parts", accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.result();
  return { h, id: thread.id, asked };
}

type H = ReturnType<typeof makeHarness>;

// The agent ends the turn it is in with this end_turn.
async function endTurn(h: H, input: Record<string, unknown>, said = 'Still waiting.') {
  const s = h.adapter.last;
  s.text(`m${Math.random()}`, said);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
  s.result('completed');
  await tick();
  await tick();
}

// Its agent hibernates it in words, from a message of Mike's.
async function agentSleeps(h: H, id: string, said = SAID) {
  h.runner.send(id, 'wait for the supplier');
  await tick();
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: said });
}

const notes = (h: H, id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => String(e.text));
const wokeNotes = (h: H, id: string) => notes(h, id).filter((t) => t.startsWith('Woke up'));
const runnerMessages = (h: H, id: string) => h.events(id).filter((e) => e.type === 'user.message' && e.origin === 'runner').map((e) => String(e.text));
const turns = (h: H, id: string) => h.events(id).filter((e) => e.type === 'turn.started').length;
const asleep = (h: H, id: string) => h.runner.list(['snoozed']).some((t) => t.id === id);
// How long until its sleep's time (never NaN: the fake clock would spin).
function left(h: H, id: string): number {
  const until = h.runner.get(id).snoozedUntil;
  assert.ok(until, `asleep, with a time: ${notes(h, id).slice(-3).join(' | ')}`);
  return Date.parse(until) - h.clock.now();
}

test('the words: what the note, the check and the news to the agent say', () => {
  const wait = { said: SAID, topic: TOPIC, by: 'agent' as const, latest: SUNDAY };
  assert.equal(
    lateWhy(wait, TZ, 'checking'),
    'still no sign that the supplier has sent the test results, and this was the latest it would wait (Sunday 22 November, 9:30 am). Its agent is checking for itself',
  );
  const stopped = { n: 3, waitedMs: 7 * DAY, since: new Date(SUNDAY - 14 * DAY).toISOString() };
  assert.equal(
    lateWhy(wait, TZ, { stopped, now: SUNDAY }),
    "still no sign that the supplier has sent the test results, and this was the latest it would wait (Sunday 22 November, 9:30 am). It has waited 14 days and checked 3 times by itself, so it's here for you to decide: chase it, give up on it, or tell it to keep waiting",
  );
  assert.equal(
    lateWhy({ said: 'next time I do woodworking, or Sunday', topic: 'woodworking', latest: SUNDAY }, TZ),
    "you haven't talked about woodworking, and this was the latest it would wait (Sunday 22 November, 9:30 am)",
  );
  const prompt = lateCheckPrompt(wait, TZ, 1);
  assert.match(prompt, /^You hibernated this thread until: until the supplier sends the test results\n\n/);
  assert.match(prompt, /Sunday 22 November, 9:30 am was the latest it would wait, and nothing it has seen says that has happened \(the supplier has sent the test results\)/);
  assert.match(prompt, /check the work itself/);
  assert.match(prompt, /snooze "until the supplier sends the test results" to go back to sleep/);
  assert.match(prompt, /with no snooze, so it stays in their inbox/);
  assert.match(prompt, /check 1 of 3/);
  assert.match(lateCheckPrompt(wait, TZ, LATE_CHECKS_MAX), /check 3 of 3, the last/);
  // A quote in its words can't close the one the prompt puts them in.
  assert.match(lateCheckPrompt({ ...wait, said: 'until "v2" ships' }, TZ, 1), /snooze "until 'v2' ships" to go back/);
  const news = lateNews(wait, TZ, SUNDAY + HOUR, stopped);
  assert.match(news, /^Note from Threadbear: this thread woke by itself on Sunday 22 November, 10:30 am, and no turn ran\./);
  assert.match(news, /You had hibernated it until: until the supplier sends the test results/);
  assert.match(news, /Sunday 22 November, 9:30 am was the latest it would wait/);
  assert.match(news, /woken you 3 times in a row to check/);
  assert.match(lateNews({ said: 'woodworking, or Sunday', topic: 'woodworking', latest: SUNDAY }, TZ, SUNDAY), /The user had hibernated it until they next talked about woodworking \(they said "woodworking, or Sunday"\)\. They hadn't/);
});

test('each sleep after a check is at least twice the last, up to a week', () => {
  assert.equal(lateSleepMs(18 * HOUR), 36 * HOUR);
  assert.equal(lateSleepMs(2 * DAY), 4 * DAY);
  assert.equal(lateSleepMs(4 * DAY), LATE_SLEEP_MAX_MS);
  assert.equal(lateSleepMs(30 * DAY), 7 * DAY);
  // A sleep of no length (a clock that jumped) still backs off.
  assert.ok(lateSleepMs(0) > 0);
});

test("Alex's own Wake when… with a latest time: still no turn, but the note says why and the agent hears with his next message", async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + 2 * DAY).toISOString(), topic: 'woodworking' }));
  await h.runner.hibernateWhen({ threadId: id, said: 'next time I talk about woodworking, or in two days' });
  const before = turns(h, id);
  h.clock.advance(2 * DAY);
  await tick();
  assert.match(wokeNotes(h, id).at(-1)!, /^Woke up after 2 days: you haven't talked about woodworking, and this was the latest it would wait \(.+\)\.$/);
  assert.equal(turns(h, id), before, 'no turn by itself');
  assert.equal(h.runner.get(id).needsYou, true);
  assert.deepEqual(runnerMessages(h, id), []);
  h.runner.send(id, 'Any reason why this woke up?');
  await tick();
  const sent = h.adapter.last.sent.at(-1)!.text;
  assert.match(sent, /^Note from Threadbear: this thread woke by itself on .+, and no turn ran\. The user had hibernated it until they next talked about woodworking/);
  assert.match(sent, /was the latest it would wait\.[\s\S]*\n\nAny reason why this woke up\?$/);
  // Told once: a completed turn has heard it.
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing' }, 'Its latest time passed.');
  h.runner.send(id, 'ok');
  await tick();
  assert.equal(h.adapter.last.sent.at(-1)!.text, 'ok');
});

test("an agent's wait whose latest time passes gets a turn to check for itself, not the inbox", async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + 18 * HOUR).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  assert.ok(asleep(h, id));
  const before = turns(h, id);
  h.clock.advance(18 * HOUR);
  await tick();
  assert.match(
    wokeNotes(h, id).at(-1)!,
    /^Woke up after 18 hours: still no sign that the supplier has sent the test results, and this was the latest it would wait \(.+\)\. Its agent is checking for itself\.$/,
  );
  assert.equal(turns(h, id), before + 1, 'a turn started');
  const prompt = runnerMessages(h, id).at(-1)!;
  assert.match(prompt, /^You hibernated this thread until: until the supplier sends the test results/);
  assert.match(prompt, /was the latest it would wait, and nothing it has seen says that has happened/);
  assert.match(prompt, /check 1 of 3/);
  assert.equal(h.adapter.last.sent.at(-1)!.text, prompt, 'the agent is told in the message itself');
  // It checks, finds nothing, and goes back to sleep with the same words:
  // the next latest time is at least twice as far off, whatever the model says.
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID });
  assert.ok(asleep(h, id));
  assert.equal(left(h, id), 36 * HOUR);
  assert.match(notes(h, id).at(-1)!, /^Hibernating until the supplier has sent the test results, or .+ at the latest\. The agent said/);
});

test('quiet checks back off and stop: after three in a row the next latest time lands it in the inbox, saying how long and for what', async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  const start = h.clock.now();
  const sleeps: number[] = [];
  for (let check = 1; check <= LATE_CHECKS_MAX; check++) {
    sleeps.push(left(h, id));
    const before = turns(h, id);
    h.clock.advance(left(h, id));
    await tick();
    assert.equal(turns(h, id), before + 1, `check ${check} got a turn`);
    assert.match(runnerMessages(h, id).at(-1)!, new RegExp(`check ${check} of ${LATE_CHECKS_MAX}`));
    h.adapter.last.init();
    await endTurn(h, { needs: 'nothing', snooze: SAID });
    assert.ok(asleep(h, id), `asleep again after check ${check}`);
  }
  assert.deepEqual(sleeps, [DAY, 2 * DAY, 4 * DAY]);
  // The fourth: no turn. It's Alex's to decide.
  assert.equal(left(h, id), 7 * DAY, 'the last sleep is a week at most');
  const before = turns(h, id);
  const messages = runnerMessages(h, id).length;
  h.clock.advance(left(h, id));
  await tick();
  assert.equal(turns(h, id), before, 'no fourth turn');
  assert.equal(runnerMessages(h, id).length, messages);
  const t = h.runner.get(id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.needsYou, true);
  const days = Math.round((h.clock.now() - start) / DAY);
  assert.match(
    wokeNotes(h, id).at(-1)!,
    new RegExp(`^Woke up after 7 days: still no sign that the supplier has sent the test results, and this was the latest it would wait \\(.+\\)\\. It has waited ${days} days and checked 3 times by itself, so it's here for you to decide: chase it, give up on it, or tell it to keep waiting\\.$`),
  );
  // His message carries why it woke, and starts the count again.
  h.runner.send(id, 'Keep waiting, they are away this week.');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: this thread woke by itself on .+, and no turn ran\. You had hibernated it until: until the supplier sends[\s\S]*woken you 3 times in a row to check[\s\S]*\n\nKeep waiting, they are away this week\.$/);
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID });
  assert.ok(asleep(h, id));
  assert.equal(left(h, id), DAY, 'no back-off left over');
  h.clock.advance(DAY);
  await tick();
  assert.match(runnerMessages(h, id).at(-1)!, /check 1 of 3/);
});

const OTHER_WORDS = ['until the supplier emails the test results', 'until the test results come from the supplier', 'until the supplier has replied with results'];
test('saying it another way each time does not start the count again', async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  for (let check = 1; check <= LATE_CHECKS_MAX; check++) {
    h.clock.advance(left(h, id));
    await tick();
    assert.match(runnerMessages(h, id).at(-1)!, new RegExp(`check ${check} of`));
    h.adapter.last.init();
    await endTurn(h, { needs: 'nothing', snooze: OTHER_WORDS[check - 1] });
  }
  const before = turns(h, id);
  h.clock.advance(left(h, id));
  await tick();
  assert.equal(turns(h, id), before, 'the stop holds');
  assert.match(wokeNotes(h, id).at(-1)!, /checked 3 times by itself/);
});

test('a wait the model gives no latest time after a check still gets one', async () => {
  let first = true;
  const { h, id } = setup((now) => {
    const until = first ? new Date(now + DAY).toISOString() : null;
    first = false;
    return { until, topic: TOPIC };
  });
  await agentSleeps(h, id);
  h.clock.advance(DAY);
  await tick();
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID });
  assert.equal(left(h, id), 2 * DAY);
});

test('only the sleep straight after a check is held to the back-off: a later wait keeps its own short limit, and the count goes on', async () => {
  let mins = 24 * 60;
  const { h, id } = setup((now) => ({ until: new Date(now + mins * 60_000).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  h.clock.advance(DAY);
  await tick();
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID });
  assert.equal(left(h, id), 2 * DAY);
  // A schedule's message brings it back, and it waits for something else,
  // ten minutes at the most.
  h.runner.send(id, 'Nightly check-in', [], { origin: 'schedule', scheduleId: 's1' });
  await tick();
  h.adapter.last.init();
  mins = 10;
  await endTurn(h, { needs: 'nothing', snooze: 'until the build finishes, ten minutes at the most' });
  assert.equal(left(h, id), 10 * 60_000);
  h.clock.advance(10 * 60_000);
  await tick();
  assert.match(runnerMessages(h, id).at(-1)!, /check 2 of 3/);
});

test('plain snoozes and a time in words wake as they did: no turn, no reason given, nothing for the agent', async () => {
  // The agent's own "2h".
  const a = setup(() => ({}));
  h_send(a.h, a.id);
  await tick();
  a.h.adapter.last.init();
  await endTurn(a.h, { needs: 'nothing', snooze: '2h' });
  const before = turns(a.h, a.id);
  a.h.clock.advance(2 * HOUR);
  await tick();
  assert.equal(wokeNotes(a.h, a.id).at(-1), 'Woke up after hibernating for 2 hours.');
  assert.equal(turns(a.h, a.id), before);
  a.h.runner.send(a.id, 'hello');
  await tick();
  assert.equal(a.h.adapter.last.sent.at(-1)!.text, 'hello');
  // Its words read as a time alone (no topic): the same.
  const b = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: null }));
  await agentSleeps(b.h, b.id, 'when the parcel is due');
  const turnsB = turns(b.h, b.id);
  b.h.clock.advance(DAY);
  await tick();
  assert.equal(wokeNotes(b.h, b.id).at(-1), 'Woke up after hibernating for a day.');
  assert.equal(turns(b.h, b.id), turnsB);
  // A topic alone has no latest time, and sleeps on.
  const c = setup(() => ({ until: null, topic: TOPIC }));
  await agentSleeps(c.h, c.id);
  c.h.clock.advance(60 * DAY);
  await tick();
  assert.ok(asleep(c.h, c.id));
});
function h_send(h: H, id: string) {
  h.runner.send(id, 'come back in two hours');
}

test('archived while it slept: the wait ends quietly at its latest time, with no check and no note', async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  h.runner.update({ threadId: id, archived: true });
  const before = { turns: turns(h, id), notes: wokeNotes(h, id).length };
  h.clock.advance(DAY);
  await tick();
  assert.equal(turns(h, id), before.turns);
  assert.equal(wokeNotes(h, id).length, before.notes);
  const t = h.runner.get(id);
  assert.ok(t.archivedAt);
  assert.equal(t.snoozedUntil, undefined);
  assert.deepEqual(runnerMessages(h, id), []);
});

test('a runner that was down at the latest time gives the check when it starts, once it is listening', async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  h.runner.flush();
  const later = h.clock.now() + 3 * DAY;
  // Starting up (main.ts holds waits until it listens): nothing yet.
  const h2 = h.restart();
  h2.runner.holdWaits = true;
  h2.clock.advance(later - h2.clock.now());
  h2.runner.armSnoozeTimer();
  await tick();
  assert.equal(turns(h2, id), 0);
  assert.equal(wokeNotes(h2, id).length, 0);
  assert.ok(h2.runner.get(id).snoozedUntil, 'still its sleep, to be checked once listening');
  h2.runner.holdWaits = false;
  h2.runner.armSnoozeTimer();
  await tick();
  assert.equal(turns(h2, id), 1);
  assert.match(wokeNotes(h2, id).at(-1)!, /^Woke up after 3 days: still no sign that the supplier has sent/);
  assert.match(runnerMessages(h2, id).at(-1)!, /check 1 of 3/);
});

test('a message already queued goes first, and the check follows it', async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: TOPIC }));
  await agentSleeps(h, id);
  const st = h.runner.threads.get(id)!;
  st.rec.queue.push({ turnId: 'queued-1', text: 'A reminder left waiting', images: [], origin: 'schedule' });
  h.clock.advance(DAY);
  await tick();
  const sent = h.events(id).filter((e) => e.type === 'user.message').map((e) => String(e.text));
  assert.equal(sent.at(-1), 'A reminder left waiting');
  assert.ok(st.rec.queue.some((q) => /check 1 of 3/.test(q.text)), 'the check waits behind it');
});

test('news of a wake that a stopped turn may not have read goes again with the next message', async () => {
  const { h, id } = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: 'woodworking' }));
  await h.runner.hibernateWhen({ threadId: id, said: 'woodworking, or tomorrow' });
  h.clock.advance(DAY);
  await tick();
  h.runner.send(id, 'first');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: this thread woke by itself/);
  h.adapter.last.init();
  h.runner.interrupt(id, { byMike: true });
  h.adapter.last.result('interrupted');
  await tick();
  h.runner.send(id, 'second');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: this thread woke by itself[\s\S]*second$/);
  // Hibernated again by hand before it was read: old news, dropped.
  const other = setup((now) => ({ until: new Date(now + DAY).toISOString(), topic: 'woodworking' }));
  await other.h.runner.hibernateWhen({ threadId: other.id, said: 'woodworking, or tomorrow' });
  other.h.clock.advance(DAY);
  await tick();
  other.h.runner.update({ threadId: other.id, snoozedUntil: new Date(other.h.clock.now() + HOUR).toISOString() });
  other.h.clock.advance(HOUR);
  await tick();
  other.h.runner.send(other.id, 'hello');
  await tick();
  assert.equal(other.h.adapter.last.sent.at(-1)!.text, 'hello');
});
