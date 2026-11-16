---
id: coldCompact
name: Compact when cold
title: Compact when cold: a long Claude thread woken after its cache has expired compacts first, then runs the turn
added: 2026-11-16
on: false
reminder: e37ee78d
---

## What it does

A Claude thread keeps its conversation in the provider's prompt cache for about an hour after its last model call. Wake a long thread after that (your message the next morning, a schedule, a report from a thread it started) and the whole conversation is written to the cache again, which on a thread past 200k tokens made each such turn cost about three times a warm one. With this on, a Claude thread with 200k tokens or more of context that has been idle for over an hour and five minutes compacts first: Claude Code summarises the conversation, asked to keep what was decided, what you asked for that isn't done, what's still running or waited on, the files, branches and threads involved, and how you said you want the work done. Then your message runs on the summary, in the same turn. Compacting costs little more than the cold turn would have, as the whole conversation had to be read again anyway, and every call after it reads far less. It takes a minute or so before the turn starts. A quiet line in the thread says it happened and why. A thread that's still warm, a shorter one, a slash command and Codex threads are left alone, and nothing changes about the compaction Claude Code does by itself near a full window.

## Lives in

`runner/src/runner/cold-compact.ts` (the rule, the summary's instructions and the note); `compactFirst` called from `deliver`, `compactDone` from the `result` case and the note's rewording in the `event` case of `onOutput`, `Turn.precompact`, and its clearing in `onExited` (`runner/src/runner.ts`); `ThreadRecord.lastModelAt` (`store.ts`), set from the `context` output

## Taking it out

Delete `cold-compact.ts` and its test, its entry in the parts list and the `Runner` interface, `Turn.precompact` and the lines that use it in `runner.ts`, and `lastModelAt` with the line that sets it.
