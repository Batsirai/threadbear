// A box's save (docs/virtual-runners.md, decision 7; docs/protocol.md, "Box
// mode"): before its box sleeps or is archived, the backend sends the box's
// runner a `save` command, and the thread goes out of the box into Convex
// file storage. A new box for the thread restores it, so a box the provider
// loses loses nothing saved.
//
// What goes is what a move carries (runner/moves.ts packForMove, through
// the same move-pack.ts and move-git.ts): the thread's own folder in the
// data dir (its record and events), its Claude session's transcript, and
// its git work (the commits origin doesn't have, and one more of every
// uncommitted and untracked file), gzipped. Not the checkout itself: a new
// box clones the repo again and the git work goes on top, which keeps a
// save small. `.gitignore`d files (node_modules, build output) stay behind;
// the worktree's setup makes them again (Runner.setUpRestored).
//
// Sealed with AES-256-GCM under the thread's own key (handed only to boxes
// for that thread, by the boot exchange), bound to the thread's id. The
// spike proved the shape on Fly (runner/box/spike/box/lose.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archive, readTree, safeEntryPath, unarchive, writeTree, type PackEntry } from './move-pack.ts';
import { packGit, unpackGit, type GitMeta } from './move-git.ts';
import { paths } from './config.ts';
import { projectDirName, sessionTranscriptPath } from './transcripts.ts';
import { git, realpath, threadBranch } from './worktrees.ts';
import type { ThreadRecord } from './store.ts';

// One upload: a box key's uploads are a runner key's, 10 MB at most
// (convex/sync.ts MAX_RUNNER_UPLOAD_BYTES). A save bigger than that, in
// parts as a move's chunks are, is a TODO (docs/virtual-runners.md).
export const SAVE_MAX_BYTES = 10 * 1024 * 1024;
const SAVE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// What the seal is bound to, so a save opens only as its own thread's.
function sealInfo(threadId: string): Buffer {
  return Buffer.from(`threadbear box save v1 ${threadId}`, 'utf8');
}

