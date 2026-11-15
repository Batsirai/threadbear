// Every GitHub Action this repo's workflows run is pinned to a full commit
// SHA, and the Android release's signing key only meets a job that checks
// nothing out and runs no Gradle (Daybreak 123, 15 Nov 2026: the release job
// ran actions/checkout@v4 and setup-java@v4, tags anyone who takes over the
// action can move, in the job holding the key and a write token).
//
// To move an action on: look up the tag's commit
// (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`), read what
// changed, and put that SHA in with the tag in a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowsDir = path.join(repoRoot, '.github/workflows');

/** Every `uses:` value in a workflow's text, with its line number. */
export function usesOf(text: string): { line: number; ref: string }[] {
  const out: { line: number; ref: string }[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1/.exec(line);
    if (m) out.push({ line: i + 1, ref: m[2] });
  });
  return out;
}

/** Why a `uses:` value isn't pinned, or null when it is. */
export function unpinned(ref: string): string | null {
  // An action in this repo comes with the commit being run.
  if (ref.startsWith('./')) return null;
  if (ref.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/.test(ref) ? null : 'a docker image not pinned by its sha256 digest';
  const at = ref.lastIndexOf('@');
  if (at < 0) return 'no ref at all';
  return /^[0-9a-f]{40}$/.test(ref.slice(at + 1)) ? null : `"${ref.slice(at + 1)}" is a tag or branch, which can be moved`;
}

/** A workflow's jobs, each as its own text (two-space-indented keys under `jobs:`). */
export function jobsOf(text: string): Map<string, string> {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  const jobs = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  heads.forEach((m, i) => jobs.set(m[1], body.slice(m.index, heads[i + 1]?.index ?? body.length)));
  return jobs;
}

function workflows(): [string, string][] {
  return fs
    .readdirSync(workflowsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(workflowsDir, f), 'utf8')]);
}

test('the check itself tells a pinned action from a movable one', () => {
  assert.equal(unpinned('actions/checkout@11d5960a326750d5838078e36cf38b85af677262'), null);
  assert.equal(unpinned('actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9'), null);
  assert.equal(unpinned('./.github/actions/local'), null);
  assert.match(unpinned('actions/checkout@v4')!, /can be moved/);
  assert.match(unpinned('dtolnay/rust-toolchain@stable')!, /can be moved/);
  // A short SHA is a prefix GitHub resolves like a ref, not a pin.
  assert.match(unpinned('actions/checkout@11d5960')!, /can be moved/);
  assert.match(unpinned('docker://alpine:3')!, /digest/);
  assert.deepEqual(usesOf("      - uses: 'actions/setup-java@v4' # v4\n        uses: actions/x@abc"), [
    { line: 1, ref: 'actions/setup-java@v4' },
    { line: 2, ref: 'actions/x@abc' },
  ]);
});

test('every action in every workflow is pinned to a full commit SHA', () => {
  const bad: string[] = [];
  let seen = 0;
  for (const [file, text] of workflows()) {
    for (const { line, ref } of usesOf(text)) {
      seen++;
      const why = unpinned(ref);
      if (why) bad.push(`.github/workflows/${file}:${line} ${ref}: ${why}`);
    }
  }
  assert.ok(seen > 5, 'found no actions at all, so the check is reading the wrong place');
  assert.deepEqual(bad, [], 'Pin these to a commit SHA, with the tag in a comment');
});

test('the Android signing key only meets a job with no checkout and no Gradle', () => {
  const text = fs.readFileSync(path.join(workflowsDir, 'android.yml'), 'utf8');
  const jobs = jobsOf(text);
  const keyed = [...jobs].filter(([, body]) => /secrets\.ANDROID_KEYSTORE/.test(body));
  assert.deepEqual(keyed.map(([name]) => name), ['release'], 'only the release job names the key or its password');
  const [, release] = keyed[0];
  assert.doesNotMatch(release, /actions\/checkout|gradlew|setup-java|\buses:\s*\.\//, 'the signing job runs no repo code');
  // Its only action is GitHub's artifact download, and it signs only the
  // bytes the build job hashed.
  assert.deepEqual(usesOf(release).map((u) => u.ref.split('@')[0]), ['actions/download-artifact']);
  assert.match(release, /needs\.apk\.outputs\.sha256/);
  assert.match(release, /sha256sum/);
  // The build job has the Firebase config and a read-only token, never the key.
  const build = jobs.get('apk')!;
  assert.match(build, /contents: read/);
  assert.doesNotMatch(build, /contents: write|KEYSTORE/);
  assert.match(build, /persist-credentials: false/);
});
