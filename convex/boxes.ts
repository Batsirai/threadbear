// Virtual runners' boxes (docs/virtual-runners.md): the cloud tokens boxes
// run Claude Code on, a box's boot token, the exchange that trades it for
// the box's key and secrets, and the steps a box and the service report.
// A box's lifecycle is its state machine (boxMachine.ts).
//
// Randomness and sealing happen in actions only: Convex seeds Math.random
// and crypto.getRandomValues inside queries and mutations so they replay
// the same, which is wrong for keys, tokens and IVs. Mutations only store
// hashes and sealed values, and change state atomically.
//
// Not built yet (docs/virtual-runners.md, "This slice"): calling a
// provider, boxes:startThread, the wake hook in machines.ts queued(), the
// crons, a runner's box mode and its image.
import { ConvexError, v, type Infer } from 'convex/values';
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { box as boxMachine, machines } from './machines';
import { BOOT_MS } from './boxStates';
import { checkRunnerId, forbidden, runnerAuth, sha256, withoutCredentials } from './lib';
import { BOX_KEY_PREFIX, isThreadId, mayUseStorage } from './runnerAccess';
import { deleteIfUnused, MAX_RUNNER_UPLOAD_BYTES, uploadedBy } from './sync';

// A virtual runner's limits when it's made (runnerServices.limits).
export const BOX_LIMITS = { maxBoxes: 5, idleSleepMinutes: 10, maxAwakeHoursPerDay: 8, deleteAfterDays: 14 } as const;

// A boot token (`tbt_`) and a box key (`tbb_`, runnerAccess.ts
// BOX_KEY_PREFIX): 32 random bytes in hex each.
const BOOT_PREFIX = 'tbt_';
const BOOT_TOKEN = /^tbt_[0-9a-f]{64}$/;
// A login as boxes and cloudTokens name it, and a setup token as Claude
// Code prints it: printable, no spaces, of a sane length.
const LOGIN = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
const TOKEN = /^[\x21-\x7e]{16,1000}$/;
const REPO_CHARS = 2048;

const bad = (message: string) => new ConvexError({ kind: 'badArgs', message });
const conflict = (message: string) => new ConvexError({ kind: 'conflict', message });

// ------------------------------------------------------------ sealing (actions only)

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// BOX_SEAL_KEY: 32 random bytes in base64, set once per deployment
// (`npx convex env set BOX_SEAL_KEY "$(openssl rand -base64 32)"`).
// Changing it makes every sealed token and thread key unreadable.
async function sealKey(): Promise<CryptoKey> {
  const raw = process.env.BOX_SEAL_KEY;
  let bytes: Uint8Array | undefined;
  try {
    bytes = raw ? unb64(raw.trim()) : undefined;
  } catch {
    bytes = undefined;
  }
  if (!bytes || bytes.length !== 32) throw new ConvexError({ kind: 'config', message: 'BOX_SEAL_KEY must be set on this deployment to 32 random bytes in base64' });
  return crypto.subtle.importKey('raw', bytes as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// AES-GCM with a fresh 12-byte IV, as base64(iv || ciphertext). `purpose`
// is bound in as associated data, so one sealed value can't be passed off
// as another (a thread key handed back as a login's token, or one login's
// token as another's).
async function seal(key: CryptoKey, plain: Uint8Array, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) }, key, plain as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

async function unseal(key: CryptoKey, sealed: string, purpose: string): Promise<Uint8Array> {
  const b = unb64(sealed);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12), additionalData: new TextEncoder().encode(purpose) }, key, b.slice(12)));
}

const tokenPurpose = (login: string) => `cloudToken:${login}`;
const threadKeyPurpose = (threadId: string) => `threadKey:${threadId}`;

// An action's own gate: actions have no database, so runnerAuth runs in a
// query, under the action's own name (runnerAccess.ts ACCESS).
async function actionAuth(ctx: ActionCtx, key: string, fn: string): Promise<void> {
  await ctx.runQuery(internal.boxes.authorize, { key, fn });
}

export const authorize = internalQuery({
  args: { key: v.string(), fn: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, fn }) => {
    await runnerAuth(ctx, key, fn);
    return null;
  },
});

// ------------------------------------------------------------ cloud tokens (decision 10)

