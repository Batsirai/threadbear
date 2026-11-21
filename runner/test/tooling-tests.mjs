#!/usr/bin/env node
// Which of the runner's slow tooling tests a check can leave out.
//
// Most of the unit suite's time (about two thirds of 33 CPU minutes on
// 21 Nov) goes on tests of the dev tooling: the check hosts
// (scripts/check-remote.sh), the build and measurement locks, remote.sh,
// landing, the release fetcher. A landing that touches none of what one of
// them reads can't change its result, so `check.sh --quick` leaves those
// files out (Ville's fork, 21 Nov: about half of every 12 to 29 minute
// check on an M1 Pro).
//
// A tooling test runs whenever any of the tooling changes (TOOLING_PATHS:
// the scripts folders, the test helpers, the dev app's tools), and also
// when anything it reads does (`reads`, below): what it and its helpers
// import, all the way down, and the files they name (a script it runs).
// What those scripts name in turn isn't followed: scripts name each other
// so widely (in comments as well) that it reached nearly every file, and
// nothing was ever left out. GitHub's CI runs the whole suite on main.
//   node test/tooling-tests.mjs <repo root> < changed-files
//     prints the test files to leave out, one a line (paths from runner/)
//   --why   prints, for each, what it reads (for a person, not check.sh)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The slow ones, each over about 10 CPU seconds a run (21 Nov), testing the
// dev tooling or code that only the tooling runs.
export const TOOLING = [
  'perf-lock', 'perf-swift', 'remote-cache', 'shared-cargo', 'limit-step',
  'check-remote-room-failures', 'check-remote-room', 'check-remote-drops',
  'check-remote-line', 'check-remote-copies', 'stage-update-hosts',
  'land-queue', 'land-alone', 'land-culprit', 'land-push',
  'worktrees-cleanup', 'worktrees-landing', 'worktrees-spares', 'borrows',
  'upstream-releases', 'upstream-refs', 'upstream-limits',
  'format-replay', 'format-tool', 'release', 'tb-dev', 'gpui-dev-app',
  'check-mock-swift-tests', 'check-feature-pairing',
].map((n) => `test/unit/${n}.test.ts`);

// A change to any of these runs every test: they shape every run.
const ALWAYS = /^(check\.sh|package(-lock)?\.json|runner\/package(-lock)?\.json|runner\/tsconfig\.json|runner\/test\/helpers\/(clean-env\.ts|failed-files-reporter\.mjs)|runner\/test\/tooling-tests\.mjs|\.nvmrc|runner\/\.nvmrc)$/;

// Any change here runs every tooling test.
const TOOLING_PATHS = /^(scripts\/|desktop\/scripts\/|runner\/scripts\/|runner\/bin\/|runner\/launcher\/|runner\/launch\.mjs$|runner\/test\/helpers\/|runner\/test\/deploy\/|features\/tools\/|features\/support\/|app\/Tools\/|mock-runner\/|[^/]+\.sh$|\.threadbear\/)/;

const NAME = /[A-Za-z0-9_][A-Za-z0-9_.@-]*\.(?:sh|pl|pm|mjs|cjs|js|ts|tsx|json|toml|md|swift|rs|py)\b/g;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', '.build', 'dist', 'build', '.fixtures', 'DerivedData']);

function repoFiles(root) {
  const byBase = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const rel = path.relative(root, p);
        if (!byBase.has(e.name)) byBase.set(e.name, []);
        byBase.get(e.name).push(rel);
      }
    }
  };
  walk(root);
  return byBase;
}

// What a test reads: itself, its helpers (runner/test/helpers), everything
// those import, all the way down (release.test.ts boots src/main.ts, so it
// reads all main.ts imports; Codex's and Gemini's reviews), and the repo
// files the test and its helpers name. A name in a file reached only by
// import doesn't count: the runner's comments name half the repo.
export function reads(root, start, byBase) {
  const seen = new Set();
  const todo = [start];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (text.length > 2_000_000 || text.includes('\0')) continue;
    const code = /\.(ts|tsx|mts|js|mjs|cjs)$/.test(rel) || rel.startsWith('runner/bin/');
    if (code) {
      for (const m of text.matchAll(IMPORT)) {
        const p = path.normalize(path.join(path.dirname(rel), m[1]));
        for (const c of [p, p + '.ts', p + '.js', p + '/index.ts']) {
          if (fs.existsSync(path.join(root, c)) && fs.statSync(path.join(root, c)).isFile()) { todo.push(c); break; }
        }
      }
    }
    if (rel !== start && !rel.startsWith('runner/test/helpers/')) continue;
    for (const m of text.matchAll(NAME)) {
      for (const c of byBase.get(m[0]) ?? []) if (!c.startsWith('runner/test/unit/')) todo.push(c);
    }
    // `tb` has no extension: a test that runs it (bin/tb, or 'bin', 'tb' in
    // a path.join) reads all of cli.ts.
    if (/bin\/tb\b|['"]bin['"]\s*,\s*['"]tb['"]|\bTB\b/.test(text)) todo.push('runner/bin/tb');
  }
  return seen;
}

export function leaveOut(root, changed) {
  if (!changed.length || changed.some((f) => ALWAYS.test(f) || TOOLING_PATHS.test(f))) return [];
  const byBase = repoFiles(root);
  const changedSet = new Set(changed);
  const out = [];
  for (const t of TOOLING) {
    const rel = `runner/${t}`;
    if (!fs.existsSync(path.join(root, rel))) continue;
    const r = reads(root, rel, byBase);
    if (![...r].some((f) => changedSet.has(f))) out.push({ test: t, reads: r });
  }
  return out;
}

// Run as a script (check.sh), whatever path or link it was named by.
const self = fs.realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === self) {
  const root = path.resolve(process.argv[2] ?? '.');
  const why = process.argv.includes('--why');
  const changed = fs.readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const { test, reads: r } of leaveOut(root, changed)) {
    console.log(test);
    if (why) console.log(`  reads ${r.size} files: ${[...r].slice(0, 30).join(' ')}`);
  }
}
