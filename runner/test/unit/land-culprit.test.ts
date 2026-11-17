// tb land, finding the landing that broke a group (docs/thread-worktrees.md,
// "Finding who broke a group"). On 17 Nov a line of eleven took over four
// hours and landed nothing of the line: half of it had landed with
// --despite-red, which switched off the runs of what failed on each alone;
// main skipped the failing Swift step with nothing changed, which would
// have too; and the halving that was left kept the broken landing, at the
// front of the line, in every holder's group, each halving down to the
// holder alone and landing only that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { land, landLimits, setAside, type LandTarget } from '../../src/worktrees.ts';
import { joinQueue, queueDir, readEntry, waiting, waitingLine } from '../../src/land-queue.ts';
import { capture, commit, holdUntil, makeBranch, makeRepo, sh, until, write } from '../helpers/worktrees-harness.ts';

landLimits.goneMs = 50;

function branches(main: string, names: string[]): LandTarget[] {
  return names.map((n) => {
    const t = makeBranch(main, `${n}0000000`);
    commit(t.path, { [`${n}.txt`]: `${n}\n` }, `Add ${n}`);
    return t;
  });
}

// Writes down each run: the files it saw, the --only it was asked for and
// whether it was asked to run every step (main's run). Holds a's own check
// so the rest queue behind it. `body` decides the rest.
function recorded(root: string, body: string): string {
  return `echo "$(LC_ALL=C ls *.txt | tr '\\n' ' ')| only=\${THREADBEAR_CHECK_ONLY:-} all=\${THREADBEAR_CHECK_ALL:-}" >> '${root}/checks'; ` +
    `if test -z "\${THREADBEAR_CHECK_ONLY:-}" && test -f a.txt && ! test -f b.txt && ! test -f c.txt && ! test -f d.txt; then touch '${root}/checking'; ${holdUntil(`${root}/release`)}; fi; ` +
    body;
}
const runs = (root: string): { files: string; only: string; all: string }[] =>
  fs.readFileSync(path.join(root, 'checks'), 'utf8').trim().split('\n').map((l) => {
    const m = /^(.*)\| only=(.*) all=(.*)$/.exec(l)!;
    return { files: m[1].trim(), only: m[2], all: m[3] };
  });

async function queued(root: string, main: string, a: LandTarget, others: { t: LandTarget; despiteRed?: boolean }[], check: string) {
  const first = land({ ...a, check }, capture().opts);
  await until(() => fs.existsSync(path.join(root, 'checking')), "a's check");
  const caps = others.map(() => capture());
  const rest = others.map((o, i) => land({ ...o.t, check }, { ...caps[i].opts, ...(o.despiteRed ? { despiteRed: true } : {}) }));
  try {
    await until(() => caps.every((c) => c.out.some((l) => l.startsWith('Waiting for another landing'))), 'the others waiting');
  } finally {
    write(root, { release: '' });
  }
  return { first: await first, codes: await Promise.all(rest), caps };
}
const said = (caps: ReturnType<typeof capture>[]): string => caps.map((c) => c.out.concat(c.err).join('\n')).join('\n---\n');

// As check.sh's Swift mock tests: run only where the mock changed (here,
// with bad.txt), or with --all; failing where bad.txt is.
const SWIFT_LIKE = 'if test -n "${THREADBEAR_CHECK_ONLY:-}"; then ' +
  'if test -f bad.txt || test "${THREADBEAR_CHECK_ALL:-}" = 1; then echo \'--only ran: "mock tests"\'; else echo \'--only ran: ""\'; fi; fi; ' +
  'if test -f bad.txt; then echo \'To run only what failed again: --only "mock tests"\'; exit 1; fi';

