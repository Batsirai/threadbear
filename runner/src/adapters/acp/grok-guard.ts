// What makes Grok ask Threadbear before it runs a tool.
//
// Grok has no setting a client can force that makes it always ask. Its own
// modes come from its config and from ~/.claude/settings.json: tried on 1.0.77
// (15 Nov 2026), a user whose Claude settings say `defaultMode: "auto"` got
// Grok's auto mode, and a file write and `echo ran > shell.txt` ran with no
// session/request_permission at all, its classifier allowing them. Nothing in
// the environment, GROK_CONFIG or session/new's _meta turned that off.
//
// What does hold is a PreToolUse hook answering "ask": Grok then sends the
// call to the client's permission prompt, and nothing of its own (auto mode,
// always-approve, a saved grant, a read-only command, a folder's allow rules)
// approves it instead (its docs, hooks "Output", and tried the same day with a
// folder whose .claude/settings.json said bypassPermissions and whose
// .grok/config.toml allowed everything). So every Grok process starts with
// `--plugin-dir` naming a plugin of Threadbear's whose only hook is this one.
// A plugin dir given that way is trusted, and is ignored in Grok's leader
// mode, hence `--no-leader` (agents.ts).
//
// The hook asks for every tool except a read inside the thread's folder,
// which goes ahead as Grok's own read-only tools do anywhere. For a small job
// (noTools) it denies everything, reads too. It fails closed: if it can't run
// or answers nonsense, the call is denied.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run by the runner's own node, never by anything a thread's folder supplies.
// Kept free of imports beyond node's, as it's written out and run on its own.
export const GUARD_SCRIPT = `// Threadbear's guard for Grok, written by runner/src/adapters/acp/grok-guard.ts.
// Grok runs it before every tool call. "ask" sends the call to Threadbear,
// whatever Grok's own mode and rules would have done.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
// Grok's tools that only look, which may go ahead when all they name is
// inside the thread's folder: its file reads and searches, the search of its
// own tool list (how it finds an MCP tool), its to-do list, and the output of
// a command it already ran. Anything else asks, a tool added later included,
// and so does the web (a search can carry what it read away).
const READS = new Set(['read_file', 'list_dir', 'grep', 'search_tool', 'todo_write', 'get_command_or_subagent_output']);
const PATH_KEYS = new Set(['target_file', 'target_directory', 'path', 'paths', 'file_path', 'file', 'files', 'directory', 'dir', 'cwd', 'root']);

function say(decision, reason) {
  process.stdout.write(JSON.stringify({ decision, reason }));
}

// As the disk has it, links followed; a path that isn't there yet resolves
// through the nearest folder that is.
function onDisk(p) {
  let rest = '';
  let at = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), rest);
    } catch {
      const up = path.dirname(at);
      if (up === at) return undefined;
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  }
}

function inside(p, root) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function decide(e) {
  const name = e.toolName ?? e.tool_name;
  if (!READS.has(name) || e.toolInputTruncated === true) return 'ask';
  const root = typeof e.cwd === 'string' && path.isAbsolute(e.cwd) ? onDisk(e.cwd) : undefined;
  if (!root) return 'ask';
  const input = e.toolInput ?? e.tool_input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'ask';
  for (const [k, v] of Object.entries(input)) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') continue;
    const values = Array.isArray(v) ? v : [v];
    for (const s of values) {
      if (typeof s !== 'string') return 'ask';
      // A named place, or anything that reads like one leaving the folder
      // (a pattern starting at /, a ~, a ..): checked as a path.
      const looks = PATH_KEYS.has(k) || s.startsWith('/') || s.startsWith('~') || s.split(/[\\\\/]/).includes('..');
      if (!looks || s === '') continue;
      if (s.startsWith('~')) return 'ask';
      const where = onDisk(path.resolve(root, s));
      if (!where || !inside(where, root)) return 'ask';
    }
  }
  return 'allow';
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  raw += d;
});
process.stdin.on('end', () => {
  if (mode !== 'ask') return say('deny', 'Tools are off for this job.');
  let decision = 'ask';
  try {
    decision = decide(JSON.parse(raw));
  } catch {
    decision = 'ask';
  }
  if (decision === 'allow') return say('allow', 'A read inside the thread\\'s folder.');
  say('ask', 'Threadbear decides.');
});
`;

export type GuardMode = 'ask' | 'deny';

// A plugin folder's name is in the hook's name, which Grok adds to the title
// of every request it asks about ("— hook 'plugin/threadbear-ask/...'").
export const PLUGIN_NAMES: Record<GuardMode, string> = { ask: 'threadbear-ask', deny: 'threadbear-deny' };

let fallbackRoot: string | undefined;

function writeIfChanged(file: string, text: string, mode: number): void {
  let now: string | undefined;
  try {
    now = fs.readFileSync(file, 'utf8');
  } catch {
    now = undefined;
  }
  if (now === text) return;
  // Written beside and renamed, so a Grok starting meanwhile never reads half.
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

// The plugin folder for a Grok process, made (or put right) before every
// start: a hook that's missing means Grok's own modes decide, so this never
// trusts what was there before. Under the runner's data dir; with none (a
// test), a private temp folder of this process's own.
export function grokGuardDir(o: { dataDir?: string; noTools?: boolean } = {}): string {
  let root: string;
  if (o.dataDir) {
    root = path.join(o.dataDir, 'grok-guard');
  } else {
    fallbackRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), 'threadbear-grok-guard-'));
    root = fallbackRoot;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const script = path.join(root, 'guard.mjs');
  writeIfChanged(script, GUARD_SCRIPT, 0o600);
  const mode: GuardMode = o.noTools ? 'deny' : 'ask';
  const plugin = path.join(root, PLUGIN_NAMES[mode]);
  fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true, mode: 0o700 });
  // The runner's own node, by its whole path: a thread's PATH can't swap it.
  const hooks = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: process.execPath, args: [script, mode], timeout: 30, failClosed: true }] }] } };
  writeIfChanged(path.join(plugin, 'hooks', 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`, 0o600);
  return plugin;
}
