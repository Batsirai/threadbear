// Virtual runners' boxes (docs/virtual-runners.md): the virtual runners
// themselves (runnerServices), starting a thread on one, the cloud tokens
// boxes run Claude Code on, a box's boot token, the exchange that trades it
// for the box's key and secrets, and the steps a box and the service
// report. A box's lifecycle is its state machine (boxMachine.ts); the
// service's actions that call the provider are in boxService.ts.
//
// Randomness and sealing happen in actions only: Convex seeds Math.random
// and crypto.getRandomValues inside queries and mutations so they replay
// the same, which is wrong for keys, tokens and IVs. Mutations only store
// hashes and sealed values, and change state atomically.
//
// Not built yet (docs/virtual-runners.md, "What's built"): a runner's box
// mode and its image, and starting or waking one from the phone.
import { ConvexError, v, type Infer } from 'convex/values';
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { box as boxMachine, command as commandMachine, machines, queued } from './machines';
import { BOOT_MS } from './boxStates';
import { checkRunnerId, forbidden, runnerAuth, sha256, withoutCredentials } from './lib';
import { commandArgs } from './relay';
import { PROVIDERS } from './boxProviders/types';
import { WAKES_FROM } from './boxHooks';
import { BOX_KEY_PREFIX, isThreadId, mayUseStorage } from './runnerAccess';
import { deleteIfUnused, endCommandFiles, finishedArgs, MAX_RUNNER_UPLOAD_BYTES, uploadedBy } from './sync';

// A virtual runner's limits when it's made (runnerServices.limits).
export const BOX_LIMITS = { maxBoxes: 5, idleSleepMinutes: 10, maxAwakeHoursPerDay: 8, deleteAfterDays: 14 } as const;

// A boot token (`tbt_`) and a box key (`tbb_`, runnerAccess.ts
// BOX_KEY_PREFIX): 32 random bytes in hex each.
export const BOOT_PREFIX = 'tbt_';
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

export function randomHex(bytes: number): string {
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
 * A thread's box row, with a fresh per-thread key sealed here (decision 7).
 * Returns the row's id. boxes:startThread does the same with the thread's
 * runners row and its create beside it, in one step (beginThread).
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
  handler: async (ctx, a): Promise<Id<'boxes'>> => addBox(ctx, a),
});

type NewBox = { serviceId: Id<'runnerServices'>; threadId: string; runnerId: string; login: string; repo: { origin: string; subfolder: string; baseBranch: string }; sealedThreadKey: string };

// The row, its machine started (START), and the service's create scheduled
// (boxService.ts createBox): the row has no id while its START runs, so
// the step can't schedule it itself.
async function addBox(ctx: MutationCtx, a: NewBox): Promise<Id<'boxes'>> {
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
  await ctx.scheduler.runAfter(0, internal.boxService.createBox, { boxId: made.id as Id<'boxes'> });
  return made.id as Id<'boxes'>;
}

// ------------------------------------------------------------ virtual runners (decision 2)

const SERVICE_NAME = /^[^\u0000-\u001f\u007f]{1,80}$/;
const IMAGE = /^[\x21-\x7e]{1,300}$/;
const REGION = /^[a-z0-9-]{1,20}$/;
// Each limit's whole-number range.
const LIMIT_RANGE = { maxBoxes: [1, 100], idleSleepMinutes: [1, 24 * 60], maxAwakeHoursPerDay: [1, 24], deleteAfterDays: [1, 365] } as const;
type Limits = { maxBoxes: number; idleSleepMinutes: number; maxAwakeHoursPerDay: number; deleteAfterDays: number };
const limitsArg = v.object({ maxBoxes: v.optional(v.number()), idleSleepMinutes: v.optional(v.number()), maxAwakeHoursPerDay: v.optional(v.number()), deleteAfterDays: v.optional(v.number()) });
const limitsV = v.object({ maxBoxes: v.number(), idleSleepMinutes: v.number(), maxAwakeHoursPerDay: v.number(), deleteAfterDays: v.number() });

