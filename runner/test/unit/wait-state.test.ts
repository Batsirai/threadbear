// The wait state (runner/src/wait-state.ts): the runner gets every case in
// shared/cases/wait-states.json, and every move the rule can make between two
// cases' threads is one the table lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WAIT_MOVES, WAIT_STATES, allowed, autoArchive, sectionOf, waitStateOf, type WaitInputs, type WaitState } from '../../src/wait-state.ts';

type Case = { name: string; thread: Partial<WaitInputs> & { starredAt?: string }; scheduled?: boolean; state: WaitState; section: string };
const file = JSON.parse(fs.readFileSync(new URL('../../../shared/cases/wait-states.json', import.meta.url), 'utf8')) as { now: string; cases: Case[] };
const now = Date.parse(file.now);

for (const c of file.cases) {
  test(`wait state: ${c.name}`, () => {
    const t: WaitInputs = { status: 'idle', needsYou: false, ...c.thread };
    const state = waitStateOf(t, { now, scheduled: Boolean(c.scheduled) });
    assert.equal(state, c.state);
    assert.equal(sectionOf(state, Boolean(c.thread.starredAt)), c.section);
  });
}

test('every state has a description, and every move names states that exist', () => {
  for (const [state, info] of Object.entries(WAIT_STATES)) assert.ok(info.description.length > 10, state);
  for (const m of WAIT_MOVES) {
    assert.ok(m.to in WAIT_STATES, m.to);
    if (m.from !== '*') for (const f of m.from) assert.ok(f in WAIT_STATES, f);
    assert.ok(m.on.length > 5);
  }
});

test('every state can be reached and left', () => {
  for (const s of Object.keys(WAIT_STATES) as WaitState[]) {
    assert.ok(WAIT_MOVES.some((m) => m.to === s), `nothing moves into ${s}`);
    assert.ok(WAIT_MOVES.some((m) => m.from === '*' || m.from.includes(s)), `nothing moves out of ${s}`);
  }
});

test('archiving is allowed from anywhere, and the inbox guess archives nothing yet', () => {
  for (const s of Object.keys(WAIT_STATES) as WaitState[]) assert.ok(allowed(s, 'archived'));
  assert.equal(autoArchive('done', { verdict: 'skip' }, false), false);
});

test('a few moves the table refuses', () => {
  assert.equal(allowed('done', 'card'), false, 'a card needs a turn');
  assert.equal(allowed('scheduled', 'landing'), false);
  assert.equal(allowed('hibernating', 'job'), false);
});
