// Only the installed runner reports to Sentry: a release on the real data
// dir. Dev runners, tests and sandbox installs never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultHome } from '../../src/config.ts';
import { logLineEvent, safeFields, scrubEvent, sentryOptions, sentryWanted, useSentryMask } from '../../src/sentry.ts';
import { tmpDir } from '../helpers/fakes.ts';

const RELEASE_ID = '20261029T012558Z-3e0bd5d';
const MIKES = 'https://github.com/mikecann/threadbear.git';

test("a release of Mike's repo on the real data dir reports", () => {
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, MIKES), true);
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, 'git@github.com:mikecann/threadbear.git'), true);
});

test("someone's fork, or a copy with no origin, never reports to Mike's Sentry", () => {
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, 'https://github.com/someone/threadbear.git'), false);
  assert.equal(sentryWanted(defaultHome(), {}, RELEASE_ID, undefined), false);
});

test('a runner from a checkout never reports, even on the real data dir', () => {
  assert.equal(sentryWanted(defaultHome(), {}, undefined, MIKES), false);
});

test('a release on another data dir (a sandbox install, a test) never reports', () => {
  assert.equal(sentryWanted(tmpDir(), {}, RELEASE_ID, MIKES), false);
});

test('THREADBEAR_SENTRY=off and NODE_ENV=test turn it off', () => {
  assert.equal(sentryWanted(defaultHome(), { THREADBEAR_SENTRY: 'off' }, RELEASE_ID, MIKES), false);
  assert.equal(sentryWanted(defaultHome(), { NODE_ENV: 'test' }, RELEASE_ID, MIKES), false);
});

test('only the named fields of a log line go, strings cut short', () => {
  const out = safeFields({ error: 'x'.repeat(1200), threadId: 't1', pid: 4, prompt: 'private words', file: '/Users/someone/notes.md', nested: { a: 1 } });
  assert.deepEqual(Object.keys(out).sort(), ['error', 'pid', 'threadId']);
  assert.equal((out.error as string).length, 1001);
});

test('a WARN line goes as a warning, grouped by its message with ids taken out', () => {
  const now = 1_000_000;
  const a = logLineEvent('warning', 'could not tell 6f1c2d3e-1111-4222-8333-944445555666 the app restarted', { error: 'Thread not found: x' }, now);
  assert.equal(a?.level, 'warning');
  assert.equal(a?.title, 'could not tell <id> the app restarted');
  assert.deepEqual(a?.fingerprint, ['runner-log', 'warning', 'could not tell <id> the app restarted']);
  // Another thread's id is the same fault, inside the hour: nothing more.
  assert.equal(logLineEvent('warning', 'could not tell 0a0b0c0d-1111-4222-8333-944445555666 the app restarted', undefined, now + 1000), null);
  // An hour on it goes again.
  assert.ok(logLineEvent('warning', 'could not tell 0a0b0c0d-1111-4222-8333-944445555666 the app restarted', undefined, now + 60 * 60_000));
});

test('a WARN and an ERROR with the same text are separate issues', () => {
  const now = 2_000_000;
  assert.ok(logLineEvent('error', 'phone command failed (both levels)', undefined, now));
  assert.ok(logLineEvent('warning', 'phone command failed (both levels)', undefined, now));
});

test('model limits and Convex sync network blips are never sent', () => {
  assert.equal(logLineEvent('warning', 'model call failed', { error: 'rate limited' }), null);
  assert.equal(logLineEvent('warning', 'convex sync failed; will retry', { error: 'TypeError: fetch failed' }), null);
  // A Convex sync failure that isn't the network still goes.
  assert.ok(logLineEvent('warning', 'convex sync failed; will retry', { error: 'ArgumentValidationError: bad field' }));
});

test('uncaught exceptions are left to reportException, which has the stack', () => {
  assert.equal(logLineEvent('error', 'uncaught exception', { error: 'boom' }), null);
});

