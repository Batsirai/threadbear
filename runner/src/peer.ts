// Which thread a process on this Mac belongs to, for the RPC server (docs/
// protocol/connection.md, "Who's really calling"). Credentials alone can't say: anything
// a thread's shell runs can read the token file or wipe its own key from the
// environment. The kernel can say what it's a child of, so the server looks at
// the far end of the connection and walks up its parents to a thread's CLI.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { lsofPath } from './handover.ts';
import { psTable, type ProcessRegistry } from './proc.ts';
import type { Logger } from './log.ts';
import { parseSnapshot, win32Helper, winAddress, type WinConnection, type WinProcess } from './win32-helper.ts';

export type PeerDeps = {
  // threadOfPid gets the process's start time where the lookup has one
  // (Windows), so a CLI's pid taken by a newer process doesn't count.
  registry: { threadOfPid(pid: number, created?: bigint): string | undefined | Promise<string | undefined> } & Partial<Pick<ProcessRegistry, 'threadOfGroup'>>;
  // A thread this runner or a draining one really has (a registry entry can
  // be a job's label, like models:<account>).
  known: (threadId: string) => boolean;
  log: Logger;
  // Tests pass stand-ins: the processes holding this exact client socket.
  lsof?: (sock: PeerSocket) => Promise<number[]>;
  table?: () => Promise<ProcRow[]>;
  // Windows: the helper's snapshot of a port (tests pass a stand-in).
  snapshot?: (port: number) => Promise<Snapshot>;
  platform?: NodeJS.Platform;
  // How long lsof and ps each get. Live connections keep LOOKUP_MS; the test
  // of a real lookup gives them longer, as on a loaded Mac lsof alone took
  // over 3 s (a fork, 15 Nov).
  lookupMs?: number;
  // Linux: where /proc is (tests pass a stand-in tree).
  procRoot?: string;
};

// 3 s until 23 Nov 2026. A lookup that runs out now closes the connection
// rather than letting its credential decide (Daybreak finding 175), so it
// gets longer: the app and tb wait a little on a loaded Mac instead of
// reconnecting.
const LOOKUP_MS = 6000;

// Who is at the far end of a connection, as the lookup found it: under a
// thread's CLI, or not under any (a terminal, the app, the runner's own
// jobs). A lookup that can't say either throws UnresolvedPeer (or
// AmbiguousPeer), and the server closes the connection: never "the owner"
// for want of an answer (Daybreak finding 175).
export type PeerCaller = { kind: 'thread'; threadId: string } | { kind: 'owner' };
export const OWNER_PEER: PeerCaller = Object.freeze({ kind: 'owner' });
export const threadPeer = (threadId: string): PeerCaller => ({ kind: 'thread', threadId });

// A process as the lookup sees it. created (Windows only, a FILETIME) is
// when it started: Windows keeps a process's parent id after the parent
// has gone, and gives that id to the next process, so a parent that
// started after its child isn't its parent.
export type ProcRow = { pid: number; ppid: number; pgid?: number; sid?: number; created?: bigint };

// The accepted connection, as the runner's side sees it: the client's
// address and port, and the address and port it reached. All four, because
// a port number alone isn't one socket: a client bound to 127.0.0.2 (Linux
// lets any 127/8 address be used) can share another's port, and lsof's
// `-iTCP:<port>` also lists any socket whose far end uses that number, like
// a Full thread's dev server talking to port 5432 (Daybreak finding 137).
export type PeerSocket = { remoteAddress: string; remotePort: number; localAddress: string; localPort: number };

// Thrown when the processes holding one socket sit under different threads
// (a socket handed to a child in another thread can't be told apart): the
// server refuses the connection rather than pick one.
export class AmbiguousPeer extends Error {}

// Thrown when the lookup can't place the connection at all: lsof or /proc
// failing, timing out or finding nobody holding a socket the runner has
// just accepted, or ps failing. The server closes the connection.
export class UnresolvedPeer extends Error {}

// What lsof calls an address in a name: IPv6 in brackets, an IPv4-mapped
// one as plain IPv4 (Node's dual-stack form).
function lsofAddr(addr: string, port: number): string {
  const a = addr.startsWith('::ffff:') && addr.includes('.') ? addr.slice(7) : addr;
  return a.includes(':') ? `[${a}]:${port}` : `${a}:${port}`;
}

