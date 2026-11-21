// Codex Security, 21 Nov 2026 (finding 156): the push relay's /register
// called the deployment it was given back (relay/convex/verify.ts
// deploymentVouches) after only a read-only check, and a call-back that
// said no charged nothing, so anyone could have it make outbound requests
// as fast and as many at once as they liked. Now each call-back is charged
// to the relay's own budget first (relay.ts startCheck), never to a
// deployment's registrations. These play /register's steps
// (verify.ts checkRegistration, as http.ts wires them) against
// relay/convex/relay.ts on an in-memory database.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, RELAY } from '../helpers/convex-memory.ts';
import { checkRegistration } from '../../../relay/convex/verify.ts';

const relay = load('relay', RELAY);
const { MAX_CHECKS_IN_FLIGHT, MAX_NEW_CHECKS_IN_FLIGHT, CHECKS_PER_DEPLOYMENT_PER_HOUR, NO_COOLDOWN_MS, NEW_CHECKS_PER_HOUR, CHECK_LEASE_MS, REGISTRATIONS_PER_DEPLOYMENT_PER_DAY, NEW_INSTALLS_PER_DAY } = relay;

const T0 = Date.parse('2026-11-21T01:00:00Z');
let clock = T0;
mock.method(Date, 'now', () => clock);
afterEach(() => (clock = T0));

const site = (n: number | string) => `https://made-up-${n}.convex.site`;

// Convex runs each mutation as one serializable transaction; the
// in-memory database doesn't, so the steps here take turns.
let turn: Promise<unknown> = Promise.resolve();
const serial = (ctx: unknown, fn: unknown, args: Record<string, unknown>): Promise<any> => {
  const next = turn.then(() => call(ctx, fn as never, args));
  turn = next.catch(() => {});
  return next;
};

// /register's steps for `deployment`, with the call-back answered by
// `answer` (counted in `calls`), then registerVerified on a yes, as http.ts does.
function registrar(ctx: unknown) {
  const calls: string[] = [];
  const attempt = async (deployment: string, answer: () => Promise<boolean> = async () => false) => {
    const r = await checkRegistration({
      mayRegister: () => serial(ctx, relay.mayRegister, { deployment }),
      startCheck: () => serial(ctx, relay.startCheck, { deployment }),
      endCheck: (check, vouched) => serial(ctx, relay.endCheck, { check, vouched }),
      vouches: () => {
        calls.push(deployment);
        return answer();
      },
    });
    if (r === 'yes') await serial(ctx, relay.registerVerified, { deployment });
    return r;
  };
  return { calls, attempt };
}

test('a burst of made-up registrations at once: only so many call-backs go at a time', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  // Call-backs that hang (a deployment taking its time) until let go.
  let release!: () => void;
  const held = new Promise<boolean>((res) => (release = () => res(false)));
  const burst = Array.from({ length: 50 }, (_, n) => r.attempt(site(n), () => held));
  // Let every attempt get as far as it can.
  for (let i = 0; i < 200; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, MAX_NEW_CHECKS_IN_FLIGHT, 'call-backs to unknown deployments in flight at once');
  release();
  const results = await Promise.all(burst);
  assert.equal(results.filter((x) => x === 'limited').length, 50 - MAX_NEW_CHECKS_IN_FLIGHT);
  assert.equal(results.filter((x) => x === 'no').length, MAX_NEW_CHECKS_IN_FLIGHT);
  // Answered, they stop counting.
  assert.equal(b.rows('checks').length, 0);
  assert.equal(await r.attempt(site('later')), 'no');
});

test("one deployment gets one call-back at a time, none for a while after a no, and so many an hour", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  let release!: () => void;
  const held = new Promise<boolean>((res) => (release = () => res(false)));
  const first = r.attempt(site('x'), () => held);
  for (let i = 0; i < 50; i++) await new Promise((res) => setImmediate(res));
  assert.equal(await r.attempt(site('x')), 'limited', 'a second one while the first is going');
  release();
  assert.equal(await first, 'no');
  assert.equal(await r.attempt(site('x')), 'limited', 'straight after a no');
  assert.deepEqual(r.calls, [site('x')]);
  let made = 1;
  for (let i = 0; i < CHECKS_PER_DEPLOYMENT_PER_HOUR * 2; i++) {
    clock += NO_COOLDOWN_MS;
    if ((await r.attempt(site('x'))) === 'no') made++;
  }
  assert.equal(made, CHECKS_PER_DEPLOYMENT_PER_HOUR);
  assert.equal(r.calls.length, CHECKS_PER_DEPLOYMENT_PER_HOUR);
});

