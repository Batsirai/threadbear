// The spike's throwaway backend: just enough to tell whether a box's
// process keeps its Convex connection through a pause, and whether a
// command queued while it slept is taken exactly once. Not the real
// `boxes` table from docs/virtual-runners.md, though the names match.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const boxState = v.union(
  v.literal("creating"),
  v.literal("starting"),
  v.literal("running"),
  v.literal("pausing"),
  v.literal("paused"),
  v.literal("resuming"),
  v.literal("destroyed"),
);

export const commandState = v.union(
  v.literal("pending"),
  v.literal("taken"),
  v.literal("done"),
);

export default defineSchema({
  boxes: defineTable({
    name: v.string(),
    provider: v.string(),
    providerBoxId: v.optional(v.string()),
    idempotencyKey: v.string(),
    state: boxState,
    lastHeartbeatAt: v.optional(v.number()),
    // Time of the very first heartbeat from any process in this box.
    bootedAt: v.optional(v.number()),
    heartbeats: v.number(),
  }).index("by_name", ["name"]),

  commands: defineTable({
    boxName: v.string(),
    text: v.string(),
    state: commandState,
    takenBy: v.optional(v.string()),
    createdAt: v.number(),
    takenAt: v.optional(v.number()),
    doneAt: v.optional(v.number()),
    // Every call to take, won or not. More than one means the agent (or a
    // second agent) tried again, which is what "exactly once" is about.
    attempts: v.number(),
    // Takes that won (pending -> taken). Can only ever be 0 or 1; kept as a
    // count so the driver checks the number rather than trusting the code.
    takes: v.number(),
    // Every call to finish, including ones that didn't change anything.
    finishes: v.number(),
  }).index("by_box_state", ["boxName", "state"]),

  // One row per heartbeat, so the driver can see which process sent it
  // (pid + startedAt) and whether its websocket had reconnected.
  beats: defineTable({
    box: v.string(),
    pid: v.number(),
    startedAt: v.number(),
    connectionCount: v.number(),
    at: v.number(),
  }).index("by_box_at", ["box", "at"]),
});