export function sealSave(threadKey: Buffer, threadId: string, plain: Buffer): Buffer {
  if (threadKey.length !== 32) throw new Error("The thread's key isn't 32 bytes.");
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', threadKey, iv);
  c.setAAD(sealInfo(threadId));
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

export function openSave(threadKey: Buffer, threadId: string, sealed: Buffer): Buffer {
  if (threadKey.length !== 32) throw new Error("The thread's key isn't 32 bytes.");
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("The thread's save is too short to be one.");
  const d = crypto.createDecipheriv('aes-256-gcm', threadKey, sealed.subarray(0, IV_BYTES));
  d.setAAD(sealInfo(threadId));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new Error("The thread's save doesn't open with its key: it's damaged, or another thread's.");
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The thread packed for a save: its folder, its transcript, its git work. */
export async function packSave(o: { home: string; claudeDir: string; rec: ThreadRecord }): Promise<Buffer> {
  const { rec } = o;
  const entries: PackEntry[] = readTree(paths.thread(o.home, rec.id), 'thread', ['panels']);
  if (rec.provider === 'claude' && rec.sessionUsed && rec.nativeSessionId) {
    const file = sessionTranscriptPath(o.claudeDir, rec.cwd, rec.nativeSessionId);
    if (file) {
      entries.push({ path: `transcript/${rec.nativeSessionId}.jsonl`, data: fs.readFileSync(file) });
      entries.push(...readTree(path.join(path.dirname(file), rec.nativeSessionId), `transcript/${rec.nativeSessionId}`));
    }
  }
  const work = rec.worktree && !rec.worktree.removedAt ? rec.worktree.path : rec.cwd;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-save-'));
  try {
    const g = await packGit(work, rec.cwd, path.join(scratch, 'save.bundle'));
    if (!g.ok) throw new Error(`Couldn't save the thread's git work: ${g.reason}`);
    entries.push({ path: 'git/meta.json', data: Buffer.from(JSON.stringify(g.meta)) });
    if (g.bundle) entries.push({ path: 'git/save.bundle', data: fs.readFileSync(g.bundle) });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  entries.push({ path: 'box.json', data: Buffer.from(JSON.stringify({ version: SAVE_VERSION, threadId: rec.id, savedAt: new Date().toISOString() })) });
  return archive(entries);
}

// `rel` under `top`, or `top` when it's empty, leads out or isn't there.
function under(top: string, rel: string | undefined): string {
  if (!rel || !safeEntryPath(rel)) return top;
  const p = path.join(top, ...rel.split('/'));
  return fs.existsSync(p) ? p : top;
}

/**
 * Puts a save back in a new box: the thread's folder into the data dir, its
 * git work on top of `checkout` (a fresh clone of its repo on the base
 * branch), in a worktree again if it had one, and its transcript where
 * Claude Code looks for the folder it now runs in. Returns that folder.
 * The thread's record keeps its session id, so its next turn resumes the
 * same session.
 */
export async function restoreSave(o: { home: string; claudeDir: string; threadId: string; checkout: string; packed: Buffer }): Promise<{ cwd: string; worktree: boolean }> {
  const entries = unarchive(o.packed);
  const json = (p: string): any => {
    const e = entries.find((x) => x.path === p);
    if (!e) return undefined;
    try {
      return JSON.parse(e.data.toString('utf8'));
    } catch {
      throw new Error(`The thread's save has a damaged ${p}.`);
    }
  };
  const box = json('box.json');
  if (!box || box.version !== SAVE_VERSION || box.threadId !== o.threadId) throw new Error("The save isn't one of this thread's that this runner can read.");
  const rec = json('thread/thread.json') as (ThreadRecord & Record<string, unknown>) | undefined;
  if (!rec || rec.id !== o.threadId) throw new Error("The save's thread record is missing or another thread's.");
  const meta = json('git/meta.json') as GitMeta | undefined;
  if (!meta) throw new Error("The save has no git work in it.");
  const checkout = realpath(o.checkout);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-restore-'));
  let cwd: string;
  try {
    const bundle = entries.find((e) => e.path === 'git/save.bundle');
    const bundleFile = bundle ? path.join(scratch, 'save.bundle') : undefined;
    if (bundle && bundleFile) fs.writeFileSync(bundleFile, bundle.data);
    const w = rec.worktree && !rec.worktree.removedAt ? rec.worktree : undefined;
    if (w) {
      // In the same place a new thread's worktree would be (worktrees.ts
      // makeWorktree), under the folder name it had, on its own branch.
      const name = path.basename(w.path);
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error("The save's worktree has a folder name this runner won't make.");
      const where = path.join(path.dirname(checkout), `${path.basename(checkout)}-threads`, name);
      const branch = threadBranch(o.threadId);
      fs.mkdirSync(path.dirname(where), { recursive: true });
      const add = await git(checkout, ['worktree', 'add', '-b', branch, where, 'HEAD']);
      if (!add.ok) throw new Error(`Couldn't make the thread's worktree again: ${add.stderr.trim().split('\n')[0] ?? 'git failed'}`);
      const r = await unpackGit(where, meta, bundleFile);
      if (!r.ok) throw new Error(r.reason);
      rec.worktree = { ...w, repo: path.basename(checkout), mainCheckout: checkout, path: where, branch };
      cwd = under(where, meta.subdir);
    } else {
      const r = await unpackGit(checkout, meta, bundleFile);
      if (!r.ok) throw new Error(r.reason);
      delete rec.worktree;
      cwd = under(checkout, meta.subdir);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  rec.cwd = cwd;
  const dir = paths.thread(o.home, o.threadId);
  writeTree(entries, 'thread', dir);
  fs.writeFileSync(path.join(dir, 'thread.json'), JSON.stringify(rec, null, 2));
  const transcript = entries.filter((e) => e.path.startsWith('transcript/'));
  if (transcript.length) writeTree(transcript, 'transcript', path.join(o.claudeDir, 'projects', projectDirName(realpath(cwd))));
  return { cwd, worktree: Boolean(rec.worktree) };
}

/**
 * The `save` command (docs/protocol.md, "Box mode"): the thread packed,
 * sealed, uploaded through the box key's upload URL (sync:iconUploadUrl)
 * and named in boxes:boxSaved, which replaces the last save. A save past
 * one upload fails the command, saying so.
 */
export async function saveThread(o: {
  home: string;
  claudeDir: string;
  threadId: string;
  threadKey: Buffer;
  boxKey: string;
  snapshot: (threadId: string) => ThreadRecord;
  post: (kind: 'mutation', fn: string, args: Record<string, unknown>) => Promise<unknown>;
  upload: (url: string, bytes: Uint8Array, mediaType: string) => Promise<string>;
}): Promise<{ bytes: number }> {
  const rec = o.snapshot(o.threadId);
  const sealed = sealSave(o.threadKey, o.threadId, await packSave({ home: o.home, claudeDir: o.claudeDir, rec }));
  if (sealed.length > SAVE_MAX_BYTES) {
    throw new Error(`The thread's save is ${mb(sealed.length)}, more than one upload takes (${mb(SAVE_MAX_BYTES)}), and saves in parts aren't built yet. Commit less, or take big untracked files out of its folder, and it can save.`);
  }
  const url = await o.post('mutation', 'sync:iconUploadUrl', { key: o.boxKey });
  if (typeof url !== 'string') throw new Error("The backend didn't give the box an upload URL.");
  const storageId = await o.upload(url, sealed, 'application/octet-stream');
  await o.post('mutation', 'boxes:boxSaved', { key: o.boxKey, storageId, bytes: sealed.length });
  return { bytes: sealed.length };
}
