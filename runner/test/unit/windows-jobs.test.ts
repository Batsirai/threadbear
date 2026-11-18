// Windows' stand-in for a CLI's process group: a Job Object for each CLI
// (src/proc.ts, JobControl; made by win32-helper.ps1). Ending it ends
// everything the CLI left running, including processes whose parent has
// gone, which taskkill /T can't find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nullLogger } from '../../src/log.ts';
import { ProcessRegistry, helperJobs, newJobName, pidExists, processInfo, type JobControl } from '../../src/proc.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows } from '../helpers/platform.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

// A stand-in for the helper. assign answers the start of the process it
// was given, as the helper does (a FILETIME on Windows; on a Mac, where ps
// gives a date, any number: the start can't be compared there), or `start`.
function recorder(start?: (pid: number) => string) {
  const calls: string[] = [];
  const jobs: JobControl = {
    assign: async (pid, name) => {
      calls.push(`assign ${pid} ${name}`);
      if (start) return start(pid);
      const l = processInfo(pid)?.lstart ?? '';
      return /^\d+$/.test(l) ? l : '1';
    },
    end: async (name) => void calls.push(`end ${name}`),
    forget: async (name) => void calls.push(`forget ${name}`),
  };
  return { calls, jobs };
}

const JOB = /^Local\\threadbear-job-[0-9a-f]{32}$/;
const tick = () => new Promise((r) => setImmediate(r));

// A process to stand for a CLI: real, so its start can be read.
function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
}

test('job names are the runner\'s own: random, and only of the form the helper takes', () => {
  const a = newJobName();
  assert.match(a, JOB);
  assert.notEqual(a, newJobName());
});

test('a CLI goes in a job of its own as it starts, and the job ends when the CLI does', async () => {
  const { calls, jobs } = recorder();
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = jobs;
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    assert.equal(calls.length, 1, 'asked straight away');
    const [, pid, name] = calls[0]!.split(' ');
    assert.equal(Number(pid), cli.pid);
    assert.match(name!, JOB);
    await tick();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string }[];
    assert.equal(saved[0]!.job, name, 'kept once the helper says it was the CLI, so the next runner can end it');
    reg.remove(cli.pid!);
    await tick();
    assert.deepEqual(calls.slice(1), [`end ${name}`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')), [], 'ended, so not kept');
    // Never the runner's own process.
    reg.add(process.pid, 'claude', 'th1');
    reg.remove(process.pid);
    assert.equal(calls.length, 2);
  } finally {
    cli.kill();
  }
});

test("a job that got a process which wasn't the CLI (its pid reused) is let go of, never ended", async () => {
  const { calls, jobs } = recorder(() => '5');
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = jobs;
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const entry = (reg as unknown as { entries: Map<number, { lstart?: string }> }).entries.get(cli.pid!)!;
    if (!/^~?\d+$/.test(entry.lstart ?? '')) entry.lstart = '133761234567890123'; // a Mac's ps gives a date
    await tick();
    const name = calls[0]!.split(' ')[2];
    assert.deepEqual(calls.slice(1), [`forget ${name}`]);
    reg.remove(cli.pid!);
    await tick();
    assert.ok(!calls.some((c) => c.startsWith('end')), 'nothing ended');
  } finally {
    cli.kill();
  }
});

test('a job the helper refuses (a name someone else made first) is never ended, and the CLI stays recorded for taskkill /T', async () => {
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = { assign: async () => { throw new Error('a job by that name already exists'); }, end: async (n) => void calls.push(`end ${n}`), forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    await tick();
    assert.deepEqual(reg.pids(), [cli.pid]);
    reg.remove(cli.pid!);
    await tick();
    assert.deepEqual(calls, []);
  } finally {
    cli.kill();
  }
});

test('a CLI that exits before the helper has answered has its job ended once it does', async () => {
  let answer!: (s: string) => void;
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = { assign: () => new Promise((r) => (answer = r)), end: async (n) => void calls.push(`end ${n}`), forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const l = processInfo(cli.pid!)?.lstart ?? '';
    reg.remove(cli.pid!);
    answer(/^\d+$/.test(l) ? l : '1');
    await tick();
    assert.equal(calls.length, 1);
  } finally {
    cli.kill();
  }
});

test("the next runner ends the jobs the last one's CLIs had, keeps any it can't end for the start after, and leaves their pids alone", async () => {
  const dir = tmpDir();
  const name = newJobName();
  const stuck = newJobName();
  // CLIs that are gone (pids nothing has): their jobs may still hold what they started.
  fs.writeFileSync(
    path.join(dir, 'children.json'),
    JSON.stringify([
      { pid: 999_999_999, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: name },
      { pid: 999_999_998, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: stuck, exited: true },
      { pid: 999_999_997, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: 'Global\\someone-else' },
    ]),
  );
  const calls: string[] = [];
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = {
    assign: async () => '1',
    end: async (n) => {
      calls.push(`end ${n}`);
      if (n === stuck) throw new Error('the helper exited');
    },
    forget: async () => {},
  };
  await reg.sweepOrphans(10);
  assert.deepEqual(calls.sort(), [`end ${name}`, `end ${stuck}`].sort(), 'only names of the runner\'s own form');
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string; exited?: boolean }[];
  assert.deepEqual(kept.map((e) => [e.job, e.exited]), [[stuck, true]]);
});

test('on Windows what a CLI left running ends with its job, even with its parent gone', onlyOnWindows('Job Objects are Windows'), async () => {
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  assert.equal(reg.jobs, helperJobs);
  const marker = path.join(dir, 'left.pid');
  // A "CLI" that starts a long-running process, writes its pid, and exits
  // straight away: the process is an orphan, as a nohup'd tool command is.
  // A second after it starts, as a real CLI takes a while before its first tool command.
  const left = `setTimeout(() => { const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true }); require('fs').writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref(); process.exit(0); }, 1000);`;
  // The runner starts its helper as it starts.
  await (await import('../../src/win32-helper.ts')).win32Helper().ask('ping');
  const cli = spawn(process.execPath, ['-e', left], { stdio: 'ignore', windowsHide: true });
  reg.add(cli.pid!, process.execPath, 'th1');
  const exited = new Promise((r) => cli.once('exit', r));
  await exited;
  const orphan = Number(fs.readFileSync(marker, 'utf8'));
  try {
    assert.ok(pidExists(orphan), 'its child outlived it');
    reg.remove(cli.pid!);
    const deadline = Date.now() + PATIENCE_MS;
    while (pidExists(orphan) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.equal(pidExists(orphan), false, 'ended with the job');
  } finally {
    try {
      process.kill(orphan);
    } catch {
      // gone
    }
    (await import('../../src/win32-helper.ts')).win32Helper().stop();
  }
});
