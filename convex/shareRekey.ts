// Every shared picture's file copied to a new one and the old one deleted,
// once (Daybreak 135, 16 Nov 2026). Until 15 Nov a shared page handed its
// viewers each picture's own storage URL, which kept working after sharing
// stopped, until the runner's dropShareImages deleted the file. Since then
// anyone but Mike gets /share/image/<slug>/<id>, which checks the share at
// every request (share.ts shareImageFile), so no storage URL of a shared
// picture reaches anyone else; this ends the ones handed out before, as a
// storage URL names its file. Started by the first heartbeat after the
// deploy (sync.ts), a page at a time. A picture's row goes on naming the
// new file, with its runner key's upload record (storageOwners) moved
// across, so nothing else changes: its page, its count, its cleanup.
//
// A file the old row shared with another row (only the owner key can
// attach one file twice, sync.ts mustBeUnnamed) stays for that row, so a
// storage URL of it lives on as long as that row: only Mike's own phone and
// page are ever given those.
import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { storageInUse } from './sync';

const PAGE = 25;

export const rekeyPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(v.object({ id: v.id('shareImages'), storageId: v.id('_storage') })), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('shareImages').paginate({ numItems: PAGE, cursor });
    return { rows: page.page.map((r) => ({ id: r._id, storageId: r.storageId })), next: page.isDone ? null : page.continueCursor };
  },
});

// The row onto its new file, and the old file deleted unless something
// else names it. False (and the new file deleted): the row has gone or
// names another file now, so there's nothing to swap.
export const rekeySwap = internalMutation({
  args: { id: v.id('shareImages'), old: v.id('_storage'), fresh: v.id('_storage') },
  returns: v.boolean(),
  handler: async (ctx, { id, old, fresh }) => {
    const row = await ctx.db.get(id);
    if (!row || row.storageId !== old) {
      await ctx.storage.delete(fresh);
      return false;
    }
    await ctx.db.patch(id, { storageId: fresh });
    for (const o of await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', old)).collect()) await ctx.db.patch(o._id, { storageId: fresh });
    if (!(await storageInUse(ctx, old)) && (await ctx.db.system.get(old))) await ctx.storage.delete(old);
    return true;
  },
});

export const rekeyShareImages = internalAction({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.runQuery(internal.shareRekey.rekeyPage, { cursor });
    for (const r of page.rows) {
      const blob = await ctx.storage.get(r.storageId);
      if (!blob) continue;
      const fresh = await ctx.storage.store(blob);
      try {
        await ctx.runMutation(internal.shareRekey.rekeySwap, { id: r.id, old: r.storageId, fresh });
      } catch (e) {
        // That one stays as it was; the rest go on.
        await ctx.storage.delete(fresh);
        console.error('share picture not rekeyed', (e as Error)?.name);
      }
    }
    if (page.next) await ctx.scheduler.runAfter(0, internal.shareRekey.rekeyShareImages, { cursor: page.next });
    return null;
  },
});