// The states a box counts toward maxBoxes in: up, or on its way up.
type BoxKind = Doc<'boxes'>['boxState']['kind'];
export const RUNNING: readonly BoxKind[] = ['creating', 'starting', 'awake', 'saving', 'waking'];

// How many of a virtual runner's boxes are in these states, counting to `upTo` at most.
async function countBoxes(ctx: QueryCtx, serviceId: Id<'runnerServices'>, kinds: readonly BoxKind[], upTo: number): Promise<number> {
  let n = 0;
  for (const kind of kinds) {
    if (n >= upTo) break;
    n += (await ctx.db.query('boxes').withIndex('by_service_state', (q) => q.eq('serviceId', serviceId).eq('boxState.kind', kind)).take(upTo - n)).length;
  }
  return n;
}

/** Mike's virtual runners, each with how many boxes are up (or on the way) and asleep. */
export const runnerServices = query({
  args: { key: v.string() },
  returns: v.array(v.object({ serviceId: v.id('runnerServices'), name: v.string(), provider: v.string(), image: v.string(), box: v.object({ cpus: v.number(), memoryMb: v.number() }), region: v.optional(v.string()), limits: limitsV, createdAt: v.number(), running: v.number(), asleep: v.number() })),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'runnerServices');
    const out = [];
    for (const s of await ctx.db.query('runnerServices').take(100)) {
      out.push({ serviceId: s._id, name: s.name, provider: s.provider, image: s.image, box: s.box, ...(s.region !== undefined ? { region: s.region } : {}), limits: s.limits, createdAt: s.createdAt, running: await countBoxes(ctx, s._id, RUNNING, 1000), asleep: await countBoxes(ctx, s._id, ['asleep'], 1000) });
    }
    return out;
  },
});

/**
 * Makes a virtual runner, or changes one (`serviceId`): its name, image,
 * box size, region and limits (any left out: BOX_LIMITS, or as they were).
 * A provider is a virtual runner's for life: another one is a new runner.
 */
export const setRunnerService = mutation({
  args: { key: v.string(), serviceId: v.optional(v.id('runnerServices')), name: v.string(), provider: v.string(), image: v.string(), box: v.object({ cpus: v.number(), memoryMb: v.number() }), region: v.optional(v.string()), limits: v.optional(limitsArg) },
  returns: v.id('runnerServices'),
  handler: async (ctx, { key, serviceId, ...a }) => {
    await runnerAuth(ctx, key, 'setRunnerService');
    if (!SERVICE_NAME.test(a.name.trim())) throw bad('name must be 1 to 80 characters with no control characters');
    if (!PROVIDERS.includes(a.provider)) throw bad(`provider must be one of ${PROVIDERS.join(', ')}`);
    if (!IMAGE.test(a.image)) throw bad('image must be an image reference, up to 300 characters with no spaces');
    if (!Number.isSafeInteger(a.box.cpus) || a.box.cpus < 1 || a.box.cpus > 16) throw bad('box.cpus must be a whole number from 1 to 16');
    if (!Number.isSafeInteger(a.box.memoryMb) || a.box.memoryMb < 256 || a.box.memoryMb > 65536 || a.box.memoryMb % 256) throw bad('box.memoryMb must be a multiple of 256 from 256 to 65536');
    if (a.region !== undefined && !REGION.test(a.region)) throw bad('region must be a provider region code, like syd');
    const old = serviceId ? await ctx.db.get(serviceId) : null;
    if (serviceId && !old) throw new ConvexError({ kind: 'notFound', message: 'no such virtual runner' });
    if (old && old.provider !== a.provider) throw bad("A virtual runner's provider can't change: make a new one.");
    const limits: Limits = { ...(old?.limits ?? BOX_LIMITS) };
    for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGE) as [keyof Limits, readonly [number, number]][]) {
      const x = a.limits?.[k];
      if (x === undefined) continue;
      if (!Number.isSafeInteger(x) || x < lo || x > hi) throw bad(`limits.${k} must be a whole number from ${lo} to ${hi}`);
      limits[k] = x;
    }
    const fields = { name: a.name.trim(), provider: a.provider, image: a.image, box: { cpus: a.box.cpus, memoryMb: a.box.memoryMb }, limits };
    if (old) {
      // A region left out goes: the provider picks one.
      await ctx.db.patch(old._id, { ...fields, region: a.region });
      return old._id;
    }
    return await ctx.db.insert('runnerServices', { ...fields, ...(a.region !== undefined ? { region: a.region } : {}), createdAt: Date.now() });
  },
});

