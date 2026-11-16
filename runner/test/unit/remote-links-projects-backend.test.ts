// What another runner writes into a thread row, read back by the phone and
// the website (convex/sync.ts upsertThreads, phone.ts), against an
// in-memory database (test/helpers/convex-memory.ts):
// - Daybreak 139: an ask's links and a thread's links are web pages or
//   nothing, so a runner key can't store a mailto:, slack: or intent: link
//   for the website to hand to another app.
// - Daybreak 141: a project is (runnerId, projectId). A runner that gives its
//   own thread another runner's project id doesn't put that thread in the
//   other runner's project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const tokens = load('tokens');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  const { code } = await call(b.ctx, sync.issuePairingCode, { key: OWNER, kind: 'browser', name: 'web' });
  const { token } = (await call(b.ctx, tokens.claim, { code })) as { token: string };
  return { ...b, token };
}

const thread = (threadId: string, runnerId: string, extra: Record<string, unknown> = {}) => ({ threadId, runnerId, ...THREAD_BASICS, title: threadId, view: 'inbox', needsYou: false, ...extra });
const project = (id: string, title: string) => ({ id, title, folders: [], goals: '', state: '', notes: '', createdBy: 'mike', archived: false, createdAt: 'c', updatedAt: 'u', threadCount: 1 });

const NOT_WEB = [
  'mailto:boss@example.com?subject=Resign&body=I%20quit',
  'slack://open?team=T0&id=C0',
  'intent://scan/#Intent;scheme=zxing;package=com.example;end',
  'x-apple.systempreferences:com.apple.preference.security',
  'file:///etc/passwd',
  'data:text/html,<script>alert(1)</script>',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'https://',
  'https://' + 'a'.repeat(3000) + '.example',
];

for (const [who, key, runnerId] of [['a runner key', MINI_KEY, MINI], ['the main key', OWNER, LAPTOP]] as const) {
  test(`${who}'s thread keeps only web links on its ask card and its links (139)`, async () => {
    const s = await setup();
    const links = [...NOT_WEB.map((url, i) => ({ title: `bad ${i}`, url })), { title: 'Docs', url: 'https://docs.example.com/page?a=1' }, { title: 'Local', url: 'http://localhost:3000/' }];
    await call(s.ctx, sync.upsertThreads, {
      key,
      threads: [thread('T', runnerId, { needsYou: true, asksSeq: 1, asks: [{ action: 'Do it', links }, { action: 'Only bad', links: NOT_WEB.map((url) => ({ title: 'x', url })) }], links })],
    });
    const row = s.rows('threads').find((t) => t.threadId === 'T')!;
    assert.deepEqual(row.asks[0].links.map((l: { url: string }) => l.url), ['https://docs.example.com/page?a=1', 'http://localhost:3000/']);
    assert.equal(row.asks[1].links, undefined, 'an ask with only non-web links keeps none');
    assert.deepEqual(row.links.map((l: { url: string }) => l.url), ['https://docs.example.com/page?a=1', 'http://localhost:3000/']);
    // And what the website and phones read has none either.
    const { thread: read } = (await call(s.ctx, phone.thread, { token: s.token, threadId: 'T' })) as { thread: { asks?: { links?: { url: string }[] }[]; links?: { url: string }[] } };
    const seen = [...(read.asks ?? []).flatMap((a) => a.links ?? []), ...(read.links ?? [])].map((l) => l.url);
    assert.ok(seen.length > 0);
    for (const url of seen) assert.ok(!NOT_WEB.includes(url), `${url.slice(0, 40)} reached the phone`);
  });
}

test("a runner's thread with another runner's project id isn't in that runner's project (141)", async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: LAPTOP, projects: [project('p_shared', 'Main project')] });
  await call(s.ctx, sync.setProjects, { key: MINI_KEY, runnerId: MINI, projects: [project('p_shared', 'Mini project')] });
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('MAIN', LAPTOP, { projects: [{ id: 'p_shared', title: 'Main project' }] })] });
  // The other runner claims the main runner's project id for its own thread,
  // with that project's title, and an id it has no project for.
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('EVIL', MINI, { projects: [{ id: 'p_shared', title: 'Main project' }, { id: 'p_main_only', title: 'x' }] })] });
  const ids = async (runnerId: string | undefined, projectId: string) => ((await call(s.ctx, phone.projectThreads, { token: s.token, ...(runnerId ? { runnerId } : {}), projectId })) as { threadId: string }[]).map((t) => t.threadId);
  assert.deepEqual(await ids(LAPTOP, 'p_shared'), ['MAIN']);
  assert.deepEqual(await ids(MINI, 'p_shared'), ['EVIL']);
  assert.deepEqual(await ids(LAPTOP, 'p_main_only'), []);
  // A page from before API 82 asks by the id alone: nothing, not both runners'.
  assert.deepEqual(await ids(undefined, 'p_shared'), []);
  // Every link is under its own thread's runner.
  for (const l of s.rows('projectThreads')) assert.equal(l.runnerId, s.rows('threads').find((t) => t.threadId === l.threadId)!.runnerId);
});
