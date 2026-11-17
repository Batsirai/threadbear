// Shared memory (memory-sync.ts, docs/protocol.md "Shared memory"): the main
// Mac puts its global CLAUDE.md and memory folders up, the other runners copy
// them into their own logins under their own home, and their agents' saves
// come back as offers that land beside the main Mac's memory, never in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderOf, GLOBAL_PATH, MEMORY_PATH, MemorySync, slugOf, type MemoryBackend, type MemoryOffer, type MemoryPut, type MemoryRow } from '../../src/memory-sync.ts';

// The backend's side, as convex/memorySync.ts does it: one seq per change,
// only changed rows written, gone rows kept.
class FakeBackend {
  files = new Map<string, MemoryRow>();
  seq = 0;
  offers: MemoryOffer[] = [];
  nextId = 1;
  as(owner: boolean, runnerId: string): MemoryBackend {
    return {
      owner,
      put: async (files: MemoryPut[]) => {
        assert.ok(owner, 'only the owner puts');
        let n = 0;
        for (const f of files) {
          assert.match(f.path, MEMORY_PATH);
          const row = this.files.get(f.path);
          if (f.gone) {
            if (!row || row.gone) continue;
            this.files.set(f.path, { path: f.path, hash: f.hash, text: '', gone: true, seq: ++this.seq });
          } else {
            if (row && !row.gone && row.hash === f.hash) continue;
            this.files.set(f.path, { path: f.path, hash: f.hash, text: f.text!, seq: ++this.seq });
          }
          n++;
        }
        return n;
      },
      since: async (after: number) => {
        const rows = [...this.files.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq);
        return { rows: rows.slice(0, 2), more: rows.length > 2, seq: this.seq };
      },
      offer: async (files) => {
        assert.ok(!owner, "the owner's files aren't offers");
        for (const f of files) {
          this.offers = this.offers.filter((o) => !(o.runnerId === runnerId && o.path === f.path));
          this.offers.push({ id: String(this.nextId++), runnerId, ...f, at: Date.now() });
        }
      },
      offers: async () => {
        assert.ok(owner);
        return [...this.offers];
      },
      take: async (taken) => {
        this.offers = this.offers.filter((o) => !taken.some((t) => t.id === o.id && t.hash === o.hash));
      },
    };
  }
}

type Mac = { home: string; data: string; claude: string[]; codex: string[] };