test('made-up names get only so many call-backs an hour relay-wide', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  for (let n = 0; n < NEW_CHECKS_PER_HOUR; n++) assert.equal(await r.attempt(site(n)), 'no');
  assert.equal(await r.attempt(site('one-more')), 'limited');
  assert.equal(r.calls.length, NEW_CHECKS_PER_HOUR);
  clock += 3_600_000;
  assert.equal(await r.attempt(site('one-more')), 'no');
});

test("failed call-backs use only the relay's budget: a deployment's registrations and the day's new installs are untouched", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const real = 'https://real-backend-1.convex.site';
  // Someone naming the real backend with nonces it never made.
  assert.equal(await r.attempt(real), 'no');
  for (let n = 0; n < 50; n++) await r.attempt(site(n));
  assert.equal(b.rows('installs').length, 0);
  const day = b.rows('days')[0];
  assert.equal(day?.newInstalls ?? 0, 0);
  assert.equal(day?.registrations ?? 0, 0);
  // Once the cool-down is over the real one registers, and its own allowance is whole.
  clock += NO_COOLDOWN_MS;
  assert.equal(await r.attempt(real, async () => true), 'yes');
  const row = b.rows('installs').find((i) => i.deployment === real)!;
  assert.equal(row.registeredToday, 1);
  assert.ok(REGISTRATIONS_PER_DEPLOYMENT_PER_DAY > 1 && NEW_INSTALLS_PER_DAY > 1);
});

test("made-up names using up the hour's call-backs and slots can't stop a known backend registering again", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const real = 'https://real-backend-1.convex.site';
  await call(b.ctx, relay.registerVerified, { deployment: real });
  for (let n = 0; n < NEW_CHECKS_PER_HOUR; n++) await r.attempt(site(n));
  assert.equal(await r.attempt(site('one-more')), 'limited');
  // And with every slot for made-up names held.
  let release!: () => void;
  const held = new Promise<boolean>((res) => (release = () => res(false)));
  clock += 3_600_000;
  const burst = Array.from({ length: MAX_NEW_CHECKS_IN_FLIGHT }, (_, n) => r.attempt(site(`h${n}`), () => held));
  for (let i = 0; i < 200; i++) await new Promise((res) => setImmediate(res));
  assert.equal(await r.attempt(site('blocked')), 'limited');
  assert.equal(await r.attempt(real, async () => true), 'yes');
  release();
  await Promise.all(burst);
  assert.ok(MAX_CHECKS_IN_FLIGHT > MAX_NEW_CHECKS_IN_FLIGHT);
});

test("a call-back whose action died stops counting after its lease, and expire clears it", async () => {
  const b = memoryBackend(RELAY);
  const started = await call(b.ctx, relay.startCheck, { deployment: site('dead') });
  assert.equal(typeof started, 'object');
  assert.equal(await call(b.ctx, relay.startCheck, { deployment: site('dead') }), 'limited');
  clock += CHECK_LEASE_MS + 1;
  assert.equal(typeof (await call(b.ctx, relay.startCheck, { deployment: site('dead') })), 'object');
  clock += 3 * 86_400_000;
  await call(b.ctx, relay.expire, {});
  assert.equal(b.rows('checks').length, 0);
  assert.equal(b.rows('checkedDeployments').length, 0);
});

test("endCheck for a check that's gone does nothing", async () => {
  const b = memoryBackend(RELAY);
  const started = await call(b.ctx, relay.startCheck, { deployment: site('gone') });
  await call(b.ctx, relay.endCheck, { check: started.check, vouched: false });
  assert.equal(await outcome(call(b.ctx, relay.endCheck, { check: started.check, vouched: false })), 'ok');
});