test('main runs what failed even where it would skip it with nothing changed, so the one that broke it is found', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break the mock');
  const { first, codes, caps } = await queued(root, main, a, [{ t: b }, { t: c }, { t: d }], recorded(root, SWIFT_LIKE));
  assert.equal(first, 0);
  assert.deepEqual(codes, [0, 1, 0], said(caps));
  assert.match(caps[1].err.join('\n'), /fails on thread\/c0000000 by itself too/);
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
  // Only main's run is asked for every step; each landing's is as it would be.
  const alone = runs(root).filter((r) => r.only);
  assert.deepEqual(alone[0], { files: 'a.txt', only: 'mock tests', all: '1' });
  for (const r of alone.slice(1)) assert.equal(r.all, '', JSON.stringify(r));
  for (const n of ['b', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
});

test('a fix in the group no longer stops the search, and a broken fix is found like any other', async () => {
  const { root, main } = makeRepo();
  const [a, f, b, c] = branches(main, ['a', 'f', 'b', 'c']);
  commit(f.path, { 'bad.txt': 'bad\n' }, 'A "fix" that breaks the mock');
  const { first, codes, caps } = await queued(root, main, a, [{ t: f, despiteRed: true }, { t: b }, { t: c }], recorded(root, SWIFT_LIKE));
  assert.equal(first, 0);
  assert.deepEqual(codes, [1, 0, 0], said(caps));
  assert.match(caps[0].err.join('\n'), /fails on thread\/f0000000 by itself too/);
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
  // a's, the group's, and the one that landed b and c: never the fix again.
  const whole = runs(root).filter((r) => !r.only).map((r) => r.files);
  assert.deepEqual(whole, ['a.txt', 'a.txt b.txt bad.txt c.txt f.txt', 'a.txt b.txt c.txt'], JSON.stringify(runs(root)));
});

test('what main fails by itself is left out, and the rest of what failed is still run on each', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break the unit tests');
  // "other step" fails wherever it's run alone (main too); "unit tests"
  // fails where bad.txt is. The group's whole check fails on bad.txt.
  const body = 'if test -n "${THREADBEAR_CHECK_ONLY:-}"; then ' +
    'echo "--only ran: \\"${THREADBEAR_CHECK_ONLY}\\""; failed=""; ' +
    'if test -f bad.txt; then echo "FAIL  unit tests            1s  log"; failed="unit tests"; else echo "ok    unit tests            1s"; fi; ' +
    'case "$THREADBEAR_CHECK_ONLY" in *"other step"*) echo "FAIL  other step            1s  log"; failed="${failed:+$failed;}other step";; esac; ' +
    'if test -n "$failed"; then echo "To run only what failed again: --only \\"$failed\\""; exit 1; fi; exit 0; fi; ' +
    'if test -f bad.txt; then echo \'To run only what failed again: --only "unit tests;other step"\'; exit 1; fi';
  const { first, codes, caps } = await queued(root, main, a, [{ t: b }, { t: c }, { t: d }], recorded(root, body));
  assert.equal(first, 0);
  assert.deepEqual(codes, [0, 1, 0], said(caps));
  assert.match(said(caps), /main fails other step by itself too, so only unit tests is run on each\./);
  assert.match(caps[1].err.join('\n'), /fails on thread\/c0000000 by itself too/);
  const alone = runs(root).filter((r) => r.only);
  assert.equal(alone[0].only, 'unit tests;other step');
  for (const r of alone.slice(1)) assert.equal(r.only, 'unit tests', JSON.stringify(r));
});