function mac(name: string, extraLogins = 0, codex = false): Mac {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tb-mem-${name}-`));
  const home = path.join(root, 'Users', name);
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const claude = [path.join(home, '.claude')];
  for (let i = 1; i <= extraLogins; i++) {
    const d = path.join(root, 'accounts', `claude-${i}`);
    fs.mkdirSync(d, { recursive: true });
    claude.push(d);
  }
  if (codex) fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return { home, data, claude, codex: [] };
}

function memDir(m: Mac, dir: string, rel: string): string {
  return path.join(dir, 'projects', slugOf(rel, m.home), 'memory');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const quiet = { info() {}, warn() {}, debug() {} };

function syncFor(m: Mac, opts: { on?: () => boolean; scrub?: (t: string) => string } = {}): MemorySync {
  return new MemorySync({
    home: m.home,
    dataDir: m.data,
    on: opts.on ?? (() => true),
    claudeDirs: () => m.claude,
    codexDirs: () => m.codex,
    scrub: opts.scrub ?? ((t) => t),
    log: quiet,
    setTimer: () => ({}),
  });
}

test("the runner's path rule is the backend's", () => {
  const convex = fs.readFileSync(path.join(import.meta.dirname, '../../../convex/memorySync.ts'), 'utf8');
  const m = convex.match(/export const MEMORY_PATH = (\/.*\/);/);
  assert.ok(m, 'found the backend rule');
  assert.equal(m![1], String(MEMORY_PATH));
  for (const ok of ['global/CLAUDE.md', 'memory/~/MEMORY.md', 'memory/~-dev-me-misc/claude-accounts.md']) assert.match(ok, MEMORY_PATH);
  for (const bad of ['memory/~-dev/../x.md', 'memory/dev/x.md', 'memory/~-dev/sub/x.md', 'memory/~-dev/.x.md', 'global/AGENTS.md', 'memory/~-dev/x.txt']) assert.doesNotMatch(bad, MEMORY_PATH);
});

test('folders under home travel as ~ paths; ~/Library and the rest stay put', () => {
  assert.equal(folderOf('-Users-m5-mike-dev-me-misc', '/Users/m5-mike'), '~-dev-me-misc');
  assert.equal(folderOf('-Users-m5-mike', '/Users/m5-mike'), '~');
  assert.equal(folderOf('-Users-m5-mike-Library-Application-Support-Claude-x', '/Users/m5-mike'), undefined);
  assert.equal(folderOf('-private-tmp', '/Users/m5-mike'), undefined);
  assert.equal(folderOf('-Users-m5-mike2-dev', '/Users/m5-mike'), undefined);
  assert.equal(slugOf('~-dev-me-misc', '/Users/bruce'), '-Users-bruce-dev-me-misc');
  assert.equal(slugOf('~', '/Users/bruce'), '-Users-bruce');
});

test("the main Mac's memory reaches every login on another runner, under its own home, and changes follow", async () => {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  const bruce = mac('bruce', 1, true);
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), '# I talk, I dont type\n');
  const misc = memDir(m5, m5.claude[0]!, '~-dev-me-misc');
  write(path.join(misc, 'MEMORY.md'), '- [Bruce](bruce.md)\n');
  write(path.join(misc, 'bruce.md'), 'Bruce is a Mac mini\n');
  write(path.join(misc, 'old.md'), 'going\n');
  write(path.join(memDir(m5, m5.claude[0]!, '~-Library-Application-Support-Claude-scratch'), 'x.md'), 'scratch\n');
  write(path.join(m5.claude[0]!, 'projects', '-private-tmp', 'memory', 'y.md'), 'tmp\n');

  const owner = syncFor(m5);
  owner.attach(backend.as(true, 'm5'));
  await owner.tick();
  assert.deepEqual([...backend.files.keys()].sort(), [GLOBAL_PATH, 'memory/~-dev-me-misc/MEMORY.md', 'memory/~-dev-me-misc/bruce.md', 'memory/~-dev-me-misc/old.md']);

  const other = syncFor(bruce);
  other.attach(backend.as(false, 'bruce'));
  await other.tick();
  for (const dir of bruce.claude) {
    assert.equal(read(path.join(dir, 'CLAUDE.md')), '# I talk, I dont type\n');
    assert.equal(read(path.join(memDir(bruce, dir, '~-dev-me-misc'), 'bruce.md')), 'Bruce is a Mac mini\n');
  }
  assert.equal(read(path.join(bruce.home, '.codex', 'AGENTS.md')), '# I talk, I dont type\n');
  assert.equal(backend.offers.length, 0, 'what it wrote down is not offered back');

  // An edit and a delete on the main Mac.
  write(path.join(misc, 'bruce.md'), 'Bruce is a Mac mini with 8 GB\n');
  fs.rmSync(path.join(misc, 'old.md'));
  await owner.tick();
  await other.tick();
  assert.equal(read(path.join(memDir(bruce, bruce.claude[0]!, '~-dev-me-misc'), 'bruce.md')), 'Bruce is a Mac mini with 8 GB\n');
  assert.equal(read(path.join(memDir(bruce, bruce.claude[0]!, '~-dev-me-misc'), 'old.md')), undefined);
  // Nothing changed: nothing more goes up.
  const seq = backend.seq;
  await owner.tick();
  assert.equal(backend.seq, seq);
});

test("another runner's saves come back as offers beside the main Mac's memory, never in it", async () => {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  const bruce = mac('bruce');
  const misc = memDir(m5, m5.claude[0]!, '~-dev-me-misc');
  write(path.join(misc, 'MEMORY.md'), 'index v1\n');
  const owner = syncFor(m5);
  owner.attach(backend.as(true, 'm5'));
  const other = syncFor(bruce);
  other.attach(backend.as(false, 'bruce'));
  await owner.tick();
  await other.tick();

  const there = memDir(bruce, bruce.claude[0]!, '~-dev-me-misc');
  write(path.join(there, 'new.md'), 'learned on bruce\n');
  write(path.join(there, 'MEMORY.md'), 'index v1 + bruce line\n');
  await other.tick();
  assert.deepEqual(backend.offers.map((o) => o.path).sort(), ['memory/~-dev-me-misc/MEMORY.md', 'memory/~-dev-me-misc/new.md']);
  await other.tick();
  assert.equal(backend.offers.length, 2, 'each version offered once');

  await owner.tick();
  assert.equal(backend.offers.length, 0, 'taken');
  assert.equal(read(path.join(m5.data, 'memory-offers', 'bruce', 'memory', '~-dev-me-misc', 'new.md')), 'learned on bruce\n');
  assert.equal(read(path.join(misc, 'new.md')), undefined, "the main Mac's memory is untouched");
  assert.equal(read(path.join(misc, 'MEMORY.md')), 'index v1\n');
  assert.equal(backend.files.has('memory/~-dev-me-misc/new.md'), false, 'and nothing of it goes to the other runners');

  // The main Mac changes the file Bruce edited: Bruce's edit was already
  // offered, so the main Mac's newer one replaces it.
  write(path.join(misc, 'MEMORY.md'), 'index v2\n');
  await owner.tick();
  await other.tick();
  assert.equal(read(path.join(there, 'MEMORY.md')), 'index v2\n');
});

test('an edit not yet offered is offered before the main Mac replaces it', async () => {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  const bruce = mac('bruce');
  const misc = memDir(m5, m5.claude[0]!, '~-dev-me-misc');
  write(path.join(misc, 'a.md'), 'v1\n');
  const owner = syncFor(m5);
  owner.attach(backend.as(true, 'm5'));
  const other = syncFor(bruce);
  const b = backend.as(false, 'bruce');
  other.attach(b);
  await owner.tick();
  await other.tick();
  // Edited on Bruce and changed on the main Mac before Bruce's next pass:
  // the pull itself offers the edit first.
  write(path.join(memDir(bruce, bruce.claude[0]!, '~-dev-me-misc'), 'a.md'), 'bruce edit\n');
  write(path.join(misc, 'a.md'), 'v2\n');
  await owner.tick();
  // Straight to the pull, as if the edit landed between scan and pull.
  await (other as unknown as { pullDown(): Promise<void> }).pullDown();
  assert.deepEqual(backend.offers.map((o) => o.text), ['bruce edit\n']);
  assert.equal(read(path.join(memDir(bruce, bruce.claude[0]!, '~-dev-me-misc'), 'a.md')), 'v2\n');
});

test("a file that was there before sync isn't written over, and is offered instead", async () => {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  const bruce = mac('bruce');
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global\n');
  write(path.join(bruce.home, '.claude', 'CLAUDE.md'), "bruce's own\n");
  const owner = syncFor(m5);
  owner.attach(backend.as(true, 'm5'));
  const other = syncFor(bruce);
  other.attach(backend.as(false, 'bruce'));
  await owner.tick();
  await other.tick();
  await other.tick();
  assert.equal(read(path.join(bruce.home, '.claude', 'CLAUDE.md')), "bruce's own\n");
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'mike global v2\n');
  await owner.tick();
  await other.tick();
  assert.equal(read(path.join(bruce.home, '.claude', 'CLAUDE.md')), "bruce's own\n", 'still left alone');
  // Offered on Bruce's first pass, and taken by the main Mac's next one.
  assert.equal(read(path.join(m5.data, 'memory-offers', 'bruce', 'global', 'CLAUDE.md')), "bruce's own\n");
  assert.equal(read(path.join(m5.home, '.claude', 'CLAUDE.md')), 'mike global v2\n');
});

test('off: nothing goes up or comes down; secrets are masked before anything goes up', async () => {
  const backend = new FakeBackend();
  const m5 = mac('m5mike');
  write(path.join(m5.home, '.claude', 'CLAUDE.md'), 'token sk-live-123\n');
  let on = false;
  const owner = syncFor(m5, { on: () => on, scrub: (t) => t.replace(/sk-live-\d+/g, '[secret]') });
  owner.attach(backend.as(true, 'm5'));
  await owner.tick();
  assert.equal(backend.files.size, 0);
  on = true;
  await owner.tick();
  assert.equal(backend.files.get(GLOBAL_PATH)?.text, 'token [secret]\n');
});
