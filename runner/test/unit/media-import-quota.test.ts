// media.import from a thread's own key (Daybreak finding 157): metered below
// Full access, refused before any work once over, never holding the event
// loop, and leaving nothing behind when it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from '../helpers/fakes.ts';
import { makePng } from '../helpers/png.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { readToken } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { threadKey } from '../../src/rpc-auth.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { ImportQuota } from '../../src/media-quota.ts';
import type { PermissionMode } from '../../src/protocol.ts';

async function serve() {
  const h = makeHarness();
  const token = readToken(h.home);
  const gate = new CallerGate({ runner: h.runner });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate });
  const { port } = await server.listen();
  return { h, server, token, url: `ws://127.0.0.1:${port}/rpc` };
}

const thread = (h: ReturnType<typeof makeHarness>, mode: PermissionMode) =>
  h.runner.create({ text: mode, accountId: 'claude-3', permissionMode: mode }).thread;
const inbox = (home: string) => (fs.existsSync(path.join(home, 'inbox')) ? fs.readdirSync(path.join(home, 'inbox')) : []);
const small = (h: ReturnType<typeof makeHarness>, files: number) => {
  (h.runner as unknown as { importQuota: ImportQuota }).importQuota = new ImportQuota({ perThread: { files, bytes: 1024 * 1024 }, all: { files: 100, bytes: 100 * 1024 * 1024 } });
};

test('an Ask thread gets the same copy back for the same file, and is refused before any work once over its allowance', async () => {
  const { h, server, token, url } = await serve();
  small(h, 2);
  const me = thread(h, 'ask');
  const c = await RunnerClient.connect(url, threadKey(token, me.id), { threadId: me.id });
  try {
    const shots = [1, 2, 3].map((n) => {
      const f = path.join(h.home, `shot-${n}.png`);
      fs.writeFileSync(f, makePng(10 + n, 10));
      return f;
    });
    const first = (await c.call('media.import', { path: shots[0] })).image;
    for (let i = 0; i < 5; i++) assert.equal((await c.call('media.import', { path: shots[0] })).image.path, first.path, 'the same file again');
    assert.equal(inbox(h.home).length, 1);
    await c.call('media.import', { path: shots[1] });
    const before = inbox(h.home);
    await assert.rejects(c.call('media.import', { path: shots[2] }), (e: { code: number; message: string }) => e.code === -32602 && /today/.test(e.message));
    assert.deepEqual(inbox(h.home), before, 'nothing written once over');
    // Bytes count too: one file over the day's bytes is refused.
    small(h, 100);
    const big = path.join(h.home, 'big.png');
    fs.writeFileSync(big, Buffer.concat([makePng(5, 5), Buffer.alloc(2 * 1024 * 1024)]));
    await assert.rejects(c.call('media.import', { path: big }), /today/);
    assert.deepEqual(inbox(h.home), before);
  } finally {
    c.close();
    await server.close();
  }
});

test('the allowance is per thread and for all limited threads together; Full threads and the owner are not metered', async () => {
  const { h, server, token, url } = await serve();
  const a = thread(h, 'ask');
  const b = thread(h, 'auto');
  const full = thread(h, 'full');
  (h.runner as unknown as { importQuota: ImportQuota }).importQuota = new ImportQuota({ perThread: { files: 2, bytes: 1024 * 1024 }, all: { files: 3, bytes: 1024 * 1024 } });
  const conns = await Promise.all([a, b, full].map((t) => RunnerClient.connect(url, threadKey(token, t.id), { threadId: t.id })));
  const owner = await RunnerClient.connect(url, token);
  let n = 0;
  const fresh = () => {
    const f = path.join(h.home, `p-${n++}.png`);
    fs.writeFileSync(f, makePng(8 + n, 8));
    return f;
  };
  try {
    const [ca, cb, cf] = conns as [RunnerClient, RunnerClient, RunnerClient];
    await ca.call('media.import', { path: fresh() });
    await ca.call('media.import', { path: fresh() });
    await assert.rejects(ca.call('media.import', { path: fresh() }), /This thread/);
    await cb.call('media.import', { path: fresh() });
    await assert.rejects(cb.call('media.import', { path: fresh() }), /Threads below Full/);
    for (let i = 0; i < 5; i++) await cf.call('media.import', { path: fresh() });
    for (let i = 0; i < 5; i++) await owner.call('media.import', { path: fresh() });
  } finally {
    for (const c of [...conns, owner]) c.close();
    await server.close();
  }
});

test("a thread's import doesn't hold the event loop, and leaves nothing when it fails", async () => {
  const h = makeHarness();
  const me = thread(h, 'ask');
  // A big (but allowed) file: the copy goes in pieces, and timers keep running meanwhile.
  const big = path.join(h.home, 'big.png');
  fs.writeFileSync(big, Buffer.concat([makePng(5, 5), Buffer.alloc(40 * 1024 * 1024)]));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    const { image } = await h.runner.importMediaForThread(me.id, big);
    assert.ok(ticks > 1, `timers ran during the import (${ticks})`);
    assert.equal(fs.statSync(image.path).size, fs.statSync(big).size);
  } finally {
    clearInterval(timer);
  }
  // Not a picture, or one that won't convert: refused, and nothing is left in the inbox.
  const before = inbox(h.home);
  const junk = path.join(h.home, 'junk.bin');
  fs.writeFileSync(junk, 'not a picture at all');
  await assert.rejects(h.runner.importMediaForThread(me.id, junk), /Not a supported image/);
  const fakeBmp = path.join(h.home, 'broken.bmp');
  fs.writeFileSync(fakeBmp, Buffer.concat([Buffer.from('BM'), Buffer.alloc(200, 7)]));
  await assert.rejects(h.runner.importMediaForThread(me.id, fakeBmp), /Not a supported image/);
  assert.deepEqual(inbox(h.home), before, 'no leftovers');
  // A FIFO is refused without blocking.
  if (process.platform !== 'win32') {
    const fifo = path.join(h.home, 'pipe.png');
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(h.runner.importMediaForThread(me.id, fifo), /Not a file/);
  }
});
