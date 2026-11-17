// Stepping stones for a backend deploy (deploy-backend.mjs, convex/migrations.ts).
//
// A schema change that makes a field required can only be deployed once every
// stored row has it: Convex checks every row against the new schema and
// refuses the deploy otherwise. Threadbear's backends upgrade themselves to
// whatever commit their main Mac's runner updates to, often skipping many
// commits (other people's copies bring Mike's releases in days apart), so
// "deploy the widen, backfill, then deploy the narrow" can't rely on each step
// being deployed in turn.
//
// So a commit that needs a backfill lists it in convex/migrations.json:
//
//   { "backfills": [{ "name": "commandState" }] }
//
// The commit that first lists a name must come straight after the one that
// added the backfill to convex/migrations.ts (the widen): that parent is the
// stepping stone. Before deploying a commit, the deploy script asks the
// deployment whether each listed backfill has finished (`migrations:done`),
// and for one that hasn't, deploys the stone first (unless what's deployed is
// already it or later), runs `migrations:run` until it says done, and only
// then deploys the commit. A deployment that has done it skips all of this.
//
// Node built-ins only, like deploy-backend.mjs.
import { spawnSync } from 'node:child_process';

export const MIGRATIONS_FILE = 'convex/migrations.json';
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/** The backfills a commit needs before it can be deployed, by name. */
export function backfillsAt(repo, commit) {
  const r = git(repo, ['show', `${commit}:${MIGRATIONS_FILE}`]);
  if (!r.ok) return [];
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch (e) {
    throw new Error(`${MIGRATIONS_FILE} at ${commit.slice(0, 7)} isn't JSON: ${e.message}`);
  }
  const list = Array.isArray(parsed?.backfills) ? parsed.backfills : [];
  return list.map((b) => {
    if (!NAME.test(String(b?.name ?? ''))) throw new Error(`${MIGRATIONS_FILE} at ${commit.slice(0, 7)} has a backfill with no good name`);
    return b.name;
  });
}

/** The stone for a backfill: the parent of the first commit (in `commit`'s history) that listed it. */
export function stoneFor(repo, commit, name) {
  const r = git(repo, ['log', '--format=%H', '--reverse', '--first-parent', '-S', `"${name}"`, commit, '--', MIGRATIONS_FILE]);
  if (!r.ok) throw new Error(`git log for ${name} failed: ${r.err}`);
  const first = r.out.split('\n').find((h) => h && backfillsAt(repo, h).includes(name));
  if (!first) throw new Error(`No commit before ${commit.slice(0, 7)} lists the backfill ${name}`);
  const parent = git(repo, ['rev-parse', `${first}^`]);
  if (!parent.ok) throw new Error(`The commit that lists ${name} has no parent to deploy first`);
  return parent.out;
}

/** Whether `ancestor` is `commit` or comes before it. */
export function atOrAfter(repo, commit, ancestor) {
  if (!commit) return false;
  return git(repo, ['merge-base', '--is-ancestor', ancestor, commit]).ok;
}

/**
 * What to do before deploying `commit`, given what's deployed now and what the
 * deployment says is done: for each backfill not done, its stone, and whether
 * the stone has to be deployed first (it isn't when what's deployed is the
 * stone or later). `isDone(name)` asks the deployment.
 */
export function plan(repo, commit, deployed, isDone) {
  const steps = [];
  for (const name of backfillsAt(repo, commit)) {
    if (isDone(name)) continue;
    const stone = stoneFor(repo, commit, name);
    steps.push({ name, stone, depth: Number(git(repo, ['rev-list', '--count', '--first-parent', stone]).out) || 0 });
  }
  // Oldest stone first, so no deploy goes back to an older one. Whether each
  // stone needs deploying depends on what the one before left deployed.
  steps.sort((a, b) => a.depth - b.depth);
  let now = deployed;
  return steps.map(({ name, stone }) => {
    const deployStone = !atOrAfter(repo, now, stone);
    if (deployStone) now = stone;
    return { name, stone, deployStone };
  });
}

/** The answer `npx convex run` printed: its last line of JSON. */
export function lastJson(text) {
  const lines = String(text).trim().split('\n').reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // not this one
    }
  }
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}
