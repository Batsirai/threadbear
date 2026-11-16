// Daybreak 144 (16 Nov 2026): the push relay's limits were all per
// deployment or per install, and anyone can make Convex deployments that
// pass the registration check (relay/convex/verify.ts), so each made-up
// deployment was another install, another 120 sends an hour and another row
// kept for ever. These play that against relay/convex/relay.ts on an
// in-memory database checked against relay/convex/schema.ts.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, RELAY } from '../helpers/convex-memory.ts';

const relay = load('relay', RELAY);
const { NEW_INSTALLS_PER_DAY, NEW_INSTALL_MS, NEW_INSTALL_SENDS_PER_HOUR, SENDS_PER_HOUR, BAD_TOKEN_SENDS_PER_HOUR, IDLE_INSTALL_MS, EXPIRE_BATCH } = relay;

const T0 = Date.parse('2026-11-16T01:00:00Z');
let clock = T0;
mock.method(Date, 'now', () => clock);
afterEach(() => (clock = T0));

const site = (n: number) => `https://made-up-${n}.convex.site`;
const register = (ctx: unknown, deployment: string) => call(ctx, relay.registerVerified, { deployment });
const admit = (ctx: unknown, i: { installId: string; installKey: string }) => call(ctx, relay.admit, { installId: i.installId, installKey: i.installKey });

test('made-up deployments get only so many new installs a day, relay-wide', async () => {
  const b = memoryBackend(RELAY);
  for (let n = 0; n < NEW_INSTALLS_PER_DAY; n++) await register(b.ctx, site(n));
  assert.equal(await outcome(register(b.ctx, site(NEW_INSTALLS_PER_DAY))), 'busy');
  assert.equal(b.rows('installs').length, NEW_INSTALLS_PER_DAY);
  // The next UTC day there's room again.
  clock = T0 + 86_400_000;
  assert.equal(await outcome(register(b.ctx, site(NEW_INSTALLS_PER_DAY))), 'ok');
});

test('an existing install can always register again, whatever the cap says', async () => {
  const b = memoryBackend(RELAY);
  const mine = await register(b.ctx, 'https://real-backend-1.convex.site');
  for (let n = 0; n < NEW_INSTALLS_PER_DAY - 1; n++) await register(b.ctx, site(n));
  assert.equal(await outcome(register(b.ctx, site(999))), 'busy');
  const again = await register(b.ctx, 'https://real-backend-1.convex.site');
  assert.equal(again.installId, mine.installId);
  assert.equal(await admit(b.ctx, again), 'ok');
  assert.equal(await admit(b.ctx, mine), 'auth', 'the old key stops working');
});

test('young installs share one hourly pool; an established one keeps its own allowance', async () => {
  const b = memoryBackend(RELAY);
  const old = await register(b.ctx, 'https://real-backend-1.convex.site');
  clock = T0 + NEW_INSTALL_MS + 3_600_000;
  const young = [];
  const needed = Math.ceil(NEW_INSTALL_SENDS_PER_HOUR / SENDS_PER_HOUR) + 2;
  for (let n = 0; n < needed; n++) young.push(await register(b.ctx, site(n)));
  let admitted = 0;
  for (const i of young) for (let k = 0; k < SENDS_PER_HOUR; k++) if ((await admit(b.ctx, i)) === 'ok') admitted++;
  assert.equal(admitted, NEW_INSTALL_SENDS_PER_HOUR, 'many young installs together get one pool, not one allowance each');
  for (let k = 0; k < SENDS_PER_HOUR; k++) assert.equal(await admit(b.ctx, old), 'ok', `established send ${k}`);
  assert.equal(await admit(b.ctx, old), 'limited');
  // The pool fills again the next hour.
  clock += 3_600_000;
  assert.equal(await admit(b.ctx, young[0]!), 'ok');
});

test('an install sending to made-up device tokens is stopped after a few an hour', async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    await call(b.ctx, relay.counted, { ok: false, status: k % 2 ? 400 : 410, reason: 'BadDeviceToken', installId: i.installId });
  }
  assert.equal(await admit(b.ctx, i), 'limited', 'no more calls to Apple or Firebase this hour');
  clock += 3_600_000;
  assert.equal(await admit(b.ctx, i), 'ok', 'a new hour, a new allowance');
});

test("the relay's own trouble (a revoked key, a timeout) doesn't use up a real backend's allowance", async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR * 2; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    await call(b.ctx, relay.counted, { ok: false, status: k % 2 ? 403 : 0, reason: 'InvalidProviderToken', installId: i.installId });
  }
  assert.equal(await admit(b.ctx, i), 'ok');
});

test('an install idle for 90 days is removed, its key stops working, and its backend can register again', async () => {
  const b = memoryBackend(RELAY);
  const idle = await register(b.ctx, site(1));
  const busy = await register(b.ctx, 'https://real-backend-1.convex.site');
  // A send while it's young leaves this hour's pool row, which goes too.
  assert.equal(await admit(b.ctx, idle), 'ok');
  clock = T0 + IDLE_INSTALL_MS - 86_400_000;
  assert.equal(await admit(b.ctx, busy), 'ok');
  clock = T0 + IDLE_INSTALL_MS + 1;
  assert.deepEqual(await call(b.ctx, relay.expire, {}), { installs: 1, hours: 1 });
  assert.equal(await admit(b.ctx, idle), 'auth');
  assert.equal(await admit(b.ctx, busy), 'ok');
  // What convex/push.ts does on that 401: registers again, as a new install.
  const back = await register(b.ctx, site(1));
  assert.equal(await admit(b.ctx, back), 'ok');
});

test('expiring a big backlog goes a batch at a time and schedules the rest', async () => {
  const b = memoryBackend(RELAY);
  for (let n = 0; n < EXPIRE_BATCH + 5; n++) await b.ctx.db.insert('installs', { installId: `i_${n}`, keyHash: 'x', createdAt: 0, lastSeenAt: 0, hourStart: 0, hourSends: 0 });
  assert.equal((await call(b.ctx, relay.expire, {})).installs, EXPIRE_BATCH);
  assert.equal(b.scheduled.length, 1);
  assert.equal((await call(b.ctx, relay.expire, {})).installs, 5);
  assert.equal(b.scheduled.length, 1);
});

test('relay:stats shows how many new deployments came each day', async () => {
  const b = memoryBackend(RELAY);
  await register(b.ctx, site(1));
  await register(b.ctx, site(1));
  await register(b.ctx, site(2));
  const s = await call(b.ctx, relay.stats, {});
  assert.equal(s.days[0].registrations, 3);
  assert.equal(s.days[0].newInstalls, 2);
});