test('the RPC method goes in the title, so different requests failing are separate issues', () => {
  const now = 3_000_000;
  const a = logLineEvent('error', 'request failed', { method: 'panels.convexKey', error: 'x' }, now);
  const b = logLineEvent('error', 'request failed', { method: 'runners.list', error: 'fetch failed' }, now);
  assert.equal(a?.title, 'request failed (panels.convexKey)');
  assert.notDeepEqual(a?.fingerprint, b?.fingerprint);
});

// Daybreak finding 155: errors quote what they were looking at (git's stderr
// names a remote with its token in the URL), and the `error` field and
// exceptions went to Sentry as they were. Every event is scrubbed as it
// leaves, by the real SDK's beforeSend, and dropped if the scrub fails.
const GIT_URL = 'https://x-access-token:ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789@github.com/mikecann/private.git';
const BARE = 'https://ghp_SecretTokenValue0123456789abcdefABCDEF@example.com/repo.git';
const PRIVATE = 'zebra-private-marker-4471';
// Built, so the SDK's source lines around a frame (this file, in a test) don't hold them.
const LEAKS = [['ghs', 'AbCd'].join('_'), ['ghp', 'Secret'].join('_'), ['x', 'access', 'token'].join('-'), PRIVATE];

async function capture(fn: (S: typeof import('@sentry/node')) => void | Promise<void>): Promise<string> {
  const S = await import('@sentry/node');
  const sent: string[] = [];
  useSentryMask((text) => text.split(PRIVATE).join('[REDACTED]'));
  S.init({
    ...sentryOptions(),
    dsn: 'https://public@o1.ingest.sentry.io/1',
    transport: () => ({
      send: async (envelope: unknown) => {
        sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  try {
    await fn(S);
    await S.flush(2000);
  } finally {
    await S.close(2000);
    useSentryMask((t) => t);
  }
  return sent.join('\n');
}

test('a credential in a git URL or a known private value never leaves in a log line event', async () => {
  useSentryMask((text) => text.split(PRIVATE).join('[REDACTED]'));
  const ev = logLineEvent('warning', `upstream check failed ${PRIVATE}`, { error: `Error: git fetch ${GIT_URL} failed: fatal: could not read from ${BARE} (${PRIVATE})`, prompt: PRIVATE }, 9_000_000);
  assert.ok(ev);
  const local = JSON.stringify(ev);
  for (const bad of LEAKS) assert.ok(!local.includes(bad), `${bad} in ${local}`);
  assert.match(local, /github\.com\/mikecann\/private\.git/, 'the rest of the URL stays, to tell what failed');
  useSentryMask((t) => t);
});

test('exceptions, their causes and extras are scrubbed by beforeSend in the real SDK', async () => {
  const out = await capture((S) => {
    const cause = new Error(`git fetch ${BARE} failed: ${PRIVATE}`);
    const e = new Error(`fetch from ${GIT_URL} failed`, { cause });
    S.captureException(e, { tags: { what: 'upstream' }, extra: { error: `${PRIVATE} ${GIT_URL}` } });
    S.captureMessage(`could not reach ${GIT_URL}`, { level: 'warning', extra: { error: `stderr: ${BARE} ${PRIVATE}` } });
  });
  assert.ok(out.length > 0, 'events went out');
  for (const bad of LEAKS) assert.ok(!out.includes(bad), `${bad} left the runner: ${out.slice(Math.max(0, out.indexOf(bad) - 300), out.indexOf(bad) + 100)}`);
  assert.match(out, /fetch from https:\/\/github\.com\/mikecann\/private\.git failed/);
});

test("an event whose scrub fails isn't sent", () => {
  useSentryMask(() => {
    throw new Error('check broke');
  });
  try {
    assert.equal(scrubEvent({ message: 'anything at all' }), null);
  } finally {
    useSentryMask((t) => t);
  }
  assert.deepEqual(scrubEvent({ message: 'fine', breadcrumbs: [{ message: PRIVATE }], user: { id: 'x' } }), { message: 'fine' });
});
