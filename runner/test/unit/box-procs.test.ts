// Box mode's categorical quiesce (src/box-procs.ts): before a stopping save
// copies anything, every other process the box started is killed, sparing
// the runner, its ancestors, PID 1, what was there at boot, and the dead.
// Fake process tables only: nothing here signals a real process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { BoxProcesses, listProcs, type Proc } from '../../src/box-procs.ts';

const P = (pid: number, ppid: number, start = String(pid), zombie = false): Proc => ({ pid, ppid, start, zombie });

function fakeBox(initial: Proc[]) {
  let procs = [...initial];
  const killed: number[] = [];
  const box = new BoxProcesses({
    self: 50,
    list: () => procs,
    kill: (pid, sig) => {
      assert.equal(sig, 'SIGKILL');
      killed.push(pid);
      procs = procs.filter((p) => p.pid !== pid);
    },
    sleep: async () => {},
  });
  return { box, killed, set: (p: Proc[]) => (procs = p), add: (p: Proc) => procs.push(p) };
}

test('a stopping save kills everything the box started, and spares the runner, its ancestors, PID 1 and what was there at boot', async () => {
  // 1 init, 7 the provider's ssh server (there at boot), 40 the entrypoint, 50 the runner.
  const f = fakeBox([P(1, 0), P(7, 1), P(40, 1), P(50, 40)]);
  f.box.boot();
  // Since: the CLI and its shell, a setup's background child reparented to
  // init, a zombie, and a process that took the ssh server's old pid.
  f.add(P(60, 50));
  f.add(P(61, 60));
  f.add(P(70, 1));
  f.add(P(80, 50, '80', true));
  f.set([...f.box['list']().filter((p) => p.pid !== 7), P(7, 1, 'later')]);
  assert.equal(await f.box.stopOthers(), 4);
  assert.deepEqual(f.killed.sort((a, b) => a - b), [7, 60, 61, 70]);
});

test('it looks again until nothing new is left, and says so if something won\'t stop', async () => {
  let procs = [P(1, 0), P(50, 1)];
  let forks = 2;
  const killed: number[] = [];
  const box = new BoxProcesses({
    self: 50,
    list: () => procs,
    kill: (pid) => {
      killed.push(pid);
      procs = procs.filter((p) => p.pid !== pid);
      // A process forking as it dies, twice.
      if (forks-- > 0) procs.push(P(100 + forks, 1));
    },
    sleep: async () => {},
  });
  box.boot();
  procs.push(P(60, 50));
  assert.equal(await box.stopOthers(), 3);
  assert.deepEqual(killed, [60, 101, 100]);
  // One that never goes.
  const stuck = new BoxProcesses({ self: 50, list: () => [P(1, 0), P(50, 1), P(66, 1)], kill: () => {}, sleep: async () => {} });
  await assert.rejects(stuck.stopOthers(3), /wouldn't stop \(66\)/);
});

test("the process table is read from /proc, a name with spaces and parens included", () => {
  const root = tmpDir('tb-proc-');
  const stat = (pid: number, comm: string, state: string, ppid: number, start: number) => {
    fs.mkdirSync(path.join(root, String(pid)));
    const fields = [state, String(ppid), ...Array(17).fill('0'), String(start), '0'];
    fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`);
  };
  stat(1, 'init', 'S', 0, 1);
  stat(42, 'node (box) x', 'R', 1, 12345);
  stat(43, 'gone', 'Z', 42, 12400);
  fs.mkdirSync(path.join(root, 'self'));
  assert.deepEqual(listProcs(root), [
    { pid: 1, ppid: 0, start: '1', zombie: false },
    { pid: 42, ppid: 1, start: '12345', zombie: false },
    { pid: 43, ppid: 42, start: '12400', zombie: true },
  ]);
});
