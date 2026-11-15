// Sandboxed threads (sandbox.ts): which threads run their CLI in a
// container, and the `docker run` that does it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dockerRun, readSandbox, sandboxFor } from '../../src/sandbox.ts';
import { tmpDir } from '../helpers/fakes.ts';

const home = '/home/alex';
const expand = (p: string) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

test('runner.json sandbox: folders and an image, else nothing', () => {
  assert.deepEqual(readSandbox({ folders: ['~/sandboxed'], image: 'threadbear-sandbox' }, expand), { folders: ['/home/alex/sandboxed'], image: 'threadbear-sandbox', docker: 'docker' });
  assert.equal(readSandbox({ folders: [], image: 'x' }, expand), undefined);
  assert.equal(readSandbox({ folders: ['~/s'] }, expand), undefined);
  assert.equal(readSandbox(undefined, expand), undefined);
  assert.equal(readSandbox({ folders: ['~/s'], image: 'x', docker: '/usr/bin/podman' }, expand)?.docker, '/usr/bin/podman');
});

test('a thread is sandboxed when its folder is under a sandbox folder, and not a sibling that only starts the same', () => {
  const root = tmpDir();
  const box = path.join(root, 'sandboxed');
  fs.mkdirSync(path.join(box, 'demo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sandboxed-not'), { recursive: true });
  const sb = { folders: [box], image: 'i', docker: 'docker' };
  assert.equal(sandboxFor(sb, path.join(box, 'demo')), sb);
  assert.equal(sandboxFor(sb, box), sb);
  assert.equal(sandboxFor(sb, path.join(root, 'sandboxed-not')), undefined);
  assert.equal(sandboxFor(undefined, box), undefined);
});

test('the docker run mounts the folder, the login and the CLI at the same paths, and nothing else of the machine', () => {
  const there = new Set(['/home/alex/.claude', '/home/alex/.claude.json', '/tmp/settings-abc.json']);
  const run = dockerRun(
    {
      command: '/home/alex/.local/bin/claude',
      args: ['--output-format', 'stream-json', '--settings', '/tmp/settings-abc.json', '--resume', 'abc'],
      cwd: '/home/alex/sandboxed/demo',
      env: { PATH: '/usr/bin', HOME: '/home/alex', ANTHROPIC_MODEL: 'x', THREADBEAR_THREAD_ID: 't1', THREADBEAR_NODE: '/Users/alex/.nvm/node', THREADBARE_NODE: '/Users/alex/.nvm/node', GONE: undefined },
    },
    { folders: ['/home/alex/sandboxed'], image: 'threadbear-sandbox', docker: 'docker' },
    {
      threadId: 'abcdef0123', home, uid: 1000, gid: 1000,
      exists: (p) => there.has(p),
      realpath: (p) => (p === '/home/alex/.local/bin/claude' ? '/home/alex/.local/share/claude/versions/2.1.318' : p),
    },
  );
  assert.equal(run.command, 'docker');
  assert.match(run.name, /^tb-abcdef01-/);
  const a = run.args;
  const vols = a.flatMap((x, i) => (x === '-v' ? [a[i + 1]] : []));
  assert.deepEqual(vols.sort(), [
    '/home/alex/.claude.json:/home/alex/.claude.json',
    '/home/alex/.claude:/home/alex/.claude',
    '/home/alex/.local/share/claude/versions/2.1.318:/home/alex/.local/share/claude/versions/2.1.318:ro',
    '/home/alex/sandboxed/demo:/home/alex/sandboxed/demo',
    '/tmp/settings-abc.json:/tmp/settings-abc.json:ro',
  ]);
  const envs = a.flatMap((x, i) => (x === '-e' ? [a[i + 1]] : []));
  assert.deepEqual(envs.sort(), ['ANTHROPIC_MODEL', 'HOME=/home/alex', 'THREADBEAR_THREAD_ID'], "the container's own PATH and node, and nothing unset");
  assert.deepEqual(a.slice(a.indexOf('-w'), a.indexOf('-w') + 2), ['-w', '/home/alex/sandboxed/demo']);
  // The image, then the CLI's real file and its own arguments, untouched.
  const at = a.indexOf('threadbear-sandbox');
  assert.deepEqual(a.slice(at), ['threadbear-sandbox', '/home/alex/.local/share/claude/versions/2.1.318', '--output-format', 'stream-json', '--settings', '/tmp/settings-abc.json', '--resume', 'abc']);
  assert.ok(a.includes('--rm') && a.includes('--init') && a.includes('-i'));
  assert.deepEqual(a.slice(a.indexOf('--user'), a.indexOf('--user') + 2), ['--user', '1000:1000']);
});

test("another login's config folder goes in instead of ~/.claude, without ~/.claude.json", () => {
  const cfg = '/home/alex/Library/Application Support/Threadbear/accounts/claude-1';
  const run = dockerRun(
    { command: '/c', args: [], cwd: '/home/alex/sandboxed/x', env: { CLAUDE_CONFIG_DIR: cfg } },
    { folders: ['/home/alex/sandboxed'], image: 'img', docker: 'docker' },
    { threadId: 't', home, uid: 1, gid: 1, exists: () => true, realpath: (p) => p },
  );
  const vols = run.args.flatMap((x, i) => (x === '-v' ? [run.args[i + 1]] : []));
  assert.ok(vols.includes(`${cfg}:${cfg}`));
  assert.ok(!vols.some((v) => v.startsWith('/home/alex/.claude')));
});