// A slow ps mustn't hold a connection's frames back for long (rpc.ts queues them).
function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('process lookup timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// The processes holding the client's end of exactly this connection: a file
// whose name is client->server. `-iTCP@addr:port` only narrows what lsof
// reads; the name decides. The runner's own end (server->client) never
// matches, nor does any other socket that merely shares a port number.
function lsofPids(sock: PeerSocket, ms: number): Promise<number[]> {
  const client = lsofAddr(sock.remoteAddress, sock.remotePort);
  const want = `${client}->${lsofAddr(sock.localAddress, sock.localPort)}`;
  return new Promise((resolve, reject) => {
    execFile(lsofPath(), ['-nP', `-iTCP@${client}`, '-sTCP:ESTABLISHED', '-Fpn'], { timeout: ms }, (err, stdout) => {
      try {
        resolve(lsofAnswer(err, stdout, want));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Linux: the same from /proc, with no program to run or find. The socket
// whose local end is the client's address and port and whose far end is
// the runner's, from /proc/net/tcp and tcp6 (this network namespace's), then
// every process with a descriptor on that socket's inode. A process of
// another user can't be read; a thread's processes are this user's.
export async function procPids(sock: PeerSocket, root = '/proc', until = Infinity): Promise<number[]> {
  const client = addrBytes(sock.remoteAddress);
  const server = addrBytes(sock.localAddress);
  if (!client || !server) throw new Error(`not an address: ${sock.remoteAddress} or ${sock.localAddress}`);
  const inodes = new Set<string>();
  let tables = 0;
  for (const f of ['tcp', 'tcp6']) {
    let text: string;
    try {
      text = await fs.promises.readFile(`${root}/net/${f}`, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    tables++;
    for (const inode of socketInodes(text, client, sock.remotePort, server, sock.localPort)) inodes.add(inode);
  }
  if (tables === 0) throw new Error(`no ${root}/net/tcp`);
  if (inodes.size === 0) return [];
  const want = new Set([...inodes].map((i) => `socket:[${i}]`));
  const pids: number[] = [];
  for (const name of await fs.promises.readdir(root)) {
    if (!/^\d+$/.test(name)) continue;
    // Stop once its time is up, rather than go on reading after the answer
    // stopped mattering.
    if (Date.now() > until) throw new Error('reading /proc took too long');
    let fds: string[];
    try {
      fds = await fs.promises.readdir(`${root}/${name}/fd`);
    } catch {
      continue; // gone, or not this user's
    }
    for (const fd of fds) {
      if (Date.now() > until) throw new Error('reading /proc took too long');
      let target: string;
      try {
        target = await fs.promises.readlink(`${root}/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      if (want.has(target)) {
        pids.push(Number(name));
        break;
      }
    }
  }
  return pids;
}

// Linux: the process table from /proc/<pid>/stat, no ps needed (Gemini's
// review: a box without /bin/ps would otherwise refuse every connection).
// The command name (field 2, in brackets) can hold spaces and brackets, so
// the fields are counted from the last ')': state, ppid, pgrp.
export async function procTable(root = '/proc'): Promise<ProcRow[]> {
  const rows: ProcRow[] = [];
  for (const name of await fs.promises.readdir(root)) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = await fs.promises.readFile(`${root}/${name}/stat`, 'utf8');
    } catch {
      continue; // gone since the listing
    }
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(f[1]);
    const pgid = Number(f[2]);
    const sid = Number(f[3]);
    if (Number.isInteger(ppid) && Number.isInteger(pgid)) rows.push({ pid: Number(name), ppid, pgid, ...(Number.isInteger(sid) ? { sid } : {}) });
  }
  if (rows.length === 0) throw new Error(`no processes in ${root}`);
  return rows;
}

// The inodes of established sockets (state 01) in a /proc/net/tcp table
// whose local end is `local`:`lport` and far end `remote`:`rport`.
export function socketInodes(table: string, local: Uint8Array, lport: number, remote: Uint8Array, rport: number, little = os.endianness() === 'LE'): string[] {
  const out: string[] = [];
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '01') continue;
    const l = procAddr(f[1], little);
    const r = procAddr(f[2], little);
    if (!l || !r || l.port !== lport || r.port !== rport || !sameBytes(l.ip, local) || !sameBytes(r.ip, remote)) continue;
    if (/^\d+$/.test(f[9]) && f[9] !== '0') out.push(f[9]);
  }
  return out;
}

// "0100007F:1F90" (IPv4) or 32 hex digits and a port (IPv6): each 32-bit
// word as the kernel holds it, so byte-swapped on a little-endian machine.
function procAddr(field: string, little: boolean): { ip: Uint8Array; port: number } | undefined {
  const m = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(field);
  if (!m) return undefined;
  const bytes = new Uint8Array(m[1].length / 2);
  for (let w = 0; w < bytes.length / 4; w++) {
    for (let b = 0; b < 4; b++) {
      const hex = m[1].slice(w * 8 + b * 2, w * 8 + b * 2 + 2);
      bytes[w * 4 + (little ? 3 - b : b)] = parseInt(hex, 16);
    }
  }
  return { ip: unmapped(bytes), port: parseInt(m[2], 16) };
}

// An address as bytes: 4 for IPv4 (and IPv4-mapped IPv6), 16 for IPv6.
export function addrBytes(addr: string): Uint8Array | undefined {
  const v4 = (s: string) => {
    const parts = s.split('.');
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) < 256)) return undefined;
    return Uint8Array.from(parts.map(Number));
  };
  if (!addr.includes(':')) return v4(addr);
  let a = addr.replace(/%.*$/, '');
  // A dotted IPv4 tail (::ffff:127.0.0.1) as its two groups.
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const b = v4(dotted[1]);
    if (!b) return undefined;
    a = `${a.slice(0, dotted.index)}:${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return undefined;
  const groups = (s: string) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9A-Fa-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return undefined;
  const words: number[] = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w))) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[i * 2] = w >> 8;
    bytes[i * 2 + 1] = w & 0xff;
  });
  return unmapped(bytes);
}

function unmapped(b: Uint8Array): Uint8Array {
  if (b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12);
  return b;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// What one lsof run says. It exits 1 when nothing matched. Anything else (another
// exit code, a signal, the time limit) is a failed look, whatever it printed
// first: a partial list could leave out a thread's holder (Codex's review of
// finding 175).
export function lsofAnswer(err: unknown, stdout: string, want: string): number[] {
  if (err && (err as { code?: unknown }).code !== 1) throw err;
  return socketOwners(stdout, want);
}

// From lsof's -F output (p<pid>, then f<fd> and n<name> per file), the pids
// with a file named exactly `want`.
export function socketOwners(out: string, want: string): number[] {
  const pids = new Set<number>();
  let pid: number | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && line.slice(1) === want && pid !== undefined && Number.isInteger(pid)) pids.add(pid);
  }
  return [...pids];
}

// The same on Windows, from the runner's helper (win32-helper.ts). Its one
// PowerShell answers a question at a time, so connections don't each ask:
// a lookup joins the next snapshot of the port (its connections and every
// process) taken after it asked, and every lookup waiting then shares it.
// Asked one each, a thread could open enough connections of its own to
// queue a stolen-credential one past its deadline (Codex's review, 18 Nov
// 2026). It's at most two snapshots' wait, whatever the number waiting.
export type Snapshot = { connections: WinConnection[]; processes: WinProcess[] };

export function coalesce<T>(take: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  let queued: Promise<T> | undefined;
  const next = (): Promise<T> => {
    if (!running) {
      running = take().finally(() => {
        running = undefined;
      });
      return running;
    }
    // One is already going, maybe from before this connection: wait for a
    // new one.
    queued ??= running.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      queued = undefined;
      return next();
    });
    return queued;
  };
  return next;
}

const snapshots = new Map<number, () => Promise<Snapshot>>();

function windowsSnapshot(port: number): Promise<Snapshot> {
  let take = snapshots.get(port);
  if (!take) {
    take = coalesce(async () => parseSnapshot(await win32Helper().ask('snapshot', { port })));
    snapshots.set(port, take);
  }
  return take();
}

// The pids holding exactly the client's end of this connection, from a
// snapshot: its own address and port are the client's, its far end the
// runner's.
export function snapshotOwners(snap: Snapshot, sock: PeerSocket): number[] {
  const pids = new Set<number>();
  for (const c of snap.connections) {
    if (winAddress(c.localAddress) !== winAddress(sock.remoteAddress) || c.localPort !== sock.remotePort) continue;
    if (winAddress(c.remoteAddress) !== winAddress(sock.localAddress) || c.remotePort !== sock.localPort) continue;
    pids.add(c.pid);
  }
  return [...pids];
}

// Who holds the client's end of this connection (PeerCaller). Every
// process holding the socket is looked at (a forked child keeps its
// parent's); if they name different threads it throws AmbiguousPeer. If
// the lookup can't say, it throws UnresolvedPeer, on every system: the
// connection is open (the runner accepted it before asking), so nobody
// holding it means the lookup didn't see what it should, not that nobody
// did (Codex's second review, 18 Nov; Daybreak finding 175). A Mac uses
// lsof at its fixed path and /bin/ps; Linux reads /proc and needs neither
// lsof nor anything on PATH; Windows asks the runner's helper.
export async function threadOfSocket(sock: PeerSocket, deps: PeerDeps): Promise<PeerCaller> {
  let pids: number[];
  let table: ProcRow[] = [];
  const platform = deps.platform ?? process.platform;
  const windows = platform === 'win32';
  const ms = deps.lookupMs ?? LOOKUP_MS;
  try {
    let holders: number[];
    if (windows && !deps.lsof) {
      const snap = await deadline((deps.snapshot ?? windowsSnapshot)(sock.localPort), ms);
      holders = snapshotOwners(snap, sock);
      table = snap.processes;
    } else {
      const find = deps.lsof ?? (platform === 'linux' ? (s: PeerSocket) => procPids(s, deps.procRoot, Date.now() + ms) : (s: PeerSocket) => lsofPids(s, ms));
      holders = await deadline(find(sock), ms);
    }
    if (holders.length === 0) throw new Error('nobody holds this connection');
    pids = holders.filter((p) => p !== process.pid);
    // Only the runner itself: its own connection, the owner's.
    if (pids.length === 0) return OWNER_PEER;
    if (!(windows && !deps.lsof)) table = await deadline((deps.table ?? (platform === 'linux' ? () => procTable(deps.procRoot) : psTable))(), ms);
    // One that isn't in the process table has gone, or the table missed
    // it: either way its parents can't be walked.
    const live = new Set(table.map((r) => r.pid));
    const missing = pids.find((p) => !live.has(p));
    if (missing !== undefined) throw new Error(`process ${missing} isn't in the process table`);
  } catch (e) {
    deps.log.warn('could not tell which process connected to the RPC', { error: String(e) });
    throw new UnresolvedPeer(`could not tell which process connected: ${String(e)}`);
  }
  const threads = new Set<string>();
  for (const peer of pids) {
    const t = await threadOfPid(peer, table, deps, windows);
    if (t) threads.add(t);
  }
  if (threads.size > 1) throw new AmbiguousPeer(`one connection is held by processes under ${threads.size} threads`);
  return threads.size === 1 ? threadPeer([...threads][0]) : OWNER_PEER;
}

async function threadOfPid(peer: number, table: ProcRow[], deps: PeerDeps, windows: boolean): Promise<string | undefined> {
  const rows = new Map(table.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  for (let p: number | undefined = peer; p !== undefined && p > 1 && !seen.has(p); p = parentOf(rows, p)) {
    // A parent the table doesn't have: the walk can't go on, so it can't
    // say this isn't under a thread (Gemini's review of finding 175). On a
    // Mac or Linux a process whose parent has gone is given another at once;
    // Windows keeps a dead parent's id (parentOf), so there it's the end.
    if (!rows.has(p) && !windows) throw new UnresolvedPeer(`process ${p}, a parent of ${peer}, isn't in the process table`);
    seen.add(p);
    const t = await deps.registry.threadOfPid(p, rows.get(p)?.created);
    if (t && deps.known(t)) return t;
  }
  // Left its parents behind (a nohup or a backgrounded subshell), but still
  // in a process group a thread's tool command ran in.
  const row = table.find((r) => r.pid === peer);
  const group = row?.pgid;
  const byGroup = group ? deps.registry.threadOfGroup?.(group) : undefined;
  if (byGroup && deps.known(byGroup)) return byGroup;
  // Linux: still in the session its CLI leads (the runner starts every CLI
  // in its own), even in a group of its own the registry hasn't seen yet
  // (Codex's third review of finding 175).
  if (row?.sid !== undefined && row.sid > 1 && row.sid !== peer) {
    const bySession = await deps.registry.threadOfPid(row.sid, rows.get(row.sid)?.created);
    if (bySession && deps.known(bySession)) return bySession;
  }
  return undefined;
}

// The parent a process really has: none when the recorded parent started
// after it did (Windows: the parent died and its id went to a newer
// process, which mustn't count as its parent).
function parentOf(rows: Map<number, ProcRow>, pid: number): number | undefined {
  const row = rows.get(pid);
  if (!row) return undefined;
  const parent = rows.get(row.ppid);
  if (row.created && parent?.created && parent.created > row.created) return undefined;
  return row.ppid;
}