/** Sets a login's cloud token: sealed here, never stored or returned in the clear. */
export const setCloudToken = action({
  // madeAt: when `claude setup-token` made it (it lasts a year); now if not said.
  args: { key: v.string(), login: v.string(), token: v.string(), madeAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { key, login, token, madeAt }) => {
    await actionAuth(ctx, key, 'setCloudToken');
    if (!LOGIN.test(login)) throw bad('login must be 1 to 200 characters with no spaces or control characters');
    if (!TOKEN.test(token)) throw bad("that doesn't look like a token from claude setup-token");
    if (madeAt !== undefined && (!Number.isSafeInteger(madeAt) || madeAt < 0 || madeAt > Date.now() + 60_000)) throw bad('madeAt must be a time no later than now');
    const sealed = await seal(await sealKey(), new TextEncoder().encode(token), tokenPurpose(login));
    await ctx.runMutation(internal.boxes.storeCloudToken, { login, sealed, madeAt: madeAt ?? Date.now() });
    return null;
  },
});

export const storeCloudToken = internalMutation({
  args: { login: v.string(), sealed: v.string(), madeAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { login, sealed, madeAt }) => {
    const now = Date.now();
    const row = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', login)).unique();
    if (row) await ctx.db.patch(row._id, { sealed, madeAt, setAt: now });
    else await ctx.db.insert('cloudTokens', { login, sealed, madeAt, setAt: now });
    return null;
  },
});

/** Which logins have a cloud token, and when each was made and set. Never the token. */
export const cloudTokens = query({
  args: { key: v.string() },
  returns: v.array(v.object({ login: v.string(), madeAt: v.number(), setAt: v.number() })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'cloudTokens');
    const rows = await ctx.db.query('cloudTokens').withIndex('by_login').collect();
    return rows.map((r) => ({ login: r.login, madeAt: r.madeAt, setAt: r.setAt }));
  },
});

// ------------------------------------------------------------ a thread's box row

/**
 * A thread's box row, with a fresh per-thread key sealed here (decision 7):
 * for boxes:startThread, which writes the runners row and queues the
 * create beside it (not built yet). Returns the row's id.
 */
export const newBox = internalAction({
  args: { serviceId: v.id('runnerServices'), threadId: v.string(), runnerId: v.string(), login: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }) },
  returns: v.id('boxes'),
  handler: async (ctx, args): Promise<Id<'boxes'>> => {
    const sealedThreadKey = await seal(await sealKey(), crypto.getRandomValues(new Uint8Array(32)), threadKeyPurpose(args.threadId));
    return await ctx.runMutation(internal.boxes.insertBox, { ...args, sealedThreadKey });
  },
});

export const insertBox = internalMutation({
  args: { serviceId: v.id('runnerServices'), threadId: v.string(), runnerId: v.string(), login: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }), sealedThreadKey: v.string() },
  returns: v.id('boxes'),
  handler: async (ctx, a): Promise<Id<'boxes'>> => {
    checkRunnerId(a.runnerId);
    if (!isThreadId(a.threadId)) throw bad("that isn't a thread id");
    if (!LOGIN.test(a.login)) throw bad('login must be 1 to 200 characters with no spaces or control characters');
    for (const f of ['origin', 'subfolder', 'baseBranch'] as const) if (a.repo[f].length > REPO_CHARS || /[\u0000-\u001f]/.test(a.repo[f])) throw bad(`repo.${f} is too long or has control characters`);
    const service = await ctx.db.get(a.serviceId);
    if (!service) throw new ConvexError({ kind: 'notFound', message: 'no such virtual runner' });
    if (await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', a.threadId)).first()) throw conflict('That thread has a box already.');
    // A box's runner id is its own, for life (decision 3): never a machine's
    // or another box's, so nothing it writes lands on another runner.
    if (await ctx.db.query('boxes').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).first()) throw conflict("That runner id is another box's.");
    if (await ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).first()) throw conflict('That runner id has a runner key.');
    const existing = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).unique();
    if (existing && !existing.box) throw conflict("That runner id is a machine's.");
    const made = await boxMachine.create(
      ctx,
      { serviceId: a.serviceId, threadId: a.threadId, runnerId: a.runnerId, provider: service.provider, login: a.login, repo: { ...a.repo, origin: withoutCredentials(a.repo.origin) }, sealedThreadKey: a.sealedThreadKey, createdAt: Date.now() } as never,
      { type: 'START' },
    );
    if (made.status !== 'done') throw conflict(`The box couldn't be made: ${made.reasons.join(' ')}`);
    return made.id as Id<'boxes'>;
  },
});

// ------------------------------------------------------------ boot tokens (decision 5)

