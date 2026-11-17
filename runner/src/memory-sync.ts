// Shared memory (docs/protocol.md, "Shared memory"; the sharedMemory
// experiment). What makes a thread on the M5 know Mike is mostly what Claude
// Code loads before the first message: the global CLAUDE.md and the memory
// folder of the project it's in (MEMORY.md and its files, which agents write
// as they learn things). Those lived on the M5 alone, so a thread on Bruce or
// Tinker Desk started knowing nothing about him (17 Nov 2026).
//
// The main Mac (the owner key) puts its files up (sync:putMemory). Every other
// runner copies them down into each of its Claude logins (sync:memorySince),
// and Codex's AGENTS.md for the global one. A file someone changed there isn't
// written over unseen: it's offered back first (sync:offerMemory), and one
// that was there before sync ever wrote it is left alone. Offers land on the
// main Mac in memory-offers/ in the data dir, as data for the nightly retro to
// fold in or drop, never straight into memory: a runner key mustn't be able
// to brief the main Mac's agents (convex/memorySync.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isDirectory, readJsonSync } from './fsutil.ts';
import type { Logger } from './log.ts';

// The same rule as convex/memorySync.ts MEMORY_PATH (memory-sync.test.ts
// holds them to each other). Releases carry runner/ alone, so it's a copy.
export const MEMORY_PATH = /^(?:global\/CLAUDE\.md|memory\/~(?:-[A-Za-z0-9-]*)?\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;
export const MAX_MEMORY_PATH = 240;
export const MAX_MEMORY_FILE = 128 * 1024;
export const MEMORY_BATCH = 50;
export const GLOBAL_PATH = 'global/CLAUDE.md';
export const MEMORY_TICK_MS = 60_000;
export const MEMORY_API_VERSION = 84;

export type MemoryPut = { path: string; hash: string; text?: string; gone?: boolean };
export type MemoryRow = { path: string; hash: string; text: string; gone?: true; seq: number };
export type MemoryOffer = { id: string; runnerId: string; path: string; hash: string; text: string; at: number };

export type MemoryBackend = {
  // This runner holds the owner key: the main Mac, whose files are the ones shared.
  readonly owner: boolean;
  put(files: MemoryPut[]): Promise<number>;
  since(after: number): Promise<{ rows: MemoryRow[]; more: boolean; seq: number }>;
  offer(files: { path: string; hash: string; text: string }[]): Promise<void>;
  offers(): Promise<MemoryOffer[]>;
  take(taken: { id: string; hash: string }[]): Promise<void>;
};

export type MemorySyncDeps = {
  home: string;
  // The runner's data dir: memory-sync.json, and memory-offers/ on the main Mac.
  dataDir: string;
  on: () => boolean;
  // Each Claude login's config dir (~/.claude for claude-main), and each
  // Codex one's (CODEX_HOME), as the runner knows them now.
  claudeDirs: () => string[];
  codexDirs: () => string[];
  // Takes out secret values the runner knows of before anything goes up.
  scrub: (text: string) => string;
  log: Pick<Logger, 'info' | 'warn' | 'debug'>;
  setTimer?: (run: () => void, ms: number) => { unref?: () => void };
};

// What this runner last synced, so it can tell its own writes from edits.
type Manifest = {
  // Receivers: the newest seq applied.
  after: number;
  // The hash of each file as last put up (main Mac) or written down (others).
  files: Record<string, string>;
  // Others: the hash last offered for each path, so it's offered once.
  offered: Record<string, string>;
  // Others: files that were there before sync wrote that path, left alone
  // for good (another login's own CLAUDE.md, say).
  kept: Record<string, true>;
};

export function memoryPathOk(p: string): boolean {
  return typeof p === 'string' && p.length <= MAX_MEMORY_PATH && MEMORY_PATH.test(p) && !p.includes('..');
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Claude Code names a project's folder after its path with every character
// that isn't a letter or digit made a dash ("/Users/bruce/dev/me" is
// "-Users-bruce-dev-me"). A folder under home becomes "~" and the rest, so it
// lands under the other Mac's home; anything else isn't shared.
export function homeSlug(home: string): string {
  return home.replace(/[^A-Za-z0-9]/g, '-');
}

export function folderOf(slug: string, home: string): string | undefined {
  const h = homeSlug(home);
  if (slug === h) return '~';
  // ~/Library is apps' own scratch folders (Claude's desktop app makes one a
  // chat), not projects anyone opens on another Mac.
  if (slug.startsWith(`${h}-`) && !slug.startsWith(`${h}-Library-`)) return `~${slug.slice(h.length)}`;
  return undefined;
}

export function slugOf(folder: string, home: string): string {
  return homeSlug(home) + folder.slice(1);
}

function readText(file: string): string | undefined {
  try {
    const st = fs.lstatSync(file);
    // A link is followed (the M5's logins link their CLAUDE.md to one file);
    // anything that isn't a plain file in the end is skipped.
    const real = st.isSymbolicLink() ? fs.realpathSync(file) : file;
    const rst = fs.statSync(real);
    if (!rst.isFile() || rst.size > MAX_MEMORY_FILE) return undefined;
    return fs.readFileSync(real, 'utf8');
  } catch {
    return undefined;
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Not there yet: its nearest folder that is, and the rest.
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

function uniq<T>(items: T[], keyOf: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = keyOf(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Every shareable file this runner's logins hold now: path -> text. Where two
// logins hold the same path in different folders (logins not linked to one
// memory), the newer file wins.
export function scanLocal(home: string, claudeDirs: string[]): Map<string, string> {
  const out = new Map<string, { text: string; mtime: number }>();
  const add = (p: string, file: string) => {
    if (!memoryPathOk(p)) return;
    const text = readText(file);
    if (text === undefined) return;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    const had = out.get(p);
    if (!had || mtime > had.mtime) out.set(p, { text, mtime });
  };
  const dirs = uniq(claudeDirs.filter(isDirectory), real);
  // The global file: ~/.claude's first, else the first login that has one.
  const globals = uniq([path.join(home, '.claude'), ...dirs], real).map((d) => path.join(d, 'CLAUDE.md'));
  const g = globals.find((f) => readText(f) !== undefined);
  if (g) out.set(GLOBAL_PATH, { text: readText(g)!, mtime: Infinity });
  const seenMemory = new Set<string>();
  for (const dir of dirs) {
    const projects = path.join(dir, 'projects');
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      continue;
    }
    for (const slug of slugs) {
      const folder = folderOf(slug, home);
      if (!folder) continue;
      const mem = path.join(projects, slug, 'memory');
      if (!isDirectory(mem)) continue;
      const r = real(mem);
      if (seenMemory.has(r)) continue;
      seenMemory.add(r);
      let names: string[] = [];
      try {
        names = fs.readdirSync(mem);
      } catch {
        continue;
      }
      for (const name of names) if (name.endsWith('.md') && !name.startsWith('.')) add(`memory/${folder}/${name}`, path.join(mem, name));
    }
  }
  return new Map([...out].map(([p, v]) => [p, v.text]));
}

// Where a path goes on this runner: one file per distinct real place, across
// every login (and Codex's AGENTS.md for the global one).
export function targetsOf(p: string, home: string, claudeDirs: string[], codexDirs: string[]): string[] {
  if (!memoryPathOk(p)) return [];
  const claude = uniq([path.join(home, '.claude'), ...claudeDirs], real);
  let files: string[];
  if (p === GLOBAL_PATH) {
    // Only Codex homes that are there: a Mac without Codex gets no ~/.codex.
    const codex = uniq([path.join(home, '.codex'), ...codexDirs].filter(isDirectory), real);
    files = [...claude.map((d) => path.join(d, 'CLAUDE.md')), ...codex.map((d) => path.join(d, 'AGENTS.md'))];
  } else {
    const [, folder, name] = p.split('/');
    const slug = slugOf(folder!, home);
    files = claude.map((d) => path.join(d, 'projects', slug, 'memory', name!));
  }
  return uniq(files, real);
}

export class MemorySync {
  private deps: MemorySyncDeps;
  private backend?: MemoryBackend;
  private manifest: Manifest;
  private manifestPath: string;
  private running = false;
  private timer?: { unref?: () => void };
  private stopped = false;

  constructor(deps: MemorySyncDeps) {
    this.deps = deps;
    this.manifestPath = path.join(deps.dataDir, 'memory-sync.json');
    const m = readJsonSync<Partial<Manifest>>(this.manifestPath);
    this.manifest = {
      after: typeof m?.after === 'number' ? m.after : 0,
      files: m?.files && typeof m.files === 'object' ? { ...m.files } : {},
      offered: m?.offered && typeof m.offered === 'object' ? { ...m.offered } : {},
      kept: m?.kept && typeof m.kept === 'object' ? { ...m.kept } : {},
    };
  }

  // From sync's heartbeat once the backend has API 84, again and again: the
  // first call starts the minute timer.
  attach(backend: MemoryBackend): void {
    this.backend = backend;
    if (this.timer || this.stopped) return;
    this.schedule(1000);
  }

  stop(): void {
    this.stopped = true;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const set = this.deps.setTimer ?? ((run: () => void, wait: number) => setTimeout(run, wait));
    this.timer = set(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule(MEMORY_TICK_MS));
    }, ms);
    this.timer.unref?.();
  }

  // One pass. Exposed for tests.
  async tick(): Promise<void> {
    if (this.running || !this.backend || !this.deps.on()) return;
    this.running = true;
    try {
      if (this.backend.owner) {
        await this.putUp();
        await this.takeOffers();
      } else {
        await this.offerEdits();
        await this.pullDown();
      }
    } catch (e) {
      this.deps.log.warn('memory sync failed', { error: String((e as Error)?.message ?? e) });
    } finally {
      this.running = false;
    }
  }

  private save(): void {
    atomicWriteFileSync(this.manifestPath, JSON.stringify(this.manifest), 0o600);
  }

  // ---- the main Mac

  private async putUp(): Promise<void> {
    const local = scanLocal(this.deps.home, this.deps.claudeDirs());
    const changes: (MemoryPut & { sent: string })[] = [];
    for (const [p, raw] of local) {
      const text = this.deps.scrub(raw);
      const hash = sha256(text);
      if (this.manifest.files[p] !== hash) changes.push({ path: p, hash, text, sent: hash });
    }
    for (const p of Object.keys(this.manifest.files)) {
      if (!local.has(p)) changes.push({ path: p, hash: sha256(''), gone: true, sent: '' });
    }
    for (let i = 0; i < changes.length; i += MEMORY_BATCH) {
      const batch = changes.slice(i, i + MEMORY_BATCH);
      await this.backend!.put(batch.map(({ sent: _s, ...f }) => f));
      for (const f of batch) {
        if (f.gone) delete this.manifest.files[f.path];
        else this.manifest.files[f.path] = f.sent;
      }
      this.save();
    }
    if (changes.length) this.deps.log.info('memory put up', { files: changes.length });
  }

  // Offers from other runners go into memory-offers/<runner>/<path>, where
  // the nightly retro reads them. Never into memory itself.
  private async takeOffers(): Promise<void> {
    const offers = await this.backend!.offers();
    if (!offers.length) return;
    const root = path.join(this.deps.dataDir, 'memory-offers');
    const taken: { id: string; hash: string }[] = [];
    for (const o of offers) {
      if (memoryPathOk(o.path) && /^[A-Za-z0-9_-]{1,64}$/.test(o.runnerId)) {
        const file = path.join(root, o.runnerId, ...o.path.split('/'));
        if (!file.startsWith(root + path.sep)) continue;
        atomicWriteFileSync(file, o.text, 0o600);
      }
      taken.push({ id: o.id, hash: o.hash });
    }
    await this.backend!.take(taken);
    this.deps.log.info('memory offers saved', { files: taken.length });
  }

  // ---- every other runner

  private targets(p: string): string[] {
    return targetsOf(p, this.deps.home, this.deps.claudeDirs(), this.deps.codexDirs());
  }

  // Files here that differ from what sync last wrote: new memories, or edits
  // to one the main Mac sent. Each offered once per version.
  private async offerEdits(): Promise<void> {
    const local = scanLocal(this.deps.home, this.deps.claudeDirs());
    // Codex's AGENTS.md is the global file too.
    const offers: { path: string; hash: string; text: string }[] = [];
    for (const [p, raw] of local) {
      const text = this.deps.scrub(raw);
      const hash = sha256(text);
      const ownHash = sha256(raw);
      if (this.manifest.files[p] === ownHash || this.manifest.files[p] === hash) continue;
      if (this.manifest.offered[p] === hash) continue;
      offers.push({ path: p, hash, text });
    }
    await this.sendOffers(offers);
  }

  private async sendOffers(offers: { path: string; hash: string; text: string }[]): Promise<void> {
    for (let i = 0; i < offers.length; i += MEMORY_BATCH) {
      const batch = offers.slice(i, i + MEMORY_BATCH);
      await this.backend!.offer(batch);
      for (const o of batch) this.manifest.offered[o.path] = o.hash;
      this.save();
    }
    if (offers.length) this.deps.log.info('memory offered to the main Mac', { files: offers.length });
  }

  private async pullDown(): Promise<void> {
    for (let pages = 0; pages < 200; pages++) {
      const page = await this.backend!.since(this.manifest.after);
      for (const row of page.rows) {
        if (row.seq <= this.manifest.after) continue;
        await this.apply(row);
        this.manifest.after = row.seq;
      }
      this.save();
      if (!page.more || !page.rows.length) return;
    }
  }

  private async apply(row: MemoryRow): Promise<void> {
    if (!memoryPathOk(row.path)) return;
    const was = this.manifest.files[row.path];
    let wrote = false;
    for (const file of this.targets(row.path)) {
      if (this.manifest.kept[file]) continue;
      const current = readText(file);
      const exists = current !== undefined || fs.existsSync(file);
      const hash = current === undefined ? undefined : sha256(current);
      if (row.gone) {
        // Only a file sync wrote, and nobody's changed since.
        if (hash !== undefined && hash === was) fs.rmSync(real(file), { force: true });
        continue;
      }
      if (hash === row.hash) {
        wrote = true;
        continue;
      }
      if (exists && hash !== was) {
        if (was === undefined) {
          // There before sync: someone's own file, left as it is from now on.
          this.manifest.kept[file] = true;
          this.deps.log.warn('memory sync left a file it did not write', { file });
          continue;
        }
        // Changed here since sync wrote it: offered back before it's replaced.
        if (current !== undefined) {
          const text = this.deps.scrub(current);
          const h = sha256(text);
          if (this.manifest.offered[row.path] !== h) await this.sendOffers([{ path: row.path, hash: h, text }]);
        }
      }
      atomicWriteFileSync(real(file), row.text);
      wrote = true;
    }
    if (row.gone) delete this.manifest.files[row.path];
    else if (wrote) this.manifest.files[row.path] = row.hash;
  }
}
