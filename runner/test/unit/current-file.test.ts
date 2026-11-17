// On Windows <home>/runner/current is a file with the release's id, not a
// symlink (launch.mjs's readCurrentLink says why). Both readers agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error launch.mjs has no types
import { pointCurrent, readCurrentLink } from '../../launch.mjs';
import { currentLink } from '../../src/release.ts';

function home(): { home: string; dir: string } {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-current-'));
  const dir = path.join(h, 'runner');
  fs.mkdirSync(path.join(dir, 'releases', 'r1'), { recursive: true });
  return { home: h, dir };
}

test("Windows' current is a file naming the release, swapped by rename", () => {
  const { home: h, dir } = home();
  try {
    pointCurrent(dir, 'r1', 'win32');
    assert.equal(fs.lstatSync(path.join(dir, 'current')).isSymbolicLink(), false);
    assert.equal(readCurrentLink(dir, 'win32'), 'r1');
    assert.equal(currentLink(h, 'win32'), 'r1');
    pointCurrent(dir, 'r2', 'win32');
    assert.equal(readCurrentLink(dir, 'win32'), 'r2');
    // Off Windows a plain file isn't current.
    assert.equal(readCurrentLink(dir, 'darwin'), null);
    // Nor a path in the file.
    fs.writeFileSync(path.join(dir, 'current'), '..\\elsewhere\n');
    assert.equal(readCurrentLink(dir, 'win32'), null);
    assert.equal(currentLink(h, 'win32'), undefined);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('elsewhere current stays a relative symlink', { skip: process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false }, () => {
  const { home: h, dir } = home();
  try {
    pointCurrent(dir, 'r1');
    assert.equal(fs.readlinkSync(path.join(dir, 'current')), path.join('releases', 'r1'));
    assert.equal(currentLink(h), 'r1');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});
