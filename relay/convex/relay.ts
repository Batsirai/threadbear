// The relay's records: installs and the daily counts (schema.ts).
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { MAX_REASONS, reasonKey } from './reasons';
import { countVersions, storedVersion } from './versions';

// Per install, so one runaway backend can't flood anyone's phone or Apple.
export const SENDS_PER_HOUR = 120;
// Registrations a day for one checked deployment. It only registers again
// when it lost its install, so this only stops a backend stuck in a loop;
// nobody else can use it up, as only the deployment passes the check.
export const REGISTRATIONS_PER_DEPLOYMENT_PER_DAY = 20;

// Relay-wide limits (Daybreak 144, 16 Nov 2026). The check in verify.ts
// proves a caller runs the deployment it names, not that it runs
// Threadbear, and anyone can make Convex deployments, so each new one is
// another 120 sends an hour and another row. These bound what a pile of
// made-up deployments can take, without touching installs that are
// already here: a deployment registering again never counts as new, and
// an install's own allowance only shrinks while it's new or sending to
// tokens that aren't real. Sized well above real use (16 Nov: 69 installs
// active in a week, at most 11 registrations a day, 450 to 750 sends a
// day in all).
//
// Deployments seen for the first time, relay-wide, each UTC day.
export const NEW_INSTALLS_PER_DAY = 100;
// An install this young shares one hourly pool with every other young one.
export const NEW_INSTALL_MS = 7 * 86_400_000;
export const NEW_INSTALL_SENDS_PER_HOUR = 600;
// Sends a device token was to blame for (tokenFault) an install may make in
// an hour. A real backend drops a token Apple or Firebase calls gone, so it
// makes a few; made-up tokens make nothing else.
export const BAD_TOKEN_SENDS_PER_HOUR = 20;
// An install not seen (no send, no registration) for this long is removed
// (crons.ts). A backend from 5 Nov 2026 just registers again when /send
// answers 401 (convex/push.ts), so only an abandoned one loses anything.
export const IDLE_INSTALL_MS = 90 * 86_400_000;

// A failed send the device token was to blame for: a bad, wrong-app or
// unregistered token (Apple's 400 and 410, Firebase's 400 and 404). Not
// the relay's own trouble (a revoked key's 403, a timeout's 0), which
// mustn't use up a real backend's allowance.
export const tokenFault = (status: number | undefined) => status === 400 || status === 404 || status === 410;

const hourOf = (ms: number) => new Date(ms).toISOString().slice(0, 13);

export const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// For a deployment that passed the check (http.ts, verify.ts): one install
// per deployment, so registering again gives the same install a new key
// and the old key stops working. Its hourly send count carries over.
export const registerVerified = internalMutation({
  args: { deployment: v.string(), version: v.optional(v.string()) },
  returns: v.object({ installId: v.string(), installKey: v.string() }),
  handler: async (ctx, { deployment, version }) => {
    const today = day();
    const existing = await ctx.db
      .query('installs')
      .withIndex('by_deployment', (q) => q.eq('deployment', deployment))
      .first();
    const registeredToday = existing?.registeredDay === today ? (existing.registeredToday ?? 0) : 0;
    if (registeredToday >= REGISTRATIONS_PER_DEPLOYMENT_PER_DAY) throw new ConvexError({ kind: 'busy', message: 'this deployment registered too often today; try again tomorrow' });
    const now = Date.now();
    // A deployment the relay hasn't seen (or forgot, crons.ts) is a new
    // install, and those are capped relay-wide; one it knows never is, so
    // nobody can lock an existing backend out by making deployments.
    if (!existing) await countNewInstall(ctx, today);
    const installKey = 'k_' + randomHex(24);
    const fields = { keyHash: await sha256(installKey), lastSeenAt: now, ...(version !== undefined ? { version: storedVersion(version) } : {}), deployment, registeredDay: today, registeredToday: registeredToday + 1 };
    let installId: string;
    if (existing) {
      installId = existing.installId;
      await ctx.db.patch(existing._id, fields);
    } else {
      installId = 'i_' + randomHex(12);
      await ctx.db.insert('installs', { installId, createdAt: now, hourStart: now, hourSends: 0, ...fields });
    }
    await countRegistration(ctx, today);
    return { installId, installKey };
  },
});

async function countNewInstall(ctx: MutationCtx, today: string): Promise<void> {
  const counts = await ctx.db
    .query('days')
    .withIndex('by_day', (q) => q.eq('day', today))
    .unique();
  const made = counts?.newInstalls ?? 0;
  if (made >= NEW_INSTALLS_PER_DAY) throw new ConvexError({ kind: 'busy', message: 'the relay has taken all the new installs it takes today; try again tomorrow' });
  if (counts) await ctx.db.patch(counts._id, { newInstalls: made + 1 });
  else await ctx.db.insert('days', { day: today, sends: 0, failed: 0, registrations: 0, newInstalls: 1 });
}

async function countRegistration(ctx: MutationCtx, today: string): Promise<void> {
  const counts = await ctx.db
    .query('days')
    .withIndex('by_day', (q) => q.eq('day', today))
    .unique();
  if (counts) await ctx.db.patch(counts._id, { registrations: counts.registrations + 1 });
  else await ctx.db.insert('days', { day: today, sends: 0, failed: 0, registrations: 1 });
}

