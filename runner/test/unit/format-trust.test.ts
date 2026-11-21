// What tb land will run from a branch's .git-blame-ignore-revs (Codex
// Security finding 151, 21 Nov 2026): a format command only main's own list
// has, byte for byte, with config main has, and never over a tree that
// brings its own toolchain. Each test's command leaves a marker file where it
// would run, so "not run" is checked on disk. Real git in temp repos, as
// format-tool.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, commit, makeBranch, makeRepo, sh } from '../helpers/worktrees-harness.ts';
import { land } from '../../src/worktrees.ts';
import { crossings, remakeOwn, TreeFormatter } from '../../src/format-replay.ts';

const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'split-protocol.mjs'), 'utf8');
const SUBJECT = 'Split docs/protocol.md into a file per area, moving text only';
const entry = (command: string, subject = SUBJECT) => `# format-subject: ${subject}\n# format-tool: ${command}\n# format-paths: docs/protocol.md docs/protocol\n# format-config: scripts/split-protocol.mjs\n`;
const TRUSTED = entry('node scripts/split-protocol.mjs');
const DOC = ['# Runner protocol (v1)', '', 'Intro.', '', '## Auth', '', 'A token.', '', '## Needs you', '', 'The card.', '', '## Patches', '', 'A patch file.', ''].join('\n');

// A main with the split script, and the list as given (none by default:
// the branch is the first to bring a tool in).
function setup(list?: string) {
  const { root, main } = makeRepo();
  commit(main, { 'docs/protocol.md': DOC, 'scripts/split-protocol.mjs': SCRIPT, ...(list ? { '.git-blame-ignore-revs': list } : {}) }, 'Protocol and the script');
  const marker = path.join(root, 'ran');
  return { main, marker };
}

// The branch's tool commit: the real split, made by hand, with the list as
// the branch writes it.
function splitOn(dir: string, list: string, subject = SUBJECT) {
  fs.writeFileSync(path.join(dir, '.git-blame-ignore-revs'), list);
  sh(dir, 'git add .git-blame-ignore-revs && (git diff --cached --quiet || git commit -qm "List the split")');
  sh(dir, 'node scripts/split-protocol.mjs');
  sh(dir, `git add -A docs && git commit -qm "${subject}"`);
}

const mainMoves = (main: string) => commit(main, { 'docs/protocol.md': DOC.replace('A patch file.', 'A patch file, on main.') }, 'Main edits patches');

test('a branch that adds a format command main has never listed: tb land stops and runs nothing', async () => {
  const { main, marker } = setup();
  const t = makeBranch(main);
  splitOn(t.path, entry(`touch ${marker}; node scripts/split-protocol.mjs`));
  mainMoves(main);
  const before = sh(main, 'git rev-parse main');
  const r = await remakeOwn(main, 'main', t.branch);
  assert.ok(r && !r.ok && 'untrusted' in r, JSON.stringify(r));
  assert.equal(r.untrusted[0].why, 'unlisted');
  assert.ok(r.untrusted[0].command.includes(marker));
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.equal(fs.existsSync(marker), false, 'the branch\'s command ran');
  assert.match(c.err.join('\n'), /doesn't list, so it wasn't run here and nothing landed/);
  assert.ok(c.err.join('\n').includes(JSON.stringify(`touch ${marker}; node scripts/split-protocol.mjs`)), 'the whole command is shown');
  assert.equal(sh(main, 'git rev-parse main'), before);
});

test('a branch that changes the command of an entry main does list is stopped the same way', async () => {
  const { main, marker } = setup(TRUSTED);
  const t = makeBranch(main);
  splitOn(t.path, entry(`node scripts/split-protocol.mjs && touch ${marker}`));
  mainMoves(main);
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.equal(fs.existsSync(marker), false);
  // And its paths or config count as much as its command.
  const t2 = makeBranch(main, 'paths123');
  splitOn(t2.path, TRUSTED.replace('docs/protocol.md docs/protocol', 'docs'));
  commit(main, { 'docs/protocol.md': DOC.replace('The card.', 'The card, on main.') }, 'Main edits the card');
  const r = await remakeOwn(main, 'main', t2.branch);
  assert.ok(r && !r.ok && 'untrusted' in r, JSON.stringify(r));
});

