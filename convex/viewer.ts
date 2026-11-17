// The state machines viewer's queries, for the website's Machines page
// (web/src/machines.tsx): every machine drawn from its rules, live counts in
// each state, and any row's state and history. Only for whoever holds one of
// this deployment's phone or browser tokens, which only its owner can issue:
// the website passes the token with every query, as its other pages do, and
// anyone else gets null.
import { viewerArgs } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import { checkPhoneToken } from './lib';
import { machines } from './machines';

const viewer = machines.viewer({ read: async () => true });

async function signedIn(ctx: QueryCtx, token: string): Promise<boolean> {
  try {
    await checkPhoneToken(ctx, token);
    return true;
  } catch {
    return false;
  }
}

export const overview = query({
  args: { ...viewerArgs.overview, token: v.string() },
  handler: async (ctx, { token }) => ((await signedIn(ctx, token)) ? await viewer.overview(ctx) : null),
});
export const counts = query({
  args: { ...viewerArgs.counts, token: v.string() },
  handler: async (ctx, { token, ...args }) => ((await signedIn(ctx, token)) ? await viewer.counts(ctx, args) : null),
});
export const rows = query({
  args: { ...viewerArgs.rows, token: v.string() },
  handler: async (ctx, { token, ...args }) => ((await signedIn(ctx, token)) ? await viewer.rows(ctx, args) : null),
});
export const row = query({
  args: { ...viewerArgs.row, token: v.string() },
  handler: async (ctx, { token, ...args }) => ((await signedIn(ctx, token)) ? await viewer.row(ctx, args) : null),
});