async function boxOf(ctx: MutationCtx, threadId: string): Promise<Doc<'boxes'>> {
  const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
  if (!row) throw new ConvexError({ kind: 'notFound', message: 'no box for that thread' });
  return row;
}

// The states a box can be booting in, and so take a boot token.
const BOOTING: readonly string[] = ['creating', 'starting', 'waking'];

/**
 * A boot token for the thread's next box: the main Mac's, or (with the same
 * steps, once it's built) the service's own create. Returned once; only its
 * hash is kept, it lasts BOOT_MS, and a newer one replaces it.
 */
export const mintBootToken = action({
  args: { key: v.string(), threadId: v.string() },
  returns: v.object({ bootToken: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { key, threadId }): Promise<{ bootToken: string; expiresAt: number }> => {
    await actionAuth(ctx, key, 'mintBootToken');
    const bootToken = BOOT_PREFIX + randomHex(32);
    const expiresAt: number = await ctx.runMutation(internal.boxes.storeBootToken, { threadId, bootHash: await sha256(bootToken) });
    return { bootToken, expiresAt };
  },
});

export const storeBootToken = internalMutation({
  args: { threadId: v.string(), bootHash: v.string() },
  returns: v.number(),
  handler: async (ctx, { threadId, bootHash }) => {
    const row = await boxOf(ctx, threadId);
    if (!BOOTING.includes(row.boxState.kind)) throw conflict(`The box is ${row.boxState.kind}, so it isn't booting.`);
    const expiresAt = Date.now() + BOOT_MS;
    await ctx.db.patch(row._id, { bootTokenHash: bootHash, bootExpiresAt: expiresAt });
    return expiresAt;
  },
});

const exchanged = v.object({
  boxKey: v.string(),
  runnerId: v.string(),
  threadId: v.string(),
  claudeToken: v.string(),
  // The per-thread key, base64: the box seals its saves with it (decision 7).
  threadKey: v.string(),
  repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }),
  // The last save, to restore from; null for a thread's first box.
  save: v.union(v.null(), v.object({ url: v.string(), at: v.number(), bytes: v.number() })),
});

type Exchanged = Infer<typeof exchanged>;
type Claimed = { runnerId: string; threadId: string; login: string; sealedToken: string; sealedThreadKey: string; repo: Exchanged['repo']; save: Exchanged['save'] };

/**
 * The box's first call, with the boot token the provider started it with
 * and no key: trades it, once and within BOOT_MS, for the box's key, the
 * login's token, the thread key, the repo and the last save. The new key
 * replaces any earlier box's in the same step, so only one box can ever act
 * as the thread's runner (decision 3).
 */
export const exchange = action({
  args: { bootToken: v.string() },
  returns: exchanged,
  handler: async (ctx, { bootToken }): Promise<Exchanged> => {
    if (!BOOT_TOKEN.test(bootToken)) throw new ConvexError({ kind: 'auth', message: 'boot token unknown, used or expired' });
    // Before anything is used up: a deployment that can't unseal says so
    // while the boot token still works.
    const key = await sealKey();
    const boxKey = BOX_KEY_PREFIX + randomHex(32);
    const got: Claimed | null = await ctx.runMutation(internal.boxes.claimBoot, { bootHash: await sha256(bootToken), boxKeyHash: await sha256(boxKey) });
    if (!got) throw new ConvexError({ kind: 'auth', message: 'boot token unknown, used or expired' });
    return {
      boxKey,
      runnerId: got.runnerId,
      threadId: got.threadId,
      claudeToken: new TextDecoder().decode(await unseal(key, got.sealedToken, tokenPurpose(got.login))),
      threadKey: b64(await unseal(key, got.sealedThreadKey, threadKeyPurpose(got.threadId))),
      repo: got.repo,
      save: got.save,
    };
  },
});

/**
 * One step: the boot token checked unexpired and used up, the box told it's
 * up (READY), and the new box key's hash put in place of the last one. A
 * login with no cloud token refuses before anything changes, so the box
 * can try again once Mike has set one.
 */
