// Every file a mock runner fixture names by a relative path is there. The
// mock resolves them from the fixture's own folder and quietly does without
// one it can't read (a review's picture keeps its old path and its page is
// never made), so a fixture moved to another depth broke the review page's
// specs with nothing saying why (21 Nov 2026: mock-runner/ moved up out of
// app/Tools, and the design review's ../../../../../docs pictures pointed
// past the repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES = path.resolve(import.meta.dirname, '../../../mock-runner/fixtures');

test("every relative path in the mock runner's fixtures is a file that's there", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const name of fs.readdirSync(FIXTURES)) {
    const dir = path.join(FIXTURES, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter((f) => /\.(json|ndjson)$/.test(f))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      // The fixture's own media/, or reaching out of its folder with ../
      // (other paths in a fixture are the made-up thread's, like Sources).
      for (const m of text.matchAll(/"path"\s*:\s*"((?:\.\.\/|\.\/|media\/)[^"]*)"/g)) {
        checked++;
        if (!fs.existsSync(path.resolve(dir, m[1]))) missing.push(`${name}/${file}: ${m[1]}`);
      }
    }
  }
  assert.ok(checked > 0, 'found no relative paths, so the scan is wrong');
  assert.deepEqual(missing, [], "these fixtures name files that aren't there, from the fixture's own folder");
});