test('a group halved down to its holder sets aside the one it was narrowed to, and the next holder lands without it', async () => {
  // The check names nothing to run again, so it's the halving alone. The
  // broken one is a fix, first in every group and outside the limit: as on
  // 17 Nov. Before, each holder in turn halved down to itself.
  const { root, main } = makeRepo();
  const [a, f, b, c, d] = branches(main, ['a', 'f', 'b', 'c', 'd']);
  commit(f.path, { 'bad.txt': 'bad\n' }, 'A "fix" that breaks it');
  const body = '! test -f bad.txt';
  const { first, codes, caps } = await queued(root, main, a, [{ t: f, despiteRed: true }, { t: b }, { t: c }, { t: d }], recorded(root, body));
  assert.equal(first, 0);
  assert.deepEqual(codes, [1, 0, 0, 0], said(caps));
  for (const n of ['b', 'c', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
  // Once set aside, the fix is only ever checked by itself.
  const all = runs(root).map((r) => r.files);
  const asideAt = caps.flatMap((c) => c.out).some((l) => /^Set aside to be checked by itself, as the group failed with it and passed without: thread\/f0000000\.$/.test(l));
  const withBad = all.filter((x) => x.includes('bad.txt'));
  if (asideAt) {
    assert.match(caps[0].out.join('\n'), /Checking thread\/f0000000 by itself: a group check with it and thread\/\w+ failed/);
    // Its own check comes last, on a main that has the others by then,
    // and the one before it landed them without it.
    assert.ok(all.at(-1)!.includes('bad.txt') && !all.at(-2)!.includes('bad.txt'), JSON.stringify(all));
  }
  // At most: the group (fbcd), halved to two with the fix (f + one + the
  // holder), the holder and the fix, the holder alone, then the rest in one,
  // and the fix alone. Before, every later holder went through it again.
  assert.ok(all.length <= 7, JSON.stringify(all));
  assert.ok(withBad.length <= 4, JSON.stringify(all));
});

test('setAside: one left out of a passing check is set aside, fixes too, and the rest keep their limit on the new main', () => {
  const { main } = makeRepo();
  const common = path.join(main, '.git');
  const base = { path: main, base: 'old', commit: 'x' };
  const one = joinQueue(common, { ...base, branch: 'thread/one', limit: 2, limitAt: 'old' });
  const landed = joinQueue(common, { ...base, branch: 'thread/landed', limit: 2, limitAt: 'old' });
  const out = capture();
  setAside(common, 'old', 'new', 'thread/holder', [one, landed], new Set([landed.id]), out.opts.out);
  assert.match(readEntry(common, one.id)?.alone?.why ?? '', /^Checking thread\/one by itself: a group check with it and thread\/holder failed, and thread\/holder's next check without it passed\.$/);
  assert.equal(readEntry(common, landed.id)?.alone, undefined);
  assert.deepEqual(out.out, ['Set aside to be checked by itself, as the group failed with it and passed without: thread/one.']);
  // It says so while it waits, and nobody stacks it.
  assert.match(waitingLine(common, path.join(common, 'none'), readEntry(common, one.id)), /set aside to be checked by itself/);

  const [x, y, fix] = ['x', 'y', 'fix'].map((n) => joinQueue(common, { ...base, branch: `thread/${n}`, limit: 2, limitAt: 'old', ...(n === 'fix' ? { fix: true } : {}) }));
  const out2 = capture();
  setAside(common, 'old', 'new', 'thread/holder', [x, y, fix], new Set(), out2.opts.out);
  for (const e of [x, y]) {
    assert.equal(readEntry(common, e.id)?.alone, undefined);
    assert.deepEqual([readEntry(common, e.id)?.limit, readEntry(common, e.id)?.limitAt], [2, 'new']);
  }
  assert.ok(readEntry(common, fix.id)?.alone);
  assert.deepEqual(out2.out, ['Set aside to be checked by itself, as the group failed with it and passed without: thread/fix.']);
});

test('a landing set aside is never in anyone else\'s group, and its own tb checks it alone', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  const check = recorded(root, 'true');
  const first = land({ ...a, check }, capture().opts);
  await until(() => fs.existsSync(path.join(root, 'checking')), "a's check");
  const caps = [capture(), capture(), capture()];
  const rest = [b, c, d].map((t, i) => land({ ...t, check }, caps[i].opts));
  const common = path.join(main, '.git');
  try {
    await until(() => caps.every((x) => x.out.some((l) => l.startsWith('Waiting for another landing'))), 'the others waiting');
    const e = waiting(common).find((x) => x.branch === c.branch)!;
    fs.writeFileSync(path.join(queueDir(common), `${e.id}.json`), JSON.stringify({ ...e, alone: { at: Date.now(), why: 'Checking thread/c0000000 by itself: test.' } }));
  } finally {
    write(root, { release: '' });
  }
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 0, 0], said(caps));
  assert.ok(caps[1].out.includes('Checking thread/c0000000 by itself: test.'), said(caps));
  // c's own check had only main and c in it: b and d may already be on main.
  const cRuns = runs(root).map((r) => r.files).filter((x) => x.includes('c.txt'));
  assert.equal(cRuns.length, 1, JSON.stringify(runs(root)));
  const bd = runs(root).map((r) => r.files).filter((x) => x.includes('b.txt') && x.includes('d.txt') && !x.includes('c.txt'));
  assert.ok(bd.length >= 1, JSON.stringify(runs(root)));
});

test('a tb land stopped while it waits leaves the line and says so', async () => {
  const { root, main } = makeRepo();
  const [b] = branches(main, ['b']);
  const common = path.join(main, '.git');
  // Someone else holds the landing lock throughout.
  const lock = path.join(common, 'threadbear-land.lock');
  const hold = `touch '${root}/held'; ${holdUntil(`${root}/drop`)}`;
  const holder = spawn('/bin/sh', ['-c', process.platform === 'darwin' ? `/usr/bin/lockf -k '${lock}' /bin/sh -c "${hold}"` : `flock -x '${lock}' /bin/sh -c "${hold}"`], { stdio: 'ignore' });
  holder.on('error', () => {});
  try {
    await until(() => fs.existsSync(path.join(root, 'held')), 'the lock held');
    const src = fileURLToPath(new URL('../../src/worktrees.ts', import.meta.url));
    const script = `import { land } from ${JSON.stringify(src)}; ` +
      `process.exitCode = await land(${JSON.stringify({ ...b, check: 'true' })}, { sayWhenStopped: true });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const exited = new Promise<number | null>((r) => child.once('close', (code) => r(code)));
    await until(() => /Waiting for another landing/.test(text), 'the child waiting', 20_000);
    assert.equal(waiting(common).length, 1);
    child.kill('SIGTERM');
    assert.equal(await exited, 143, text);
    assert.match(text, /tb land was stopped \(SIGTERM\) while it waited in the landing queue, so thread\/b0000000 is out of the line and nothing of it landed\. Run tb land again to rejoin/);
    assert.deepEqual(fs.readdirSync(queueDir(common)).filter((n) => n.endsWith('.json')), []);
  } finally {
    write(root, { drop: '' });
    await new Promise((r) => holder.once('close', r));
  }
});