// Checks the install's key and rate limit, and counts the send.
export const admit = internalMutation({
  args: { installId: v.string(), installKey: v.string(), version: v.optional(v.string()) },
  returns: v.union(v.literal('ok'), v.literal('auth'), v.literal('limited')),
  handler: async (ctx, { installId, installKey, version }) => {
    const row = await ctx.db
      .query('installs')
      .withIndex('by_installId', (q) => q.eq('installId', installId))
      .unique();
    if (!row || row.keyHash !== (await sha256(installKey))) return 'auth';
    const now = Date.now();
    const fresh = now - row.hourStart >= 3_600_000;
    const sends = fresh ? 0 : row.hourSends;
    const bad = fresh ? 0 : (row.hourBad ?? 0);
    if (sends >= SENDS_PER_HOUR || bad >= BAD_TOKEN_SENDS_PER_HOUR) return 'limited';
    // Young installs share one pool, so a batch of new deployments can't
    // each take a full allowance (the limits above say why).
    if (now - row.createdAt < NEW_INSTALL_MS) {
      const hour = hourOf(now);
      const pool = await ctx.db
        .query('hours')
        .withIndex('by_hour', (q) => q.eq('hour', hour))
        .unique();
      if ((pool?.newSends ?? 0) >= NEW_INSTALL_SENDS_PER_HOUR) return 'limited';
      if (pool) await ctx.db.patch(pool._id, { newSends: pool.newSends + 1 });
      else await ctx.db.insert('hours', { hour, newSends: 1 });
    }
    await ctx.db.patch(row._id, { lastSeenAt: now, hourStart: fresh ? now : row.hourStart, hourSends: sends + 1, hourBad: bad, ...(version !== undefined ? { version: storedVersion(version) } : {}) });
    return 'ok';
  },
});

export const counted = internalMutation({
  args: { ok: v.boolean(), status: v.optional(v.number()), reason: v.optional(v.string()), installId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { ok, status, reason, installId }) => {
    const today = day();
    // Against the install's hourly allowance of bad tokens (admit).
    if (!ok && installId !== undefined && tokenFault(status)) {
      const row = await ctx.db
        .query('installs')
        .withIndex('by_installId', (q) => q.eq('installId', installId))
        .unique();
      if (row) await ctx.db.patch(row._id, { hourBad: (row.hourBad ?? 0) + 1 });
    }
    const counts = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', today))
      .unique();
    const add = { sends: ok ? 1 : 0, failed: ok ? 0 : 1 };
    const reasons = { ...(counts?.reasons ?? {}) };
    if (!ok) {
      let key = reasonKey(status ?? 0, reason);
      if (!(key in reasons) && Object.keys(reasons).length >= MAX_REASONS) key = 'other';
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    const tally = ok ? {} : { reasons };
    if (counts) await ctx.db.patch(counts._id, { sends: counts.sends + add.sends, failed: counts.failed + add.failed, ...tally });
    else await ctx.db.insert('days', { day: today, registrations: 0, ...add, ...tally });
    return null;
  },
});

// For Mike: `npx convex run relay:stats --prod`.
export const stats = internalQuery({
  args: {},
  returns: v.object({ installs: v.number(), activeLast7Days: v.number(), versions: v.record(v.string(), v.number()), days: v.array(v.object({ day: v.string(), sends: v.number(), failed: v.number(), registrations: v.number(), newInstalls: v.optional(v.number()), reasons: v.optional(v.record(v.string(), v.number())) })) }),
  handler: async (ctx) => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    let installs = 0;
    let active = 0;
    const seen: (string | undefined)[] = [];
    for await (const i of ctx.db.query('installs')) {
      installs++;
      if (i.lastSeenAt >= weekAgo) active++;
      seen.push(i.version);
    }
    // In a Map, and anything stored before the rule as "other" (versions.ts).
    const versions = countVersions(seen);
    const days = (await ctx.db.query('days').withIndex('by_day').order('desc').take(14)).map(({ day, sends, failed, registrations, newInstalls, reasons }) => ({ day, sends, failed, registrations, ...(newInstalls !== undefined ? { newInstalls } : {}), ...(reasons ? { reasons } : {}) }));
    return { installs, activeLast7Days: active, versions, days };
  },
});

// Removes an install, for someone asking to be forgotten (or a test):
//   npx convex run relay:forget '{"installId":"i_..."}' --prod
export const forget = internalMutation({
  args: { installId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { installId }) => {
    const row = await ctx.db
      .query('installs')
      .withIndex('by_installId', (q) => q.eq('installId', installId))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return Boolean(row);
  },
});

// Daily (crons.ts): removes installs idle for IDLE_INSTALL_MS, whose keys
// then get 401 (a live backend registers again), and the hourly pools of
// days gone. A batch at a time, then again until none are left.
export const EXPIRE_BATCH = 200;
export const expire = internalMutation({
  args: {},
  returns: v.object({ installs: v.number(), hours: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const idle = await ctx.db
      .query('installs')
      .withIndex('by_lastSeenAt', (q) => q.lt('lastSeenAt', now - IDLE_INSTALL_MS))
      .take(EXPIRE_BATCH);
    for (const row of idle) await ctx.db.delete(row._id);
    const old = await ctx.db
      .query('hours')
      .withIndex('by_hour', (q) => q.lt('hour', hourOf(now - 2 * 86_400_000)))
      .take(EXPIRE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (idle.length === EXPIRE_BATCH || old.length === EXPIRE_BATCH) await ctx.scheduler.runAfter(0, internal.relay.expire, {});
    return { installs: idle.length, hours: old.length };
  },
});

// Wipes the test day's counts too, when there was nothing real in it.
export const resetDay = internalMutation({
  args: { day: v.string() },
  returns: v.null(),
  handler: async (ctx, { day }) => {
    const row = await ctx.db
      .query('days')
      .withIndex('by_day', (q) => q.eq('day', day))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
