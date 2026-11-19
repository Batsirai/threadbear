// The trust worker's own side (trust-off-thread.ts has the runner's side
// and says why). Runs in a worker thread: each request is one call into the
// same code the runner would have run on its main thread, answered with a
// plain object.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { parentPort } from 'node:worker_threads';
import { claudeCommands } from './claude-trust.ts';
import { codeOfUnhashedPatch } from './unhashed-scan.ts';
import type { TrustRequest, TrustReply } from './trust-off-thread.ts';

// A FIFO or socket where a settings file or script should be: read whole,
// a FIFO with no writer would hold this thread in the OS for good,
// past any time limit and even the runner's exit (Codex's review). The
// trust code reads files with fs.readFileSync, so here, in this worker
// only, that looks at what the file is first (a stat doesn't wait) and
// refuses those two. Devices are read as before: a hook's /dev/null is
// common, and reads as nothing at once. Refusing isn't enough by itself:
// the trust code takes a file it can't read as missing, which a FIFO
// mustn't pass for, as Claude would read it. So the look fails whole.
let special: string | undefined;
const readFileSync = fs.readFileSync;
fs.readFileSync = function guarded(this: unknown, ...args: Parameters<typeof readFileSync>) {
  const p = args[0];
  if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(p);
    } catch {
      // Not there: readFileSync says so itself.
    }
    if (st && (st.isFIFO() || st.isSocket())) {
      special ??= String(p);
      throw Object.assign(new Error(`${String(p)} isn't a regular file`), { code: 'EINVAL' });
    }
  }
  return readFileSync.apply(this, args);
} as typeof readFileSync;
syncBuiltinESMExports();

function answer(req: TrustRequest): unknown {
  special = undefined;
  const value = look(req);
  if (special !== undefined) throw new Error(`${special} is a FIFO or socket, not a file, so Threadbear can't tell what it holds.`);
  return value;
}

function look(req: TrustRequest): unknown {
  switch (req.kind) {
    case 'claudeCommands':
      return req.grants.map((grants) => claudeCommands(req.cwd, req.home, { grants }));
    case 'editsAsk': {
      const scan = codeOfUnhashedPatch(req.file, req.from, req.now);
      return { all: scan.all, ...(scan.why ? { why: scan.why } : {}) };
    }
  }
}

parentPort?.on('message', (req: TrustRequest) => {
  let reply: TrustReply;
  try {
    reply = { id: req.id, ok: true, value: answer(req) };
  } catch (e) {
    reply = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply);
});

// Loaded: from here a worker that stops is a crash, not one that can't run.
parentPort?.postMessage({ ready: true } satisfies TrustReply);