const startArgs = {
  serviceId: v.id('runnerServices'),
  threadId: v.string(),
  // Read on the Mac as moveInfo does, credentials taken out here too (decision 11).
  repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }),
  // The Claude login the box runs on: a cloudTokens row's.
  login: v.string(),
  // The thread's first message, and how it starts, as a `create` carries them.
  text: v.string(),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  permissionMode: v.optional(v.string()),
  plan: v.optional(v.boolean()),
};

/**
 * Starts a thread on a virtual runner (decision 6): its runner (a runners
 * row marked `box`, with a runner id of its own for life, decision 3), its
 * box row, and its `create` command, queued for that runner, in one step;
 * then the service makes its first box (boxService.ts createBox). Refused
 * at once past the virtual runner's maxBoxes, saying so.
 */
export const startThread = action({
  args: { key: v.string(), ...startArgs },
  returns: v.object({ runnerId: v.string(), commandId: v.id('commands') }),
  handler: async (ctx, { key, ...a }): Promise<{ runnerId: string; commandId: Id<'commands'> }> => {
    await actionAuth(ctx, key, 'startThread');
    const sealedThreadKey = await seal(await sealKey(), crypto.getRandomValues(new Uint8Array(32)), threadKeyPurpose(a.threadId));
    // Shaped as a runner's own (runner.json's sync.runnerId): 12 hex.
    const runnerId = randomHex(6);
    return await ctx.runMutation(internal.boxes.beginThread, { ...a, runnerId, sealedThreadKey });
  },
});

