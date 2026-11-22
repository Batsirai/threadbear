import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { buildCheckup, checkupOff, countErrors, landingChecks, failingPatches, formatCheckup, parseLogLine, postDraft, readState, releasesOnMain, saveDraft, scrubForPosting, skipped, type Checkup } from '../../src/checkup.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00Z');

function logLine(at: number, level: string, msg: string, extra?: object): string {
  return `${new Date(at).toISOString()} ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
}

test('a log line loses its details, which can carry paths and thread text', () => {
  const p = parseLogLine(logLine(NOW, 'ERROR', 'could not build a release of main', { error: 'tsc failed in /Users/someone/secret-project' }));
  assert.deepEqual(p, { at: NOW, level: 'ERROR', message: 'could not build a release of main' });
  assert.equal(parseLogLine('not a log line'), undefined);
});

test("errors are counted by message, and only Mike's messages are named", () => {
  const lines = [
    logLine(NOW - DAY, 'ERROR', 'could not build a release of main', { commit: 'abc' }),
    logLine(NOW - 2 * DAY, 'ERROR', 'could not build a release of main'),
    logLine(NOW - DAY, 'ERROR', 'my own private-client sync failed'),
    logLine(NOW - DAY, 'WARN', 'could not check main'),
    logLine(NOW - 30 * DAY, 'ERROR', 'an old one'),
  ];
  const r = countErrors(lines, NOW - 14 * DAY, (m) => m.startsWith('could not'));
  assert.deepEqual(r, { errors: [{ message: 'could not build a release of main', count: 2 }], otherErrors: 1 });
});

test("patches: Mike's by name, theirs as a count", () => {
  const r = failingPatches(
    [
      { id: 'checks', source: 'project', file: '/c/.threadbear/patches/checks.ts', error: 'items() threw\nstack' },
      { id: 'my-crm', source: 'home', file: '/Users/x/.threadbear/patches/my-crm.ts', error: 'boom at /Users/x' },
      { id: 'fine', source: 'project', file: '/c/.threadbear/patches/fine.ts' },
    ],
    (f) => f.startsWith('/c/'),
  );
  assert.deepEqual(r, { patches: [{ id: 'checks', error: 'items() threw' }], otherPatchesFailing: 1 });
});

test('the report reads plainly, with the agent note last', () => {
  const c: Checkup = {
    release: { tag: 'release/2026-11-19', date: '2026-11-19T01:00:00Z' },
    previous: { tag: 'release/2026-11-05', date: '2026-11-05T01:00:00Z' },
    sinceDays: 14,
    errors: [{ message: 'could not build a release of main', count: 2 }],
    otherErrors: 1,
    updateFailing: false,
    patches: [],
    otherPatchesFailing: 1,
    note: 'settings.ts clashed with their own change; kept both.',
  };
  assert.equal(
    formatCheckup(c),
    [
      'Brought in `release/2026-11-19` from `release/2026-11-05` (14 days behind).',
      'Runner errors in the last 14 days:',
      '- 2x could not build a release of main',
      "- 1 other (not from Threadbear's own code, so not listed)",
      '1 patch of their own won\'t load.',
      '',
      'From their agent: settings.ts clashed with their own change; kept both.',
    ].join('\n'),
  );
  assert.match(formatCheckup({ ...c, errors: [], otherErrors: 0, otherPatchesFailing: 0, note: undefined }), /Runner errors in the last 14 days: none\.$/);
});

test('posting scrubs secrets, the home folder and the user name', () => {
  const out = scrubForPosting('key sk-ant-api03-' + 'a'.repeat(90) + ' in /Users/alice/dev/x, alice said', '/Users/alice', 'alice');
  assert.doesNotMatch(out, /sk-ant/);
  assert.doesNotMatch(out, /alice/);
  assert.match(out, /~\/dev\/x/);
});

function repo(origin = 'https://github.com/someone/threadbear.git'): string {
  const dir = tmpDir('tb-checkup-repo-');
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(dir, 'runner', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'a.ts'), "log.error('could not build a release of main');\n");
  g('add', '.');
  g('commit', '-q', '-m', 'one');
  g('tag', 'release/2026-11-05');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  g('add', '.');
  g('commit', '-q', '-m', 'two');
  g('tag', 'release/2026-11-19');
  return dir;
}

test("the release main had before comes from main's reflog", () => {
  const dir = repo();
  const r = releasesOnMain(dir);
  assert.equal(r.release?.tag, 'release/2026-11-19');
  assert.equal(r.previous?.tag, 'release/2026-11-05');
});

test('releases the runner kept under refs/threadbear/upstream count too', () => {
  // A fork whose releases after 16 Nov were only there was told it had
  // brought in 16 Nov's when it had 21 Nov's (discussions/85).
  const dir = repo();
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('commit', '-q', '--allow-empty', '-m', 'three');
  g('update-ref', 'refs/threadbear/upstream/2026-11-20', 'HEAD');
  g('commit', '-q', '--allow-empty', '-m', 'their own');
  g('commit', '-q', '--allow-empty', '-m', 'four');
  g('tag', '-a', '-m', 'r', 'kept', 'HEAD');
  g('update-ref', 'refs/threadbear/upstream/2026-11-21', 'refs/tags/kept');
  g('tag', '-d', 'kept');
  // A tag of the fork's own with the same name, off main, doesn't hide it.
  g('tag', 'release/2026-11-21', g('commit-tree', '-m', 'theirs', 'HEAD^{tree}').trim());
  const r = releasesOnMain(dir);
  assert.equal(r.release?.tag, 'release/2026-11-21');
  assert.equal(r.release?.rev, g('rev-parse', 'HEAD').trim());
  assert.equal(r.previous?.tag, 'release/2026-11-20');
});

test("landing checks: counts, typical and slowest times, Mike's step names only, no host names", () => {
  const at = (d: number) => new Date(NOW - d * DAY).toISOString();
  const lines = [
    JSON.stringify({ at: at(20), ok: true, seconds: 9999 }),
    JSON.stringify({ at: at(3), ok: true, seconds: 1200, waitedSeconds: 60, steps: [{ name: 'runner unit tests', status: 'ok', seconds: 700 }, { name: 'their secret step', status: 'ok', seconds: 900 }, { name: 'desktop lint', status: 'skip' }] }),
    JSON.stringify({ at: at(2), ok: false, seconds: 1440, waitedSeconds: 120, steps: [{ name: 'runner unit tests', status: 'FAIL', seconds: 800 }, { name: 'desktop core tests', status: 'ok', seconds: 90 }] }),
    JSON.stringify({ at: at(1), ok: true, seconds: 300, host: 'olli-mini', steps: [{ name: 'runner unit tests', status: 'ok', seconds: 200 }] }),
    JSON.stringify({ at: at(1), dryRun: true, seconds: 5 }),
    '{"cut sho',
    JSON.stringify({ at: at(1), ok: true, seconds: 10, steps: [null, { name: 'private-client\nrunner unit tests', status: 'ok', seconds: 5 }] }),
    JSON.stringify({ at: at(1), ok: true, seconds: 10, steps: {} }),
    'null',
  ];
  const k = landingChecks(lines, NOW - 14 * DAY, (name) => name !== 'their secret step')!;
  assert.deepEqual(k, { count: 5, failed: 1, medianSeconds: 300, slowestSeconds: 1440, medianWaitSeconds: 120, onCheckHost: 1, steps: [{ name: 'runner unit tests', medianSeconds: 700 }, { name: 'desktop core tests', medianSeconds: 90 }] });
  const c: Checkup = { sinceDays: 14, errors: [], otherErrors: 0, updateFailing: false, patches: [], otherPatchesFailing: 0, checks: k };
  const out = formatCheckup(c);
  assert.match(out, /Landing checks in the last 14 days: 5 \(1 failed\), 1 on a check host, 4 on their Mac\. Typical 5 min, slowest 24 min, typical wait for the lock 2 min\./);
  assert.match(out, /Slowest steps \(typical\): runner unit tests 12 min, desktop core tests 2 min\./);
  assert.doesNotMatch(out, /olli-mini|secret|private/);
  assert.equal(landingChecks([], 0, () => true), undefined);
});

test("off with releases.checkup false, and in Mike's own copy", () => {
  assert.equal(checkupOff(repo(), {}), undefined);
  assert.match(checkupOff(repo(), { releases: { checkup: false } })!, /off here/);
  assert.match(checkupOff(repo('git@github.com:mikecann/threadbear.git'), {})!, /Mike's own copy/);
});

test('a check-up drafts from the log, then posts that draft once per release', () => {
  const dir = repo();
  const home = tmpDir('tb-checkup-home-');
  const c = buildCheckup({
    home,
    checkout: dir,
    logLines: [logLine(NOW - DAY, 'ERROR', 'could not build a release of main', { error: 'x' }), logLine(NOW - DAY, 'ERROR', 'their own thing')],
    patches: [],
    updateFailing: true,
    note: '  all   fine  ',
    now: NOW,
  });
  assert.deepEqual(c.errors, [{ message: 'could not build a release of main', count: 1 }]);
  assert.equal(c.otherErrors, 1);
  assert.equal(c.note, 'all fine');
  saveDraft(home, c);

  assert.match(postDraft(home, NOW, () => ({ ok: true, out: 'x' }), 0).message, /hasn't opened/);

  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return { ok: true, out: calls.length === 1 ? 'D_1' : 'https://github.com/mikecann/threadbear/discussions/9#c1' };
  };
  const r = postDraft(home, NOW, gh, 9);
  assert.equal(r.code, 0, r.message);
  assert.ok(calls[1].some((a) => a.startsWith('b=Brought in `release/2026-11-19`')));
  assert.equal(readState(home).posted?.[0].tag, 'release/2026-11-19');
  assert.equal(readState(home).lastAt, new Date(NOW).toISOString());

  saveDraft(home, c);
  assert.match(postDraft(home, NOW, gh, 9).message, /already sent/);
});

test('a skipped check-up still moves where the next one counts from', () => {
  const home = tmpDir('tb-checkup-home-');
  skipped(home, NOW);
  assert.equal(readState(home).lastAt, new Date(NOW).toISOString());
});
