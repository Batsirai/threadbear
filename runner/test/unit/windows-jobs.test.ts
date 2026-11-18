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
import { ProcessRegistry, helperJobs, newJobName, pidExists, type JobControl } from '../../src/proc.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows } from '../helpers/platform.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

function recorder() {
  const calls: string[] = [];
  const jobs: JobControl = {
    assign: async (pid, name) => void calls.push(`assign ${pid} ${name}`),
    end: async (name) => void calls.push(`end ${name}`),
  };
  return { calls, jobs };
}

const JOB = /^Local\\threadbear-job-[0-9a-f]{32}$/;

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
  reg.add(4242, 'claude', 'th1');
  assert.equal(calls.length, 1);
  const [, pid, name] = calls[0]!.split(' ');
  assert.equal(Number(pid), 4242);
  assert.match(name!, JOB);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string }[];
  assert.equal(saved[0]!.job, name, 'kept, so the next runner can end it');
  reg.remove(4242);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.slice(1), [`end ${name}`]);
  // Never the runner's own process.
  reg.add(process.pid, 'claude', 'th1');
  reg.remove(process.pid);
  assert.equal(calls.length, 2);
});

test("the next runner ends the jobs the last one's CLIs had, whatever became of the CLIs", async () => {
  const dir = tmpDir();
  const name = newJobName();
  // A CLI that's gone (a pid nothing has): its job may still hold what it started.
  fs.writeFileSync(path.join(dir, 'children.json'), JSON.stringify([{ pid: 999_999_999, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: name }]));
  const { calls, jobs } = recorder();
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = jobs;
  await reg.sweepOrphans(10);
  assert.deepEqual(calls, [`end ${name}`]);
});

test('a job the helper refuses leaves the CLI running and recorded, for taskkill /T as before', async () => {
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = { assign: async () => { throw new Error('a job by that name already exists'); }, end: async () => {} };
  reg.add(4242, 'claude', 'th1');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reg.pids(), [4242]);
  reg.remove(4242);
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