export const beginThread = internalMutation({
  args: { ...startArgs, runnerId: v.string(), sealedThreadKey: v.string() },
  returns: v.object({ runnerId: v.string(), commandId: v.id('commands') }),
  handler: async (ctx, a) => {
    const service = await ctx.db.get(a.serviceId);
    if (!service) throw new ConvexError({ kind: 'notFound', message: 'no such virtual runner' });
    // As relay.ts queueCommand checks a create's, before anything is written.
    const create = commandArgs('create', { text: a.text, model: a.model, effort: a.effort, permissionMode: a.permissionMode, plan: a.plan });
    const max = service.limits.maxBoxes;
    const running = await countBoxes(ctx, a.serviceId, RUNNING, max);
    if (running >= max) throw new ConvexError({ kind: 'limit', message: `${service.name} has ${running} boxes up or starting, its limit. One sleeps once its thread has been idle ${service.limits.idleSleepMinutes} minutes, or archive a thread on it.` });
    checkRunnerId(a.runnerId);
    // A new thread: one that's already somewhere moves to a virtual runner (Order, 5), it isn't started there.
    if (await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', a.threadId)).first()) throw conflict('That thread exists already.');
    if (await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', a.runnerId)).first()) throw conflict('That runner id is taken: start it again.');
    await ctx.db.insert('runners', { runnerId: a.runnerId, name: service.name, version: '', startedAt: '', draining: false, threadCount: 0, lastSeenAt: 0, box: { serviceId: a.serviceId } });
    await addBox(ctx, { serviceId: a.serviceId, threadId: a.threadId, runnerId: a.runnerId, login: a.login, repo: a.repo, sealedThreadKey: a.sealedThreadKey });
    // For its own thread (the box takes only that), from the main Mac.
    const commandId = await queued(ctx, { runnerId: a.runnerId, threadId: a.threadId, kind: 'create', args: { ...create, from: 'mac' }, createdAt: Date.now() });
    return { runnerId: a.runnerId, commandId };
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
 * A boot token for the thread's next box, for a box the main Mac starts
 * itself. The service's own create (boxService.ts claimAttempt) takes the
 * same step, newAttempt. Returned once; only its hash is kept, it lasts
 * BOOT_MS, and a newer one replaces it.
 */
export const mintBootToken = action({
  args: { key: v.string(), threadId: v.string() },
  // attempt: the box this token is for, which the service's CREATED and LOST name.
  returns: v.object({ bootToken: v.string(), expiresAt: v.number(), attempt: v.number() }),
  handler: async (ctx, { key, threadId }): Promise<{ bootToken: string; expiresAt: number; attempt: number }> => {
    await actionAuth(ctx, key, 'mintBootToken');
    const bootToken = BOOT_PREFIX + randomHex(32);
    const stored: { expiresAt: number; attempt: number } = await ctx.runMutation(internal.boxes.storeBootToken, { threadId, bootHash: await sha256(bootToken) });
    return { bootToken, ...stored };
  },
});

export const storeBootToken = internalMutation({
  args: { threadId: v.string(), bootHash: v.string() },
  returns: v.object({ expiresAt: v.number(), attempt: v.number() }),
  handler: async (ctx, { threadId, bootHash }) => {
    const row = await boxOf(ctx, threadId);
    if (!BOOTING.includes(row.boxState.kind)) throw conflict(`The box is ${row.boxState.kind}, so it isn't booting.`);
    return newAttempt(ctx, row, bootHash);
  },
});

/** A new attempt at a box, numbered after every one before, with its boot token's hash (BOOT_MS). */
export async function newAttempt(ctx: MutationCtx, row: Doc<'boxes'>, bootHash: string): Promise<{ expiresAt: number; attempt: number }> {
  const expiresAt = Date.now() + BOOT_MS;
  const attempt = (row.boxAttempt ?? 0) + 1;
  await ctx.db.patch(row._id, { bootTokenHash: bootHash, bootExpiresAt: expiresAt, bootAttempt: attempt, boxAttempt: attempt });
  return { expiresAt, attempt };
}

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
type Peeked = { login: string; threadId: string; sealedToken: string; sealedThreadKey: string };
type Claimed = { runnerId: string; threadId: string; repo: Exchanged['repo']; save: Exchanged['save'] };
const refusedBoot = () => new ConvexError({ kind: 'auth', message: 'boot token unknown, used or expired' });

/**
 * The box's first call, with the boot token the provider started it with
 * and no key: trades it, once and within BOOT_MS, for the box's key, the
 * login's token, the thread key, the repo and the last save. The new key
 * replaces any earlier box's in the same step, so only one box can ever act
 * as the thread's runner (decision 3).
 *
 * Unsealing comes first, from a read that uses nothing up (peekBoot): a
 * deployment whose BOX_SEAL_KEY changed, or a sealed value gone bad, fails
 * here and leaves the boot token and the box as they were. Only then does
 * claimBoot use the token up, in one step that checks it again.
 */
export const exchange = action({
  args: { bootToken: v.string() },
  returns: exchanged,
  handler: async (ctx, { bootToken }): Promise<Exchanged> => {
    if (!BOOT_TOKEN.test(bootToken)) throw refusedBoot();
    const key = await sealKey();
    const bootHash = await sha256(bootToken);
    const peeked: Peeked | null = await ctx.runQuery(internal.boxes.peekBoot, { bootHash });
    if (!peeked) throw refusedBoot();
    let claudeToken: string;
    let threadKey: string;
    try {
      claudeToken = new TextDecoder().decode(await unseal(key, peeked.sealedToken, tokenPurpose(peeked.login)));
      threadKey = b64(await unseal(key, peeked.sealedThreadKey, threadKeyPurpose(peeked.threadId)));
    } catch {
      throw new ConvexError({ kind: 'config', message: "The box's secrets can't be unsealed with this deployment's BOX_SEAL_KEY. The boot token still works once that's fixed." });
    }
    const boxKey = BOX_KEY_PREFIX + randomHex(32);
    const got: Claimed | null = await ctx.runMutation(internal.boxes.claimBoot, { bootHash, boxKeyHash: await sha256(boxKey), sealedToken: peeked.sealedToken, sealedThreadKey: peeked.sealedThreadKey });
    if (!got) throw refusedBoot();
    return { boxKey, runnerId: got.runnerId, threadId: got.threadId, claudeToken, threadKey, repo: got.repo, save: got.save };
  },
});

// The box a boot token is for, if the token is unused and unexpired: a
// minted token's hash is cleared once it's used (READY) or replaced.
async function bootBox(ctx: QueryCtx, bootHash: string): Promise<Doc<'boxes'> | null> {
  const row = await ctx.db.query('boxes').withIndex('by_boot_hash', (q) => q.eq('bootTokenHash', bootHash)).first();
  return row && (row.bootExpiresAt ?? 0) > Date.now() && BOOTING.includes(row.boxState.kind) ? row : null;
}

async function cloudToken(ctx: QueryCtx, login: string): Promise<Doc<'cloudTokens'>> {
  const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', login)).unique();
  if (!token) throw new ConvexError({ kind: 'noCloudToken', message: `There's no cloud token for ${login} yet: set one in Threadbear, then start the box again.` });
  return token;
}

/** What the exchange unseals, read without using the boot token up. A login with no cloud token refuses here. */
export const peekBoot = internalQuery({
  args: { bootHash: v.string() },
  returns: v.union(v.null(), v.object({ login: v.string(), threadId: v.string(), sealedToken: v.string(), sealedThreadKey: v.string() })),
  handler: async (ctx, { bootHash }) => {
    const row = await bootBox(ctx, bootHash);
    if (!row) return null;
    const token = await cloudToken(ctx, row.login);
    return { login: row.login, threadId: row.threadId, sealedToken: token.sealed, sealedThreadKey: row.sealedThreadKey };
  },
});

/**
 * One step: the boot token checked again (unused, unexpired), and the
 * sealed values the action unsealed still the ones there (a token set
 * again meanwhile means trying again), then used up, the box told it's up
 * (READY), and the new box key's hash put in place of the last one. Of two
 * exchanges racing with one token, exactly one gets here first.
 */
export const claimBoot = internalMutation({
  args: { bootHash: v.string(), boxKeyHash: v.string(), sealedToken: v.string(), sealedThreadKey: v.string() },
  returns: v.union(v.null(), v.object({ runnerId: v.string(), threadId: v.string(), repo: v.object({ origin: v.string(), subfolder: v.string(), baseBranch: v.string() }), save: v.union(v.null(), v.object({ url: v.string(), at: v.number(), bytes: v.number() })) })),
  handler: async (ctx, { bootHash, boxKeyHash, sealedToken, sealedThreadKey }) => {
    const row = await bootBox(ctx, bootHash);
    if (!row) return null;
    const token = await cloudToken(ctx, row.login);
    if (token.sealed !== sealedToken || row.sealedThreadKey !== sealedThreadKey) throw conflict("The login's cloud token changed while the box started: try again.");
    const r = await boxMachine.send(ctx, row._id, { type: 'READY' });
    if (r.status !== 'done') return null;
    await ctx.db.patch(row._id, { boxKeyHash });
    const url = row.save ? await ctx.storage.getUrl(row.save.storageId) : null;
    return {
      runnerId: row.runnerId,
      threadId: row.threadId,
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

/** Mike archived the thread: its box is deleted (boxService.ts destroyBox). */
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
  v.object({ type: v.literal('CREATED'), providerBoxId: v.string(), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('IDLE'), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('WAKE') }),
  v.object({ type: v.literal('RESUMED'), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('LOST'), attempt: v.optional(v.number()) }),
  v.object({ type: v.literal('DESTROYED') }),
  v.object({ type: v.literal('FAILED'), error: v.string(), attempt: v.optional(v.number()) }),
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


/**
 * A command was queued for a box's runner (boxHooks.ts wakeIfAsleep): WAKE,
 * once. A second, for a box already waking or awake, isn't taken.
 */
export const wakeFor = machines.internalMutation({
  args: { runnerId: v.string() },
  returns: v.boolean(),
  handler: async (machineCtx, { runnerId }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await ctx.db.query('boxes').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).first();
    if (!row || !WAKES_FROM.includes(row.boxState.kind)) return false;
    if (row.boxState.kind === 'expired') {
      await failWaiting(ctx, runnerId, EXPIRED_NOTE);
      return false;
    }
    // A saving box is up already; any other needs room under maxBoxes, or waits for it.
    if (row.boxState.kind !== 'saving' && !(await hasRoom(ctx, row.serviceId))) {
      if (row.wantsWakeAt === undefined) await ctx.db.patch(row._id, { wantsWakeAt: Date.now() });
      return false;
    }
    return (await boxMachine.send(machineCtx, row._id, { type: 'WAKE' })).status === 'done';
  },
});

// Whether a virtual runner has room for one more box up under its maxBoxes.
async function hasRoom(ctx: QueryCtx, serviceId: Id<'runnerServices'>): Promise<boolean> {
  const max = (await ctx.db.get(serviceId))?.limits.maxBoxes ?? BOX_LIMITS.maxBoxes;
  return (await countBoxes(ctx, serviceId, RUNNING, max)) < max;
}

/**
 * A box of this virtual runner stopped counting toward maxBoxes (it slept,
 * failed or was archived; boxMachine.ts freed): the ones waiting to wake
 * (wakeFor) wake, oldest first, while there's room. The idle cron runs it
 * too, so a slot freed some other way isn't missed.
 */
export const wakeWaiting = machines.internalMutation({
  args: { serviceId: v.id('runnerServices') },
  returns: v.number(),
  handler: async (machineCtx, { serviceId }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    let woken = 0;
    for (let i = 0; i < 20; i++) {
      const row = await ctx.db.query('boxes').withIndex('by_service_wants', (q) => q.eq('serviceId', serviceId).gt('wantsWakeAt', 0)).first();
      if (!row) break;
      if (!(await hasRoom(ctx, serviceId))) break;
      // wake clears wantsWakeAt; a row that's moved on is let go of.
      if ((await boxMachine.send(machineCtx, row._id, { type: 'WAKE' })).status === 'done') woken++;
      else await ctx.db.patch(row._id, { wantsWakeAt: undefined });
    }
    return woken;
  },
});

const EXPIRED_NOTE = "This thread's machine and its last save have been deleted since it was archived, so it can't come back.";

// The commands waiting for a box's runner that will never run, failed with why.
async function failWaiting(ctx: MutationCtx, runnerId: string, note: string): Promise<void> {
  for (const c of await ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', runnerId).eq('state', 'pending')).take(50)) {
    await commandMachine.send(ctx, c._id, { type: 'THREAD_ELSEWHERE' });
    await ctx.db.patch(c._id, { args: finishedArgs(c.args), note });
    await endCommandFiles(ctx, c._id);
  }
}

/** The thread was archived or deleted a while ago (boxHooks.ts archiveSoon): its box goes, unless it's back out. */
export const archiveIfStill = internalMutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, { threadId }) => {
    const t = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (t && t.view !== 'den') return null;
    const row = await ctx.db.query('boxes').withIndex('by_threadId', (q) => q.eq('threadId', threadId)).unique();
    if (!row || ['destroying', 'gone', 'expired'].includes(row.boxState.kind)) return null;
    await boxMachine.send(ctx, row._id, { type: 'ARCHIVE' });
    return null;
  },
});
