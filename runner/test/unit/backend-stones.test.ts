// The deploy's stepping stones (runner/scripts/backend-stones.mjs): before a
// commit whose schema needs a backfill goes out, the commit before it is
// deployed and the backfill run, unless the deployment has done it. Played
// on a throwaway repo standing for every way a deployment can be behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

// Plain .mjs (Node built-ins only, as deploy-backend.mjs), loaded as deploy-steps' tests load theirs.
const { backfillsAt, lastJson, plan, stoneFor } = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'scripts', 'backend-stones.mjs')).href);

function repo() {
  const dir = tmpDir();
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const commit = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  return { dir, commit };
}

const listing = (...names: string[]) => JSON.stringify({ backfills: names.map((name) => ({ name })) }, null, 2);

test('a commit that needs a backfill deploys the widen before it first, unless the deployment is past it or has done it', () => {
  const r = repo();
  const old = r.commit('convex/sync.ts', 'v1');
  const widen = r.commit('convex/migrations.ts', 'backfill commandState');
  const narrow = r.commit('convex/migrations.json', listing('commandState'));
  const later = r.commit('convex/sync.ts', 'v2');
  assert.deepEqual(backfillsAt(r.dir, old), []);
  assert.deepEqual(backfillsAt(r.dir, later), ['commandState']);
  assert.equal(stoneFor(r.dir, later, 'commandState'), widen);
  const notDone = () => false;
  // Behind the widen (a copy that skipped it): the widen first.
  assert.deepEqual(plan(r.dir, later, old, notDone), [{ name: 'commandState', stone: widen, deployStone: true }]);
  // Nothing recorded (a deployment set up before backend.json had commits): the widen first too.
  assert.deepEqual(plan(r.dir, later, undefined, notDone), [{ name: 'commandState', stone: widen, deployStone: true }]);
  // On the widen already, or past it: just the backfill.
  assert.deepEqual(plan(r.dir, later, widen, notDone), [{ name: 'commandState', stone: widen, deployStone: false }]);
  assert.deepEqual(plan(r.dir, later, narrow, notDone), [{ name: 'commandState', stone: widen, deployStone: false }]);
  // Done there: nothing.
  assert.deepEqual(plan(r.dir, later, old, () => true), []);
});

test('two backfills go oldest stone first, and the second stone is deployed only if the first left it behind', () => {
  const r = repo();
  const old = r.commit('convex/sync.ts', 'v1');
  const widenA = r.commit('convex/migrations.ts', 'a');
  r.commit('convex/migrations.json', listing('alpha'));
  const widenB = r.commit('convex/migrations.ts', 'a b');
  const tip = r.commit('convex/migrations.json', listing('beta', 'alpha'));
  assert.deepEqual(plan(r.dir, tip, old, () => false), [
    { name: 'alpha', stone: widenA, deployStone: true },
    { name: 'beta', stone: widenB, deployStone: true },
  ]);
  // alpha done already: only beta's.
  assert.deepEqual(plan(r.dir, tip, old, (n: string) => n === 'alpha'), [{ name: 'beta', stone: widenB, deployStone: true }]);
});

test('a listing that is not JSON, or a name that could be anything, stops the deploy', () => {
  const r = repo();
  const bad = r.commit('convex/migrations.json', '{ nope');
  assert.throws(() => backfillsAt(r.dir, bad), /isn't JSON/);
  const odd = r.commit('convex/migrations.json', listing('$(rm -rf ~)'));
  assert.throws(() => backfillsAt(r.dir, odd), /no good name/);
});

test("convex run's answer is read from its last line of JSON", () => {
  assert.deepEqual(lastJson('Running migrations:run...\n{"done":true}\n'), { done: true });
  assert.equal(lastJson('true'), true);
  assert.equal(lastJson('no answer'), undefined);
});
