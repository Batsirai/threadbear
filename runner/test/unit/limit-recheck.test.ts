// A login whose last reading says it's out of room is read again now and
// then (src/limit-recheck.ts). On 17 Nov 2026 Mike's codex-main still read
// "0% left, back tomorrow" a day after he used a reset in Codex: readings
// only came from Threadbear's own Codex turns, and pools skip a login at
// 0%, so nothing ever read it again until the old reset time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { dueForRecheck, FIRST_RECHECK_MS, LimitRecheck, RECHECK_MS } from '../../src/limit-recheck.ts';
import type { Account, UsageWindow } from '../../src/protocol.ts';
import type { AgentAdapter } from '../../src/adapters/types.ts';
import type { UsageReading } from '../../src/usage.ts';

const T0 = Date.parse('2026-11-17T00:00:00.000Z');

function codex(id: string, o: { week?: number; blocked?: boolean; readAt?: number; signedOut?: boolean; provider?: 'claude' | 'codex' } = {}): Account {
  const windows: UsageWindow[] = o.week === undefined ? [] : [{ kind: 'weekly', title: 'Weekly', remainingPercent: o.week, resetsAt: '2026-11-18T07:36:48.000Z' }];
  return {
    id,
    provider: o.provider ?? 'codex',
    title: id,
    configDir: `/tmp/${id}`,
    ...(o.signedOut ? { signedOut: true } : {}),
    usage: { windows, readAt: new Date(o.readAt ?? T0 - 2 * 86_400_000).toISOString(), source: 'live', ...(o.blocked ? { blocked: true } : {}) },
  } as Account;
}

test("a login that read 0% two days ago is due; one with room, or read just now, or signed out isn't", () => {
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), true, T0, undefined), true);
  assert.equal(dueForRecheck(codex('codex-main', { week: 40, blocked: true }), true, T0, undefined), true, 'blocked whatever its percent');
  assert.equal(dueForRecheck(codex('codex-main', { week: 40 }), true, T0, undefined), false);
  assert.equal(dueForRecheck(codex('codex-main', { week: 0, readAt: T0 - 60_000 }), true, T0, undefined), false);
  assert.equal(dueForRecheck(codex('codex-main', { week: 0, signedOut: true }), true, T0, undefined), false);
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), false, T0, undefined), false, 'a provider that can only read in a turn');
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), true, T0, T0 - 60_000), false, 'tried a minute ago');
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), true, T0, T0 - RECHECK_MS), true);
});

function setup(accounts: Account[], answer: () => Promise<unknown>) {
  const clock = new FakeClock(T0);
  const reads: string[] = [];
  const recorded: { id: string; reading: UsageReading }[] = [];
  const adapter = { provider: 'codex', readLimits: async (a: Account) => (reads.push(a.id), answer()) } as unknown as AgentAdapter;
  const r = new LimitRecheck({ clock, log: nullLogger, accounts: () => accounts, adapters: { codex: adapter }, record: (id, reading) => recorded.push({ id, reading }) });
  return { clock, reads, recorded, r };
}

const settle = () => new Promise((res) => setImmediate(res));

test('a reset made outside Threadbear lifts the login on the next look', async () => {
  const accounts = [codex('codex-main', { week: 0 }), codex('codex-1', { week: 60 }), codex('claude-1', { week: 0, provider: 'claude' })];
  const fresh = { kind: 'limits', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100 }], blocked: false, resets: { available: 1 } };
  const { clock, reads, recorded, r } = setup(accounts, async () => fresh);
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  assert.deepEqual(reads, ['codex-main'], 'only the Codex login that reads as out');
  assert.deepEqual(recorded, [{ id: 'codex-main', reading: { windows: fresh.windows, blocked: false, resets: { available: 1 } } }]);
  r.stop();
});

test('a login still out is asked again every ten minutes, not more', async () => {
  const accounts = [codex('codex-main', { week: 0 })];
  const { clock, reads, r } = setup(accounts, async () => null);
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  clock.advance(RECHECK_MS - 1);
  await settle();
  assert.equal(reads.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(reads.length, 2);
  r.stop();
  clock.advance(RECHECK_MS * 3);
  await settle();
  assert.equal(reads.length, 2, 'nothing after stop');
});

test("a read that fails is logged and doesn't stop the next one", async () => {
  const accounts = [codex('codex-main', { week: 0 }), codex('codex-2', { week: 0 })];
  const { clock, reads, r } = setup(accounts, async () => {
    throw new Error('app-server went away');
  });
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  assert.deepEqual(reads, ['codex-main', 'codex-2']);
  r.stop();
});
