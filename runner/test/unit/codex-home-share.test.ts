// An extra Codex login (codex-N, its own CODEX_HOME) gets ~/.codex's
// instructions, hooks, skills and config.toml as links, and its hooks the
// trust they have in ~/.codex (codex-home-share.ts). codex-1 on the M5 ran
// without any of them until 23 Nov 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookTrust, onlyProjectTrust, readHookStates, shareCodexHome } from '../../src/codex-home-share.ts';

function homes() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-share-')));
  const main = path.join(root, '.codex');
  const login = path.join(root, 'Accounts', 'codex-1');
  fs.mkdirSync(path.join(main, 'skills', '.system'), { recursive: true });
  fs.mkdirSync(path.join(main, 'skills', 'delegate'), { recursive: true });
  fs.mkdirSync(path.join(main, 'skills', 'render-box'), { recursive: true });
  fs.mkdirSync(path.join(login, 'skills', '.system'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Mike\n');
  fs.symlinkSync(path.join(root, 'CLAUDE.md'), path.join(main, 'AGENTS.md'));
  fs.writeFileSync(path.join(main, 'hooks.json'), '{"hooks":{}}');
  fs.writeFileSync(
    path.join(main, 'config.toml'),
    [
      'model = "gpt-6.1-sol"',
      '',
      '[mcp_servers.connectors]',
      'url = "https://example.test/mcp"',
      '',
      `[hooks.state."${main}/hooks.json:pre_tool_use:0:0"]`,
      'trusted_hash = "sha256:aaa"',
      '',
      `[hooks.state."${main}/hooks.json:session_start:0:0"]`,
      'trusted_hash = "sha256:bbb"',
      'enabled = false',
      '',
      '[hooks.state."/elsewhere/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:ccc"',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(login, 'auth.json'), '{}');
  fs.writeFileSync(path.join(login, 'config.toml'), '\n[projects."/Users/me/dev/thing"]\ntrust_level = "trusted"\n');
  return { root, main, login };
}

test('a fresh login gets links to the main home, its own files untouched', () => {
  const { main, login } = homes();
  const report = shareCodexHome(main, login, '2026-11-23');
  assert.deepEqual(report.skipped, []);
  for (const name of ['AGENTS.md', 'hooks.json', 'config.toml']) assert.equal(fs.readlinkSync(path.join(login, name)), path.join(main, name));
  assert.equal(fs.readFileSync(path.join(login, 'AGENTS.md'), 'utf8'), '# Mike\n');
  assert.equal(fs.readlinkSync(path.join(login, 'skills', 'delegate')), path.join(main, 'skills', 'delegate'));
  assert.equal(fs.readlinkSync(path.join(login, 'skills', 'render-box')), path.join(main, 'skills', 'render-box'));
  // Codex's own system skills stay the login's, as do its tokens.
  assert.ok(!fs.lstatSync(path.join(login, 'skills', '.system')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(login, 'auth.json'), 'utf8'), '{}');
  // The trust-only config.toml Codex wrote is kept beside the link.
  assert.match(fs.readFileSync(path.join(login, 'config.toml.before-share-2026-11-23'), 'utf8'), /trust_level/);
  // Once shared, a second pass changes nothing.
  assert.deepEqual(shareCodexHome(main, login, '2026-11-23'), { changes: [], skipped: [] });
});

test("a login's own config.toml with settings, or its own AGENTS.md, is left alone", () => {
  const { main, login } = homes();
  fs.writeFileSync(path.join(login, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  fs.writeFileSync(path.join(login, 'AGENTS.md'), '# its own\n');
  const report = shareCodexHome(main, login);
  assert.equal(fs.readFileSync(path.join(login, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "keyring"\n');
  assert.equal(fs.readFileSync(path.join(login, 'AGENTS.md'), 'utf8'), '# its own\n');
  assert.equal(report.skipped.length, 2);
  assert.equal(fs.readlinkSync(path.join(login, 'hooks.json')), path.join(main, 'hooks.json'));
});

test('the main home itself, or a link to it, is never touched', () => {
  const { root, main } = homes();
  assert.deepEqual(shareCodexHome(main, main), { changes: [], skipped: [] });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(main, alias);
  assert.deepEqual(shareCodexHome(main, alias), { changes: [], skipped: [] });
  assert.deepEqual(hookTrust(main, alias), {});
});

test("a skill deleted from the main home loses its link; the login's own skills stay", () => {
  const { main, login } = homes();
  fs.mkdirSync(path.join(login, 'skills', 'mine'));
  shareCodexHome(main, login);
  fs.rmSync(path.join(main, 'skills', 'render-box'), { recursive: true });
  const report = shareCodexHome(main, login);
  assert.ok(!fs.existsSync(path.join(login, 'skills', 'render-box')));
  assert.ok(fs.existsSync(path.join(login, 'skills', 'mine')));
  assert.equal(report.changes.length, 1);
});

test("hooks get the main home's trust under the login's own path", () => {
  const { main, login } = homes();
  // Not shared yet: the login's hooks aren't the main ones, so no trust.
  assert.deepEqual(hookTrust(main, login), {});
  shareCodexHome(main, login);
  assert.deepEqual(hookTrust(main, login), {
    'hooks.state': {
      [`${login}/hooks.json:pre_tool_use:0:0`]: { trusted_hash: 'sha256:aaa' },
      [`${login}/hooks.json:session_start:0:0`]: { trusted_hash: 'sha256:bbb', enabled: false },
    },
  });
});

test('a hooks.json of the login\'s own gets no trust from the main home', () => {
  const { main, login } = homes();
  fs.writeFileSync(path.join(login, 'hooks.json'), '{"hooks":{}}');
  shareCodexHome(main, login);
  assert.deepEqual(hookTrust(main, login), {});
});

test('readHookStates and onlyProjectTrust read what Codex writes', () => {
  const states = readHookStates('[hooks.state]\n\n[hooks.state."C:\\\\x\\\\hooks.json:stop:0:0"]\ntrusted_hash = "sha256:1"\n[apps.x]\ntrusted_hash = "no"\n');
  assert.deepEqual([...states], [['C:\\x\\hooks.json:stop:0:0', { trusted_hash: 'sha256:1' }]]);
  assert.ok(onlyProjectTrust('[projects."/a"]\ntrust_level = "trusted"\n\n[projects.\'/b\']\ntrust_level = "untrusted"\n'));
  assert.ok(!onlyProjectTrust('model = "x"\n[projects."/a"]\ntrust_level = "trusted"\n'));
  assert.ok(!onlyProjectTrust('[projects."/a"]\ntrust_level = "trusted"\n[mcp_servers.x]\ncommand = "y"\n'));
});

// From the Codex review of 23 Nov 2026: trust text inside a multi-line
// string isn't trust, and Codex's other valid spellings still count.
test('hook states inside a multi-line string are not read; commented headers and inline tables are', () => {
  const fake = '[hooks.state."/h/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:fake"';
  const text = [
    `developer_instructions = """\n${fake}\n"""`,
    `other = '''\n${fake}\n'''`,
    'one_line = "a \\"\\"\\" b"',
    '[hooks.state."/h/hooks.json:stop:0:0"] # a guard',
    'trusted_hash = "sha256:real" # set by codex',
    '[hooks.state]',
    `'/h/hooks.json:session_start:0:0' = { trusted_hash = "sha256:inline", enabled = false }`,
  ].join('\n');
  assert.deepEqual(Object.fromEntries(readHookStates(text)), {
    '/h/hooks.json:stop:0:0': { trusted_hash: 'sha256:real' },
    '/h/hooks.json:session_start:0:0': { trusted_hash: 'sha256:inline', enabled: false },
  });
});

test("a config.toml moved aside never replaces an earlier one, and comes back if the link can't be made", () => {
  const { main, login } = homes();
  shareCodexHome(main, login, '2026-11-23');
  // Codex made a new trust-only file in its place, the same day.
  fs.unlinkSync(path.join(login, 'config.toml'));
  fs.writeFileSync(path.join(login, 'config.toml'), '[projects."/b"]\ntrust_level = "trusted"\n');
  shareCodexHome(main, login, '2026-11-23');
  assert.match(fs.readFileSync(path.join(login, 'config.toml.before-share-2026-11-23'), 'utf8'), /thing/);
  assert.match(fs.readFileSync(path.join(login, 'config.toml.before-share-2026-11-23-2'), 'utf8'), /"\/b"/);
  // A link refused (as on Windows without the right): the file stays.
  fs.unlinkSync(path.join(login, 'config.toml'));
  fs.writeFileSync(path.join(login, 'config.toml'), '[projects."/c"]\ntrust_level = "trusted"\n');
  const real = fs.symlinkSync;
  (fs as { symlinkSync: typeof fs.symlinkSync }).symlinkSync = () => {
    throw new Error('EPERM: operation not permitted');
  };
  try {
    const report = shareCodexHome(main, login, '2026-11-24');
    assert.equal(report.skipped.length, 1);
  } finally {
    (fs as { symlinkSync: typeof fs.symlinkSync }).symlinkSync = real;
  }
  assert.ok(!fs.lstatSync(path.join(login, 'config.toml')).isSymbolicLink());
  assert.match(fs.readFileSync(path.join(login, 'config.toml'), 'utf8'), /"\/c"/);
  assert.ok(!fs.existsSync(path.join(login, 'config.toml.before-share-2026-11-24')));
});

// From the Gemini review of 23 Nov 2026.
test("a main home that keeps its sign-in in the Keychain doesn't send the login there", () => {
  const { main, login } = homes();
  shareCodexHome(main, login);
  assert.ok(fs.lstatSync(path.join(login, 'config.toml')).isSymbolicLink());
  const text = fs.readFileSync(path.join(main, 'config.toml'), 'utf8');
  fs.writeFileSync(path.join(main, 'config.toml'), `cli_auth_credentials_store = "keyring"\n${text}`);
  shareCodexHome(main, login);
  assert.ok(!fs.existsSync(path.join(login, 'config.toml')) && !fs.lstatSync(path.join(login, 'config.toml'), { throwIfNoEntry: false }));
  assert.equal(shareCodexHome(main, login).skipped.length, 1);
});

test('a link whose file left the main home goes too', () => {
  const { main, login } = homes();
  shareCodexHome(main, login);
  fs.unlinkSync(path.join(main, 'AGENTS.md'));
  const report = shareCodexHome(main, login);
  assert.equal(fs.lstatSync(path.join(login, 'AGENTS.md'), { throwIfNoEntry: false }), undefined);
  assert.equal(report.changes.length, 1);
});

test("single-quoted hashes count; a skills file where the folder should be doesn't stop the rest", () => {
  assert.deepEqual(Object.fromEntries(readHookStates(`[hooks.state.'C:\\h\\hooks.json:stop:0:0']\ntrusted_hash = 'sha256:lit'\n`)), {
    'C:\\h\\hooks.json:stop:0:0': { trusted_hash: 'sha256:lit' },
  });
  const { main, login } = homes();
  fs.rmSync(path.join(login, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(login, 'skills'), 'not a folder');
  const report = shareCodexHome(main, login);
  assert.equal(report.skipped.length, 1);
  assert.equal(fs.readlinkSync(path.join(login, 'hooks.json')), path.join(main, 'hooks.json'));
  assert.ok(Object.keys(hookTrust(main, login)).length);
});
