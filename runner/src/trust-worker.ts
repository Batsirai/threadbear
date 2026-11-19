// The trust worker's own side (trust-off-thread.ts has the runner's side
// and says why). Runs in a worker thread: each request is one call into the
// same code the runner would have run on its main thread, answered with a
// plain object.
import { parentPort } from 'node:worker_threads';
import { claudeCommands } from './claude-trust.ts';
import { codeOfUnhashedPatch } from './unhashed-scan.ts';
import type { TrustRequest, TrustReply } from './trust-off-thread.ts';

function answer(req: TrustRequest): unknown {
  switch (req.kind) {
    case 'claudeCommands':
      return claudeCommands(req.cwd, req.home, { grants: req.grants });
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