test('main\'s exact command with a config script the branch changed first is never run', async () => {
  const { main, marker } = setup(TRUSTED);
  const t = makeBranch(main);
  commit(t.path, { 'scripts/split-protocol.mjs': `import * as markIt from 'node:fs';\nmarkIt.writeFileSync(${JSON.stringify(marker)}, '');\n${SCRIPT.replace(/^#!.*\n/, "")}` }, 'Tweak the script');
  splitOn(t.path, TRUSTED);
  fs.rmSync(marker, { force: true });
  mainMoves(main);
  const r = await remakeOwn(main, 'main', t.branch);
  assert.ok(r && !r.ok && 'untrusted' in r, JSON.stringify(r));
  assert.equal(r.untrusted[0].why, 'config');
  const c = capture();
  assert.notEqual(await land(t, c.opts), 0);
  assert.equal(fs.existsSync(marker), false);
});

test('main\'s exact recipe is still made again on a main that moved on', async () => {
  const { main } = setup(TRUSTED);
  const t = makeBranch(main);
  splitOn(t.path, TRUSTED);
  mainMoves(main);
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /Made .* again on main/);
  assert.match(sh(main, 'git show main:docs/protocol/patches.md'), /A patch file, on main\./);
});

test('an unlisted tool commit already made on main as it is lands as a plain commit, nothing run', async () => {
  const { main, marker } = setup();
  mainMoves(main);
  const t = makeBranch(main);
  splitOn(t.path, entry(`touch ${marker}; node scripts/split-protocol.mjs`));
  assert.equal(await remakeOwn(main, 'main', t.branch), undefined);
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(sh(main, 'git log --format=%s -1'), SUBJECT);
});

test('a trusted command isn\'t run over a tree that brings its own toolchain file, cargo config or a link', { skip: process.platform === 'win32' }, async () => {
  for (const [name, add] of [
    ['toolchain', (d: string) => commit(d, { 'docs/protocol/rust-toolchain': '[toolchain]\npath = "./evil"\n' }, 'Toolchain')],
    ['cargo', (d: string) => commit(d, { 'docs/protocol/.cargo/config.toml': '[alias]\nfmt = "run"\n' }, 'Cargo config')],
    ['mise', (d: string) => commit(d, { 'docs/mise.toml': '[env]\n_.source = "./evil.sh"\n' }, 'Mise')],
    ['link', (d: string) => sh(d, 'mkdir -p docs/protocol && ln -s /tmp docs/protocol/out && git add docs/protocol/out && git commit -qm Link')],
  ] as const) {
    const { main, marker } = setup();
    // A format command on main that leaves a marker, over docs/.
    const list = `# format-subject: Format docs\n# format-command: touch ${marker}\n# format-paths: docs\n`;
    commit(main, { '.git-blame-ignore-revs': list }, 'List');
    const p = sh(main, 'git rev-parse HEAD');
    const t = makeBranch(main, `steer${name.slice(0, 3)}`);
    add(t.path);
    commit(t.path, { 'docs/protocol.md': DOC + 'more\n' }, 'Edit');
    const tip = sh(t.path, 'git rev-parse HEAD');
    commit(main, { 'docs/x.md': 'formatted\n' }, 'Format docs');
    const cross = await crossings(main, tip, 'main');
    assert.equal(cross.length, 1, name);
    // Main's own tree it runs over...
    const f = new TreeFormatter(main, cross);
    await f.format(sh(main, `git rev-parse ${p}^{tree}`));
    assert.equal(fs.existsSync(marker), true, `${name}: the command runs at all`);
    fs.rmSync(marker);
    // ...the branch's, never.
    const out = await f.format(sh(main, `git rev-parse ${tip}^{tree}`));
    assert.equal(fs.existsSync(marker), false, `${name}: ran over the branch's tree`);
    assert.match(out.failed.join(' '), /wasn't run on this tree/, name);
  }
});
