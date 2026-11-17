import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denyWaitLoop, isWaitCommand, sleepSeconds, SHORT_WAIT_MARK, WAIT_LOOP_REASON } from '../../src/wait-loops.ts';

test('sleep arguments read as seconds', () => {
  assert.equal(sleepSeconds('30'), 30);
  assert.equal(sleepSeconds('1.5'), 1.5);
  assert.equal(sleepSeconds('10m'), 600);
  assert.equal(sleepSeconds('2h'), 7200);
  assert.equal(sleepSeconds('1d'), 86_400);
  assert.equal(sleepSeconds('"$DELAY"'), undefined);
});

test('wait loops, long sleeps and CI watches count as waits', () => {
  // The one that kept a thread awake on 17 Nov, shaped like it.
  assert.ok(isWaitCommand('cd ~/dev/me/threadbear && until git merge-base --is-ancestor abc123 main; do sleep 60; done; echo landed'));
  assert.ok(isWaitCommand('while ! curl -sf https://example.com/health; do\n  sleep 5\ndone'));
  assert.ok(isWaitCommand('for i in $(seq 1 120); do gh pr view 72 --json state | grep -q MERGED && break; sleep 30; done'));
  assert.ok(isWaitCommand("bash -c 'until test -f /tmp/done; do sleep 2; done'"));
  assert.ok(isWaitCommand('sleep 1800 && echo "check the deploy"'));
  assert.ok(isWaitCommand('sleep 10m; tb status'));
  assert.ok(isWaitCommand('gh run watch 123456 --exit-status'));
  assert.ok(isWaitCommand('gh pr checks 72 --watch'));
});

test('ordinary background commands are not waits', () => {
  assert.ok(!isWaitCommand('npm run dev'));
  assert.ok(!isWaitCommand('./check.sh --quick'));
  assert.ok(!isWaitCommand('runner/bin/tb land'));
  assert.ok(!isWaitCommand('sleep 2 && open http://localhost:3000'), 'a short sleep by itself');
  assert.ok(!isWaitCommand('for f in *.mov; do ffmpeg -i "$f" -c:v libx264 "${f%.mov}.mp4"; done'), 'a loop that never sleeps');
  assert.ok(!isWaitCommand('gh pr checks 72'));
  assert.ok(!isWaitCommand('sleepwalk --fast'), 'only sleep the command');
});

test('only background Bash calls that wait are refused, and the short-wait mark lets one through', () => {
  const loop = 'until curl -sf localhost:3000; do sleep 1; done';
  assert.equal(denyWaitLoop('Bash', { command: loop, run_in_background: true }), WAIT_LOOP_REASON);
  assert.equal(denyWaitLoop('Bash', { command: loop }), undefined, 'in the foreground the turn waits, so nothing is left running');
  assert.equal(denyWaitLoop('Bash', { command: `${loop} ${SHORT_WAIT_MARK}`, run_in_background: true }), undefined);
  assert.equal(denyWaitLoop('Bash', { command: `${loop} # Short Wait`, run_in_background: true }), undefined, 'in any letters');
  assert.equal(denyWaitLoop('Bash', { command: 'npm run dev', run_in_background: true }), undefined);
  assert.equal(denyWaitLoop('Read', { file_path: '/tmp/x', run_in_background: true }), undefined);
  assert.equal(denyWaitLoop('Bash', { run_in_background: true }), undefined);
});

test('the reason names the way to wait instead', () => {
  assert.match(WAIT_LOOP_REASON, /schedule_message/);
  assert.match(WAIT_LOOP_REASON, /check/);
  assert.match(WAIT_LOOP_REASON, /snooze/);
  assert.ok(WAIT_LOOP_REASON.includes(SHORT_WAIT_MARK));
});
