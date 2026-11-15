// Daybreak 131 (15 Nov 2026): each trusted version of a patch was imported
// at a URL of its own, but its helpers at their plain path, once per
// process, with their bytes and import edges in maps by path that the
// next version wrote over. So a newer trusted version got the older one's
// helper (Node had loaded it already), and an older version's late
// import() followed the newer one's edges: code in neither version anyone
// trusted. Now every module and edge is its graph's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { verifiedUrl } from '../../src/verified-imports.ts';

type Graph = { root: string; hash: string; code: Map<string, Buffer>; links: Map<string, Map<string, string>> };

// One trusted version: `files` are its bytes by name in `dir` (what the
// hash read), `links` each file's local specifiers to the name the hash
// followed them to. What's on disk is the root's file and the helpers'
// paths, with whatever bytes; the loader serves the graph's own.
function graph(dir: string, hash: string, files: Record<string, string>, links: Record<string, Record<string, string>>): Graph {
  for (const name of Object.keys(files)) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, '// on disk: never served to a trusted graph\nexport const which = "disk";\n');
  }
  const code = new Map(Object.entries(files).map(([n, t]) => [path.join(dir, n), Buffer.from(t)]));
  const l = new Map(Object.entries(links).map(([from, specs]) => [path.join(dir, from), new Map(Object.entries(specs).map(([s, t]) => [s, path.join(dir, t)]))]));
  return { root: path.join(dir, 'p.mjs'), hash, code, links: l };
}

const load = (g: Graph) => import(verifiedUrl(g.root, g.hash, g.code, g.links)) as Promise<Record<string, unknown>>;

for (const order of ['v1 then v2', 'v2 then v1'] as const) test(`two trusted versions with different helpers each see only their own (${order})`, async () => {
  const dir = fs.realpathSync(tmpDir());
  const v1 = graph(dir, 'a'.repeat(64), { 'p.mjs': "export { which } from './h.mjs';", 'h.mjs': "export const which = 'v1';" }, { 'p.mjs': { './h.mjs': 'h.mjs' } });
  const v2 = graph(dir, 'b'.repeat(64), { 'p.mjs': "export { which } from './h.mjs';", 'h.mjs': "export const which = 'v2';" }, { 'p.mjs': { './h.mjs': 'h.mjs' } });
  const [first, second] = order === 'v1 then v2' ? [v1, v2] : [v2, v1];
  const a = await load(first);
  const b = await load(second);
  assert.equal(a.which, first === v1 ? 'v1' : 'v2');
  assert.equal(b.which, second === v1 ? 'v1' : 'v2', "the later version gets its own helper, not the one Node already loaded");
});

test("an older version's late dynamic import follows its own edges after a newer version is noted", async () => {
  const dir = fs.realpathSync(tmpDir());
  const root = "export const later = () => import('./h.mjs');";
  // The hash followed ./h.mjs to a.mjs in v1 and to b.mjs in v2 (a link
  // retargeted between them).
  const v1 = graph(dir, 'c'.repeat(64), { 'p.mjs': root, 'a.mjs': "export const which = 'v1';" }, { 'p.mjs': { './h.mjs': 'a.mjs' } });
  const v2 = graph(dir, 'd'.repeat(64), { 'p.mjs': root, 'b.mjs': "export const which = 'v2';" }, { 'p.mjs': { './h.mjs': 'b.mjs' } });
  const one = await load(v1);
  const two = await load(v2);
  assert.equal(((await (one.later as () => Promise<Record<string, unknown>>)()) as { which: string }).which, 'v1');
  assert.equal(((await (two.later as () => Promise<Record<string, unknown>>)()) as { which: string }).which, 'v2');
});

test('a second-level edge that changed between versions stays with its version, both ways round', async () => {
  const dir = fs.realpathSync(tmpDir());
  const files = (leaf: string) => ({ 'p.mjs': "export { which } from './mid.mjs';", 'mid.mjs': "export { which } from './leaf.mjs';", [leaf]: `export const which = '${leaf}';` });
  const v1 = graph(dir, 'e'.repeat(64), files('l1.mjs'), { 'p.mjs': { './mid.mjs': 'mid.mjs' }, 'mid.mjs': { './leaf.mjs': 'l1.mjs' } });
  const v2 = graph(dir, 'f'.repeat(64), files('l2.mjs'), { 'p.mjs': { './mid.mjs': 'mid.mjs' }, 'mid.mjs': { './leaf.mjs': 'l2.mjs' } });
  assert.equal((await load(v1)).which, 'l1.mjs');
  assert.equal((await load(v2)).which, 'l2.mjs');
});

test('a cycle back to the patch is the same module of the same version, not another copy', async () => {
  const dir = fs.realpathSync(tmpDir());
  const g = (hash: string, tag: string) => graph(dir, hash, {
    'p.mjs': `import { back } from './h.mjs'; export const tag = '${tag}'; export const viaHelper = () => back();`,
    'h.mjs': "import * as root from './p.mjs'; export const back = () => root.tag;",
  }, { 'p.mjs': { './h.mjs': 'h.mjs' }, 'h.mjs': { './p.mjs': 'p.mjs' } });
  const one = await load(g('1'.repeat(64), 'one'));
  const two = await load(g('2'.repeat(64), 'two'));
  assert.equal((one.viaHelper as () => string)(), 'one');
  assert.equal((two.viaHelper as () => string)(), 'two');
});

test("a helper's import.meta still names its own file", async () => {
  const dir = fs.realpathSync(tmpDir());
  const v = graph(dir, '3'.repeat(64), { 'p.mjs': "export { f, d } from './h.mjs';", 'h.mjs': 'export const f = import.meta.filename; export const d = import.meta.dirname;' }, { 'p.mjs': { './h.mjs': 'h.mjs' } });
  const m = await load(v);
  assert.equal(m.f, path.join(dir, 'h.mjs'));
  assert.equal(m.d, dir);
});

test('an import the version never followed is still refused', async () => {
  const dir = fs.realpathSync(tmpDir());
  const v = graph(dir, '4'.repeat(64), { 'p.mjs': "export const later = () => import('./other.mjs');" }, {});
  fs.writeFileSync(path.join(dir, 'other.mjs'), 'export const x = 1;');
  const m = await load(v);
  await assert.rejects((m.later as () => Promise<unknown>)(), /didn't hash/);
});