export const claimBoot = internalMutation({
  args: { bootHash: v.string(), boxKeyHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({ runnerId: v.string(), threadId: v.string(), login: v.string(), sealedToken: v.string(), sealedThreadKey: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }), save: v.union(v.null(), v.object({ url: v.string(), at: v.number(), bytes: v.number() })) }),
  ),
  handler: async (ctx, { bootHash, boxKeyHash }) => {
    const row = await ctx.db.query('boxes').withIndex('by_boot_hash', (q) => q.eq('bootTokenHash', bootHash)).first();
    if (!row || (row.bootExpiresAt ?? 0) <= Date.now()) return null;
    const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', row.login)).unique();
    if (!token) throw new ConvexError({ kind: 'noCloudToken', message: `There's no cloud token for ${row.login} yet: set one in Threadbear, then start the box again.` });
    const r = await boxMachine.send(ctx, row._id, { type: 'READY' });
    if (r.status !== 'done') {
      // Its state takes no box now (archived meanwhile): the token goes.
      await ctx.db.patch(row._id, { bootTokenHash: undefined, bootExpiresAt: undefined });
      return null;
    }
    await ctx.db.patch(row._id, { boxKeyHash });
    const url = row.save ? await ctx.storage.getUrl(row.save.storageId) : null;
    return {
      runnerId: row.runnerId,
      threadId: row.threadId,
      login: row.login,
      sealedToken: token.sealed,
      sealedThreadKey: row.sealedThreadKey,
      repo: row.repo,
      save: row.save && url ? { url, at: row.save.at, bytes: row.save.bytes } : null,
    };
  },
});

// ------------------------------------------------------------ what a box and the service report

/**
 * The box has saved its thread (decision 7): a file its runner uploaded
 * (sync:iconUploadUrl, on its box key), sealed with the thread key. It
 * replaces the last save, which is deleted.
 */
export const boxSaved = mutation({
  args: { key: v.string(), storageId: v.id('_storage'), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, { key, storageId, bytes }) => {
    const caller = await runnerAuth(ctx, key, 'boxSaved');
    if (caller.owner || !caller.box) throw forbidden("save a box's thread: only the box's own key can");
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RUNNER_UPLOAD_BYTES) throw bad(`bytes must be a whole number from 1 to ${MAX_RUNNER_UPLOAD_BYTES}`);
    const row = (await ctx.db.get(caller.box.id as Id<'boxes'>))!;
    if (row.save?.storageId === storageId) return null;
    const owner = await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).first();
    // Its own upload, and nothing yet: a file already on a picture isn't a save.
    if (!mayUseStorage(caller, await uploadedBy(ctx, storageId)) || !owner || owner.attachedAt) throw forbidden("use a stored file its runner didn't upload");
    const old = row.save;
    const r = await boxMachine.send(ctx, row._id, { type: 'SAVED', storageId, bytes });
    if (r.status !== 'done') throw conflict(`The box is ${row.boxState.kind}, so it can't save now.`);
    await ctx.db.patch(owner._id, { attachedAt: Date.now() });
    if (old) await deleteIfUnused(ctx, old.storageId);
    return null;
  },
});

/** Mike archived the thread: its box is deleted (the provider's delete comes with the service's actions). */
export const archiveBox = mutation({
  args: { key: v.string(), threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, threadId }) => {
    await runnerAuth(ctx, key, 'archiveBox');
    const row = await boxOf(ctx, threadId);
    if (row.boxState.kind === 'destroying' || row.boxState.kind === 'gone') return null;
    const r = await boxMachine.send(ctx, row._id, { type: 'ARCHIVE' });
    if (r.status !== 'done') throw conflict(`The box is ${row.boxState.kind}, so it can't be archived.`);
    return null;
  },
});

const serverEvent = v.union(
  v.object({ type: v.literal('CREATED'), providerBoxId: v.string() }),
  v.object({ type: v.literal('IDLE') }),
  v.object({ type: v.literal('WAKE') }),
  v.object({ type: v.literal('RESUMED') }),
  v.object({ type: v.literal('LOST') }),
  v.object({ type: v.literal('DESTROYED') }),
  v.object({ type: v.literal('FAILED'), error: v.string() }),
);

/**
 * What the service's own actions and crons saw (the provider made, resumed,
 * lost or deleted a box; a thread is idle; a message wants it awake). The
 * machine says whether the box's state takes it: `false` if not, which a
 * caller that can race (a second wake) takes as already done.
 */
export const report = machines.internalMutation({
  args: { threadId: v.string(), event: serverEvent },
  returns: v.boolean(),
  handler: async (ctx, { threadId, event }) => {
    const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!row) throw new ConvexError({ kind: 'notFound', message: 'no box for that thread' });
    return (await boxMachine.send(ctx, row._id, event)).status === 'done';
  },
});
