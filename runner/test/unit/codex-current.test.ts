// Threadbear's own Codex copies (src/updates/codex.ts): `current` is a link,
// and on Windows a file naming the version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCopies } from '../../src/updates/codex.ts';

function copies(platform: NodeJS.Platform): { c: CodexCopies; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-cur-'));
  for (const v of ['0.1.0', '0.2.0']) {
    const pkg = path.join(dir, v, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: v }));
  }
  const c = new CodexCopies({ dir, platform, npmPath: 'npm', exec: async () => ({ code: 0, stdout: '', stderr: '' }), env: {}, tmpDir: dir, now: () => 0 } as unknown as ConstructorParameters<typeof CodexCopies>[0]);
  return { c, dir };
}

test("on Windows, current is a file naming the version, and Codex starts from that version's folder", () => {
  const { c, dir } = copies('win32');
  try {
    assert.equal(c.currentVersion(), undefined);
    c.activate('0.1.0');
    assert.equal(fs.lstatSync(path.join(dir, 'current')).isSymbolicLink(), false);
    assert.equal(c.currentVersion(), '0.1.0');
    assert.equal(c.currentLink, path.join(dir, '0.1.0'));
    c.activate('0.2.0');
    assert.equal(c.currentVersion(), '0.2.0');
    assert.equal(c.state().previous, '0.1.0');
    // A file naming something that isn't a version there counts for nothing.
    fs.writeFileSync(path.join(dir, 'current'), '..\\elsewhere\n');
    assert.equal(c.currentVersion(), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('elsewhere current stays a link Codex starts through', { skip: process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false }, () => {
  const { c, dir } = copies('darwin');
  try {
    c.activate('0.1.0');
    assert.equal(fs.readlinkSync(path.join(dir, 'current')), '0.1.0');
    assert.equal(c.currentLink, path.join(dir, 'current'));
    assert.equal(c.currentVersion(), '0.1.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
